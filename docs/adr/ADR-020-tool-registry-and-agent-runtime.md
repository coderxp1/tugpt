# ADR-020: Tool Registry, Capability Contracts, and the Agent Runtime

## Status

**Proposed** — design for owner review before implementation. Tier 1.4 of
[ADR-015](ADR-015-ai-business-operating-system.md), with the capability
contract it depends on (Tier 1.1). Nothing described here is implemented; the
tables and interfaces below are a proposal, and the first migration is a
separate PR.

This ADR answers the two questions ADR-015 §5.3 deliberately left open: the
tool registry's concrete interface, and how a tool-calling agent loop coexists
with the existing text-only provider contract.

## Context

TuGPT today can draft a reply. It cannot *do* anything: no code path executes a
side-effecting action on a customer's behalf, and there is no table that records
one. Every capability the product promises above the draft pipeline — calendar,
CRM writes, payments, follow-ups, media from a conversation, Employees,
automations — is an action, and actions need a substrate.

Three constraints from ADR-015 are binding here and are not re-litigated:

1. **No capability may have exactly one possible provider** (D2).
2. **Trust is per `(org, agent, tool class)`**, never one dial per agent (D3).
3. **Idempotency and attribution are per tool**, from the first tool (D1).

Four properties of this repository decide most of the design, because they
already exist and must not be reinvented:

- **Tenant isolation is enforced at the storage layer**: `UNIQUE (id,
  organization_id)` anchors and children FK'ing on `(child_id,
  organization_id)` make a cross-tenant reference impossible, independent of
  RLS. Every new entity follows it (ADR-003/ADR-004).
- **`organization_id` is never caller-supplied in a privileged RPC.** Every
  `SECURITY DEFINER` function locks its anchor row and derives the org. A tool
  must not receive an org id as an argument.
- **The queue contract is proven**: PGMQ, retry with backoff, bounded attempts,
  typed dead-letter into `failed_jobs` with captured provider detail.
- **The audit model is right for actions**: `audit_logs` is immutable by
  trigger, and `created_by_type` with system↔user consistency already models
  "the AI did this" versus "a person did this".

`AIProviderAdapter` exposes one method returning `text: string` and its own
header forbids ad-hoc expansion. The media and transcription work already
solved this the same way: a separate typed interface beside it. Agent tool
calling follows that precedent rather than widening the completion contract.

## Decision

### D1. A registry of platform tools; grants are per organization

**Tool definitions are platform data, not customer data.** A tool is code plus
a manifest; every organization sees the same catalogue. What differs per
organization is whether it may be used.

```
public.tool_definitions            -- platform: key, version, schema, class
public.tool_capability_requirements -- tool -> required capability(s)
public.agents                      -- org-scoped agent rows (ADR-015 1.3)
public.agent_tool_grants           -- (org, agent, tool) + trust state + caps
public.connected_accounts          -- (org, vendor, scopes, secret_reference)
```

A `tool_definitions` row carries: `key` (stable, dotted, e.g.
`calendar.find_availability`), `version`, `description` (owner-facing, used
verbatim in the agent prompt), `input_schema`/`output_schema` (JSON Schema,
validated at registration and at call time), `permission_class`
(`read | write | irreversible | financial`), `idempotency_mode`
(`required | derived | none`), `required_capability`, `max_runtime_seconds`,
and `is_available`.

Rationale for platform-level definitions with org-level grants: a definition
edited per customer is a definition that cannot be reviewed, versioned or
tested. Grants are where customer autonomy lives, and they are the only place
it lives.

### D2. Capability contracts are declared, not inferred

A capability is a narrow, versioned verb: `text.complete`, `text.tools`,
`calendar.read`, `calendar.write`, `media.image`, `media.video`,
`voice.transcribe`, `voice.synthesize`, `embed.text`, `messaging.send`.

- A provider adapter declares the capabilities it serves, in code, beside the
  adapter (an exhaustive `readonly capabilities` member — a missing one is a
  type error, not a runtime surprise).
- A tool declares the capability it requires; it never names a vendor.
- The resolver picks a provider from `(capability, org entitlement, policy,
  cost class, data-residency)`. At least two adapters must be *possible* for
  every capability before a tool for it may ship (ADR-015 D2's non-negotiable
  property), even where exactly one is configured.

This is why `calendar.find_availability` is not written against Google: Outlook
becomes one connector, not a second implementation of every calendar tool.

### D3. Execution lifecycle: a run, its steps, and one row per side effect

```
agent_runs         id, organization_id, agent_id, conversation_id?, trigger,
                   status, budget_json, started_at, finished_at, error_code
agent_run_steps    run_id, seq, kind (model | tool | approval), tool_key?,
                   input_digest, output_digest, status, latency_ms, error_code,
                   provider, model
tool_invocations   id, organization_id, run_id, step_seq, tool_key,
                   idempotency_key, status, attempt, approval_request_id?,
                   result_ref, error_code
approval_requests  id, organization_id, tool_invocation_id, requested_by_type,
                   requested_at, decided_by, decided_at, decision, expires_at
```

Status is `TEXT` + `CHECK` (repo convention), never a Postgres enum — a new
state is a migration either way, and the CHECK keeps the allowlist in one
readable place.

Loop: `propose → authorize → validate → execute → observe → continue|stop`,
with a hard step budget and a wall-clock ceiling per run. The model call is
recorded as a step so "which completion led to this charge" is answerable.

**Digests, not raw payloads, in step rows.** Tool arguments can contain
personal data. `input_digest` (sha256 of the canonical JSON) lets a replay
detect divergence without turning the step table into a copy of customer
content; the authoritative arguments live on `tool_invocations` only for
tools whose arguments are safe to retain, and otherwise in the tool's own
domain table.

### D4. Authorization is a ladder, deny by default

For a proposed call, in order:

1. **Agent grant** — `(org, agent, tool)` exists and is not revoked.
2. **Trust state** — the grant's `draft_review | supervised | autonomous`
   permits execution now, or the call becomes an `approval_requests` row.
3. **Role** — the caller's organization role is allowed for the tool's
   `permission_class` (read-only auditors cannot invoke `write`).
4. **Entitlement** — the org's plan covers the metric the tool consumes
   (`entitlements`, never `feature_flags`).
5. **Kill switch** — `is_feature_enabled` for the capability's flag, plus the
   in-code half for `messaging.send` (ADR-010 amendment 2 pattern).
6. **Caps** — per-period action cap and per-action value cap for the class.

Every check that fails returns a typed code and writes no side effect. The
check is implemented once, inside the RPC that transitions the invocation to
`executing`, not in the worker — a worker that must remember to check is a
worker that eventually forgets.

The calling convention is fixed: privileged RPCs take `p_run_id` /
`p_invocation_id` and nothing tenant-shaped. The org is derived by locking the
run row; a mismatched run is `P4T01`, indistinguishable from "not found".

### D5. Idempotency is a row, not a hope

`tool_invocations` has `UNIQUE (organization_id, tool_key, idempotency_key)`.
The key is derived (`run_id:step_seq`) for tools the loop calls, and supplied
by the caller for anything the customer-facing API can trigger.

Rules:

- A redelivered queue message re-reads the same invocation. If it is already
  `succeeded`, the stored `result_ref` is returned and nothing runs again.
- An invocation in `executing` whose lease expired is **reconciled**, not
  re-run, when the tool can report the outcome of the original attempt
  (calendar event lookup, payment intent lookup). Tools that cannot reconcile
  must declare `idempotency_mode = required` and are refused without a key.
- `irreversible`/`financial` classes require a key from a source the AI cannot
  invent.

### D6. Action audit records are written by the transition, not by the caller

Every invocation writes one `audit_logs` row on each terminal transition
(`succeeded`, `failed`, `denied`, `approved`, `rejected`) inside the same
transaction that changes the invocation. Nothing outside that transaction can
create one, so "the AI charged a customer" always has a row with
`created_by_type = 'system'` and a `run_id`.

Log content rule, from ADR-009 and the transcription worker: identifiers,
codes, latency, provider, model — never arguments, results, message bodies,
tokens, phone numbers or file bytes.

### D7. Trust states and approvals

`agent_tool_grants.trust_state` is per `(org, agent, tool)`, not per agent.
Caps live beside it: `max_actions_per_period`, `max_value_per_action`,
`period_kind`.

- `draft_review`: execution produces an `approval_requests` row and stops. The
  human sees the exact arguments and the tool's owner-facing description.
- `supervised`: executes, and the invocation lands in the review queue.
- `autonomous`: executes within caps; anything outside them escalates instead
  of failing silently.

For `irreversible` and `financial` classes, reaching `autonomous` requires both
a database change *and* a code-level enablement — the pattern already used for
`whatsapp_integration`, generalized. Approvals expire; an expired approval is a
denial, not a standing permission.

### D8. Credentials are references resolved outside the database and outside the AI

A tool never receives a token. `connected_accounts.secret_reference` points at
`organization_secrets` (encrypted by the application under a key the database
does not hold, `20260903000003_secret_storage.sql`). The worker resolves and
decrypts it at execution time, hands the adapter a scoped client, and the
value never enters an argument, a model context, an audit row, or a log.

The model sees tool schemas and results, never credentials. Any tool whose
arguments would need a credential is a design error, not a prompt problem.

### D9. Discovery is filtered, and the prompt is built from the filtered set

`list_available_tools(p_agent_id)` returns only tools with a live grant, a
satisfied capability/connected account, and an entitlement. The agent prompt
receives exactly that list and no more — an agent that knows about a tool it
cannot call produces plausible hallucinations about having called it.

A `tools.version` bump is a prompt-visible event and is recorded on the run, so
"the model behaved differently after Tuesday" is answerable.

### D10. Errors are typed, sanitized, and classified for retry

Codes: `P4T01` not-found/foreign-tenant, `P4T02` denied by grant/role,
`P4T03` approval required, `P4T04` invalid arguments, `P4T05` idempotency
conflict, `P4T06` capability unavailable, `P4T07` provider error (detail
captured, sanitized), `P4T08` budget exhausted, `P4T09` timeout.

Retry policy is per error class, mirroring the draft worker: only transient
provider/transport failures are retried; authorization, validation and
idempotency failures are terminal. Terminal failures dead-letter into
`failed_jobs` with the code and the sanitized provider detail, exactly as the
draft and transcription workers do.

Metrics: run duration, steps per run, invocation success/failure by tool, time
to approval, approval-to-execution latency. Identifiers only.

## Schema sketch (first migration, separate PR)

```sql
CREATE TABLE public.tool_definitions (
  key text PRIMARY KEY,
  version integer NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  permission_class text NOT NULL CHECK (permission_class IN
    ('read','write','irreversible','financial')),
  idempotency_mode text NOT NULL CHECK (idempotency_mode IN
    ('required','derived','none')),
  required_capability text NOT NULL,
  max_runtime_seconds integer NOT NULL CHECK (max_runtime_seconds BETWEEN 1 AND 600),
  is_available boolean NOT NULL DEFAULT false
);

CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  display_name text NOT NULL,
  persona text,
  prompt_version integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, key),
  UNIQUE (id, organization_id)          -- the composite anchor children FK to
);

CREATE TABLE public.agent_tool_grants (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  tool_key text NOT NULL REFERENCES public.tool_definitions(key),
  trust_state text NOT NULL CHECK (trust_state IN
    ('draft_review','supervised','autonomous')),
  max_actions_per_period integer,
  max_value_per_action numeric(14,2),
  revoked_at timestamptz,
  PRIMARY KEY (agent_id, tool_key),
  FOREIGN KEY (agent_id, organization_id)
    REFERENCES public.agents(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE public.tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_seq integer NOT NULL,
  tool_key text NOT NULL REFERENCES public.tool_definitions(key),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('pending','awaiting_approval','executing','succeeded','failed','denied','expired')),
  attempt integer NOT NULL DEFAULT 0,
  approval_request_id uuid,
  result_ref jsonb,
  error_code text,
  UNIQUE (organization_id, tool_key, idempotency_key)
);
```

RLS on everything; no `anon` grants; `authenticated` gets `SELECT` only where a
UI reads it; writes go through `SECURITY DEFINER` RPCs with `REVOKE ALL ...
FROM PUBLIC, anon, authenticated` on the functions, following
`20260902000002_contact_entity.sql`.

## Sequencing

| Milestone | Scope | Proof |
|---|---|---|
| M1 | Registry tables + read-only `list_available_tools` + pgTAP cross-org denial | pgTAP; no execution path yet |
| M2 | Run/step/invocation tables, `begin_run` / `record_step` RPCs, action audit on terminal transitions | Unit + pgTAP; no external side effect |
| M3 | Loop with one `read` tool (`calendar.find_availability`) behind `connected_accounts`; conversation memory | Two-org E2E, replay-safe |
| M4 | `approval_requests` + trust states + caps; the first `write` tool gated by approval | Approval journey E2E |
| M5 | Worker consumption via PGMQ, retries, dead-letter, metrics | Worker restart/redelivery tests |

Each milestone is its own branch and PR. M1 and M2 are additive and touch no
existing pipeline.

## Consequences

- The draft pipeline becomes an agent whose trust state is `draft_review` and
  whose only tool is "propose a reply". That refactor is intentional and comes
  after M4, not during it.
- The registry is a public contract (Employees, automations, customer API).
  Changing a tool's input schema is a breaking change and needs a version bump.
- Until M3 there is still nothing that can act, which is the honest current
  state.

## Risks

- **Approval fatigue.** A trust model that queues everything teaches people to
  click approve without reading. Caps and class-based defaults exist to keep the
  queue small and meaningful.
- **Model tool-calling support is not uniform.** `text.tools` is a declared
  capability precisely so a provider that cannot do it is not routed to, rather
  than discovering it at 2am.
- **Argument retention.** Digests by default, arguments only where safe, and a
  named decision per tool — silence must not become "we kept everything".

## Not decided here

- The JSON Schema validation library (server-side) — decided in M1 with the
  first implementation, not in this record.
- The concrete first connector's vendor (Google) and its OAuth scopes — that is
  ADR-015 2.4/2.5 work.
- Employee manifest format (ADR-015 D7) — it consumes this registry, but is its
  own record.
