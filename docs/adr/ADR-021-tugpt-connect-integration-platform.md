# ADR-021: TuGPT Connect — Integration Platform

## Status

**Accepted** (2026-11-25, paul — architecture acceptance + implementation GO).
Originally **Proposed** (2026-11-12). Authorized for Phase 0 engineering on
`feat/connect-phase0`. It builds on ADR-015 (D2, D3, D5, D8), ADR-020 and its
Amendment 1, and the unified platform audit (`docs/platform/unified-platform-audit.md`).
No production data, credentials, migrations, or deployments change under this
ADR without separate approval.

## Context

Integrations must be usable from conversations, agents, and workflows. They
must not be a directory of login buttons. The same machinery has to serve
Microsoft 365, Google Workspace, Slack, CRM/ERP, custom APIs, customer MCP
servers, and WhatsApp.

Today the repository has a single integration: Google Calendar free/busy. It is
hard-wired to a single vault row, `organization_secrets(org, 'google', 'calendar_oauth')`.
The unique key `(org, provider, secret_name)` allows **one account per provider
per organization and no personal (per-user) connections**. Its refresh
write-back is best-effort and unlocked (`apps/worker/src/appointments-deps-factory.ts`),
so a rotated refresh token can be lost. There is no tool registry, no agent
loop, no MCP client, and no integration audit trail.

## Decision

### D1. Five components, one boundary each

```
 conversation / agent / workflow
            │  (tool call, typed)
            ▼
 ┌──────────────────────┐   grants, trust, caps (ADR-020 D4 ladder, in RPC)
 │  Tool runtime        │──────────────────────────────────────────────┐
 └─────────┬────────────┘                                              │
           │ capability call (connection_id, args)                     │
           ▼                                                           │
 ┌──────────────────────┐  scoped client   ┌────────────────────────┐  │
 │  Connector adapters  │◄─────────────────│  Credential broker     │  │
 │  (capability-shaped) │                  │  (internal service;    │  │
 └─────────┬────────────┘                  │  holds the key ring)   │  │
           │ HTTPS via egress proxy        └───────────▲────────────┘  │
           ▼                                           │ ciphertext    │
   vendor APIs / customer MCP / OpenAPI       Postgres: connection registry + vault
```

1. **Connection registry** (Postgres, RLS): providers, capabilities, connected
   accounts, grants, pending authorizations, health, webhooks, sync cursors.
2. **OAuth broker** (web app routes, no key material): PKCE + state +
   single-use nonce; callback hands the code to the credential broker.
3. **Credential broker** (internal service, not in the web app; see
   `docs/connect/key-management-evaluation.md`): the only process that holds the
   key ring. It encrypts on store, refreshes under a lock, and hands
   short-lived access tokens to callers that are authorized for that
   connection. It never returns refresh tokens.
4. **Tool registry + runtime** (ADR-020 + Amendment 1): platform tools and
   approved external snapshots; the D4 ladder runs inside the `executing` RPC.
5. **Connector adapters**: capability-shaped (`calendar.find_availability`, not
   `google.freebusy`), so every capability has at least two possible providers
   (ADR-015 D2).

### D2. Connections are org-owned or user-owned, never ambiguous

`connected_accounts` has `owner_type IN ('organization','user')`:

- **Organization connections** (e.g. a shared support inbox, WhatsApp
  number, CRM service account). Created by owner/admin. Usable only by
  agents and workflows granted them.
- **User connections** (e.g. "my calendar", "my OneDrive"). Created by the user
  for themselves. Usable only in that user's own conversations, or by an agent
  when that user is the actor *and* the agent has a grant. Admins can revoke
  them but cannot use them.

There can be many accounts per provider per organization. The external account
identity (`external_account_id`, e.g. Google `sub`) is unique per
`(organization, provider, owner)`.

### D3. Connection states (audit §3)

`connected | disconnected | expired | requires_authorization | error`. These
five are the only states shown in the UI and returned to the model. A tool call
against a non-`connected` account fails with a typed, user-actionable error
("Reconnect Google Calendar") and never with a vendor message.

### D4. The secure `@` flow

1. The user types `@Google Calendar` (or the model proposes a tool).
2. The runtime resolves *only* connections the user may use in this context (D2)
   and tools the agent is granted (ADR-020 D4).
3. If none exists, the chat shows an inline **Connect** card (`requires_authorization`).
   OAuth opens in a popup; on return, the original message resumes.
4. Read tools run per trust state. Write tools show an approval card with the
   exact action ("Create event 'Demo' on Tue 10:00 in calendar X") before
   execution.

### D5. Redirect URIs (owner decision 2026-11-12)

`tugpt.pro` is canonical; vendor callbacks live on `dashboard.tugpt.pro`.
`tugpt.app` must not be used for new registrations. See
`docs/connect/redirect-uris.md`. No apps are registered and no DNS changes until
the owner approves.

### D6. Egress and SSRF

All connector, MCP, and OpenAPI traffic goes through one egress client:

- HTTPS on port 443 only.
- Resolved IPs are checked against private, loopback, link-local, CGNAT, and
  metadata ranges **after** DNS resolution, on every request.
- No redirects to a different host.
- Response size and time limits.
- A per-organization allowlist for customer endpoints (`mcp_endpoint_allowlist`).

The infrastructure admin MCP bridge is unreachable from this path
(ADR-020 A1.3).

### D7. WhatsApp reuses Connect

WhatsApp Business (Cloud API) becomes an **organization connection** with
`provider = 'meta_whatsapp'`. Embedded Signup uses the OAuth broker. The
system-user token is stored by the credential broker, and inbound webhooks land
in the shared `integration_inbound_events` table (the WhatsApp-specific
`webhook_events` table stays for back-compat until migrated). Sending is the
`messaging.send` capability behind the ADR-020 ladder plus its existing in-code
kill switch. No WhatsApp-specific OAuth, vault, or MCP code is permitted.

### D8. Model tool-calling is an adapter, not a provider rewrite

Tool calling gets its own typed interface beside `AIProviderAdapter`
(ADR-020): `ToolCallingModelAdapter.complete({messages, tools, toolChoice})`
returns `{text | toolCalls[]}` normalized across OpenAI-style, Anthropic-style,
and Gemini-style wire formats. Models without native tool calling are **not
used for agent runs**: no prompt-parsed fallback for side-effecting tools.
Evidence and recommendations: `docs/connect/model-tool-calling.md`.

## Consequences

- One credential path for every integration. The Google slice migrates onto it
  first, in staging; production migration is separately approved
  (`docs/connect/google-credential-migration.md`).
- The web app stops holding the key ring once the broker ships. That closes
  the current contradiction between `docs/credential-handover.md` ("web reads
  no vault secrets") and the Google routes that encrypt in the web process.
- More moving parts: one internal service. It is mitigated by running it in the
  existing Docker stack at no extra cost.

## Risks

| Risk | Mitigation |
|---|---|
| Broker outage blocks every integration | Health-checked, restart policy; access tokens cached in-process for their lifetime (never persisted unencrypted); typed `error` state. |
| Refresh-token loss on concurrent refresh | Advisory lock per connection plus compare-and-swap on `credential_version`; persistence is mandatory, and a failed write fails the call. |
| Prompt injection via tool results | ADR-020 A1.4; results delimited, never instructions. |
| Vendor review delays (Google, Microsoft) | Read-only scopes first; verification applications started early by the owner. |

## Not decided here

- The Microsoft Graph and Slack scope sets (per connector ADR).
- Hosted vs. self-managed egress proxy (start with an in-process guard;
  revisit at scale).

---

## Amendments — 2026-11-25 (R1–R8, accepted by paul)

### R1 — Endpoint authentication is a first-class part of registration (closes the auth hole)
Investigation finding: registration accepted only `{url, displayName}`; `auth_connection_id` was never set by any route, RPC, or repo method; discovery sent no credential; execution SQL required `auth_connection_id IS NULL`. **Decision:** an MCP endpoint registration may (and for authenticated servers must) attach a credential at registration time, of one of the kinds in R2. Discovery and execution resolve that credential through the broker on every call. The `auth_connection_id IS NULL` execution exclusion is removed and replaced by a credentialed resolution path that re-checks connection state (`connected` only, per D3) on every invocation. The snapshot route's outstanding `TODO(connect)` is closed by this decision.

### R2 — Two authentication kinds in the first release (paul, decision D2)
1. **Static credential** — API key or bearer token, entered by the customer at registration, stored only in the credential broker. This requires a new broker store operation beside `storeOAuthResult`, under identical encryption, audit, and custody rules. The customer chooses the header placement the server expects (`Authorization: Bearer`, or a named custom header); TuGPT never guesses.
2. **OAuth 2.0** — authorization-code + PKCE against the MCP server's authorization server (including the MCP `resource` parameter), generalising the existing Google/Microsoft consent pattern (HMAC-signed single-use state, 15-minute pending authorisations) into a **reusable MCP-endpoint OAuth flow** — no provider-specific hardcoding. Tokens live in the broker; refresh is per-connection via the broker's injected `TokenRefresher` under its lock.
A server that offers both is connected by the customer's choice. A server requiring an unsupported auth kind is refused at registration with a typed, user-actionable error — never silently downgraded to unauthenticated.

**Authentication policy — three explicit classes (paul, amendment 2026-11-25).** Every endpoint carries a recorded `auth_kind`, set at registration and never changed implicitly:
1. **Public (intentionally unauthenticated)** — the customer explicitly declares the server needs no credential. The endpoint is labelled "Public — no authentication" in the Dashboard, and discovery/execution proceed without a credential *because that is the recorded intent*, not because a credential is absent or failing.
2. **Authenticated** — a static credential (R2.1) or OAuth (R2.2) is attached. Discovery and execution **must** present that credential on every call.
3. **Unsupported** — the server requires a mechanism TuGPT does not support. Registration is refused with a typed error.
**No silent downgrade, ever:** if an authenticated endpoint's credential is missing, expired, revoked, or rejected by the server, discovery and execution fail with typed, user-actionable errors (`requires_authorization` / `error` per D3) — they never fall back to unauthenticated calls. If a server's behaviour changes (an authenticated server starts answering without a credential, or a public server starts demanding one), the next discovery produces a *new snapshot requiring fresh approval*, and execution against the old snapshot stops until the endpoint's `auth_kind` is re-confirmed by an owner/admin. The class is part of the approved snapshot's record, so what was approved is exactly what runs.

### R3 — Automatic offering of approved read tools (paul, decision D3)
The original D4 flow offered tools only for `@`-attached capabilities. **Decision:** approved tools whose permission class is **`read`** are offered to the model **automatically** whenever the user is acting within the scope of their organisation's connected, active endpoints — no `@`-attachment required. Tools of class `write`, `irreversible`, or `financial` are **never** offered automatically in a way that bypasses control: they execute only through the approval ladder (exact operation + arguments shown, approval recorded by an authorised approver, single-use, argument-hash-bound). `@`-attachment remains available as an explicit scoping gesture and as the way a user pins a conversation to one integration.
*Guardrails:* automatic offering is bounded by (a) the model's verified-tool-calling status (R5), (b) per-turn tool-call budgets already in the runtime, (c) the per-org rollout lever (R4) — an org with external tools off offers nothing, (d) the user-owned connection isolation below.

**User-owned connection isolation (paul, amendment 2026-11-25).** Connections come in the two ownership kinds of D2, and they are not interchangeable:
- **Organisation connections** (`owner_type='organization'`) are the org's shared integrations: visible and manageable in Dashboard → Connect by owners/admins, and their approved tools may be offered to any member acting within the org's scope (subject to R3/R4 and the approval ladder).
- **User connections** (`owner_type='user'`) are **private to their owner**. They are invisible to other members of the same organisation — not listed, not discoverable, not callable, and their existence is not revealed (listings, capability catalogues, error messages, and audit views available to other members contain no trace of them; RLS scopes user-connection rows to the owning user, and members cannot read another user's connection rows at all).
- **Automatic offering respects this boundary absolutely:** the agent's automatically offered tool set for a conversation is built only from (i) the org's organisation connections and (ii) **the acting user's own** user connections. One employee's personal integrations are never offered to, executed for, or summarised to another employee — including by an owner/admin acting in chat (administrative management rights over org connections confer no access to a member's private connections or their credentials).
- **Grants are the only bridge, and they are explicit:** a user connection's tools may be used by an agent run only when (a) the connection's owner is the acting user of that run, or (b) a recorded, revocable **grant** from the owner names the agent/purpose — per the original D2 rule ("usable only by their owner, or by an agent when that user is the actor *and* a grant exists"). The runtime enforces this in its check order (org-scoped connection → personal-owner check → grant check) on **every** call, not at conversation start; a grant can be revoked by the owner at any time, and revocation takes effect on the next call. Grants never transfer credential access — the broker still resolves the credential server-side, and no other user ever sees it.
- Audit rows for user-connection calls are visible to the connection's owner (and to org audit views only in the aggregate form the owner can see — never with another member's connection identity exposed).

### R4 — Per-organisation rollout is the operative control
The global env switches (`TUGPT_CUSTOMER_MCP_ENABLED`, `TUGPT_CHAT_MCP_EXECUTION_ENABLED`) remain as **platform kill-switches**. The operative enablement control is per-organisation: `organization_integration_policies.allow_external_tools` (default `false`), which the investigation found no MCP-path code consulting. **Decision:** every MCP path — registration, discovery, approval, activation, chat offering, execution — must consult the org policy. An owner turns it on for their org; turning it off stops execution immediately while listing/deletion remain available (exposure-reducing operations are never gated).

### R5 — No model receives tools without real-model verification
`TUGPT_CHAT_VERIFIED_TOOL_MODELS` may list a model only after that model has passed the staging tool-calling probe **as the real model** (the investigation established that all prior MCP-path testing used a scripted fake model). Verification is per model key; adding a model to the list is an operator action recorded with the probe evidence. This is a precondition for enabling chat execution at all (mandatory requirement 3).

### R6 — Member approval requests
A member whose write-class call is blocked may create an approval **request**; owners/admins approve or deny it in the dashboard or the chat card (closing the implementation's own B-11 gap). Approvals remain single-use and bound to (connection, capability, arguments SHA-256, thread). Denial is final for that request; a changed call is a new request.

### R7 — Execution enablement is a checklist, not a flag flip
Customer MCP execution may be enabled (per R4, for any org beyond staging test orgs) only when **all** of paul's mandatory pre-enablement requirements are evidenced:
1. Production egress proxy deployed and security-tested (probe passed and recorded).
2. Persistent, encrypted credential storage verified in the deployed composition (no in-memory credential store anywhere in the path).
3. Real-model tool-calling verification (R5) for every model that will receive tools.
4. Usage-metering defects (2026-11-25 gate: U1/U4/U5/U6) fixed and re-gated.
5. Per-org rollout controls (R4) implemented and tested.
6. Cross-organisation isolation and credential-leakage tests passing (security test plan).
7. Audit integrity and fail-closed behaviour proven by test (audit-sink failure withholds results).
Each item's evidence is recorded; enablement for a pilot org and general enablement are separate approvals by paul.

### R8 — ADR status hygiene
On acceptance of this revision, ADR-021 moves from *Proposed* to *Accepted* in the repo, with this revision's decisions appended as amendments R1–R8 (the original text is not rewritten). The platform-owned companion ADR is accepted alongside it, filed in this repository as **ADR-022** (ADR-020 here is the tool-registry ADR; the 2026-11-25 product documents call it "ADR-020 — platform-owned MCP"). The pair jointly define the two-track MCP architecture and their shared-runtime boundary.
