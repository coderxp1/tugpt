# ADR-021: TuGPT Connect — Integration Platform

## Status

**Proposed** (2026-11-12). Authorized for Phase 0 engineering on
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
