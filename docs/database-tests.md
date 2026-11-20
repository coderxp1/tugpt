## Consolidated P2 closure source pass - current status

The owner approved the closure proposal, H09/H12/H17 SQL-text exception and A15-A23 diagnostic-privacy addition: 24 existing editable rows, unchanged 155 candidate / 21 review-path allowlist. This section supersedes earlier unfinished-source descriptions; the previous text below remains historical context, not current execution evidence.

Source is authored for review, not accepted as P2 complete. All derivative execution remains NOT RUN. M2 is ON HOLD; CF-01-CF-07 are OPEN; P3 is unauthorized. D6, hosted/data-owner/identity validation and production release are separate. This pass performed no dependency installation/resolution, build, lint, typecheck, tests, SQL, migration, runtime, service, container, infrastructure, gateway, DNS, credential, deployment or publication operation.

### Assertion reconciliation and evidence completeness

T10's three tautologies are replaced. Two checks inspect direct imports, including side-effect import syntax; they are not transitive dependency or runtime-egress proof. Logging checks invoke all nine real handlers with independent message/stack/name/header/body/token sentinels and observe actual serialized console diagnostics from the unchanged logger. Supplemental service-exception, RPC-warning and success-log cases check unchanged sanitized HTTP errors and private/no-store. None has run.

T02 titles disclose already-approved 410 retirement while retaining original identities. T19 preserves the three ordinary gated products and adds per-product false/null/true checks with unconditional holds. T22 describes actual server/client/data assertions rather than a global component count. T01 is reviewed and unchanged: local logout confirmation/failure/retry is not coordinated M2 logout. Preserve 39 original identities (35 retained expectations and four P2-AC-01 substitutions), ten W1 groups/32 assertions and W1-10 accounting.

The 185-stage register records existing web/worker/package scripts and exact test/SQL files. TAP rejects not-ok, bailout, skip/TODO, missing/duplicate plans and incomplete identities even with exit zero. Vitest requires exact files and every assertion passing. Historical appointment_requests service-role DELETE, transcription-worker lease-extension and aggregate no-dead-domain residuals are reproduction/classification obligations, not presumed failures or waived green CI.

H17's ten identities remain separate from H19's delivery races. Sequential stale-CAS requests are conflict evidence, not concurrent transaction races; H17/H19/unchanged SQL tests retain their specific concurrency boundaries. UI-only intercepted inbox/analytics errors are presentation evidence, not real backend-failure evidence. Source declarations and syntax parsing are not executable test results.

## Historical checkpoint and prior operational guidance

## P2-DB-01 test source and evidence status

All derivative tests are NOT RUN. No build, lint, typecheck, dependency resolution or SQL execution occurred. The separate review-root `test-map.json` is the assertion/feature/path register; it separates historical results, derivative expectations and absent coverage.

T10 asserts the ordinary client, scoped parameters, narrow feature client, delivery/receipt JSON, nondisclosure, error degradation and no fallback. T34 covers two wrapper return contracts, feature/session/revocation and array bounds. T35 covers effective privileges, actual role-execution denials, owner/search-path/overloads and preservation of the old service-only grants. T36 covers mixed-tenant input, duplicate/missing/foreign IDs, removed membership and removed mapping. H19 adds real HTTP/raw-PostgREST probes and 12 observed-blocker delivery race cases; H16 adds a separate real-login browser/API read journey. They are authored test sources, not execution evidence.

Original SQL regression files remain unchanged, including approval/enqueue, outbound delivery and receipt suites. Existing weak structural placeholder assertions are disclosed in H21 and are not proof of absence of provider calls. Wider ordinary write journeys, baseline/unit/worker comparison and migration failure/upgrade evidence remain unfinished outside this narrow amendment. No worker or provider execution is authorized. Historical 39-check accounting is 35 retained expectations plus four approved P2-AC-01 substitutions; W1 remains 10 groups/32 assertions with explicit W1-10 accounting.

# The database test suite

**Status:** active
**Gate:** CI job `database-tests` in `.github/workflows/ci.yml`
**Files:** <!-- database-tests-count:start -->`supabase/tests/database/*.sql` — 62 files<!-- database-tests-count:end -->, ~800 pgTAP assertions

## Why this document exists

Until 2026-08-20 these files ran nowhere. CI had two jobs, `build-and-test`
(the pnpm gate) and `docker-build`, and neither invoked `supabase test db`. The
suite was written, committed, cited as evidence that the security model works —
and never executed by anything automatic.

That matters more here than it would in most codebases, because **TuGPT's
security model is almost entirely in the database.** RLS policies, the
`private.*` SECURITY DEFINER RPCs, the typed SQLSTATE contract, quota
reservation atomicity, queue visibility — none of it is expressible in
TypeScript, so none of it is covered by the pnpm gate. `pnpm test` passing tells
you the application code compiles and its units behave. It tells you nothing
about whether organization A can read organization B's drafts.

Turning the gate on found that the suite had drifted behind three migrations.
That is the argument for the gate, in one sentence.

## Running it

Requires Docker.

```bash
supabase db start      # pulls supabase/postgres, applies supabase/migrations, runs seed.sql
supabase test db --local
```

`supabase db start` is the database only — no API gateway, no auth server, no
studio. It is what pgTAP needs and nothing else. The Postgres major version
comes from `db.major_version` in `supabase/config.toml`.

To run one file while iterating:

```bash
supabase test db --local supabase/tests/database/rls_adversarial.test.sql
```

`supabase db reset` re-applies every migration from scratch against the running
container — use it after adding a migration rather than restarting.

### Race tests (run separately)

`supabase/race-tests/` holds the genuine two-session concurrency races.
They are NOT scanned by `supabase test db --local`: each race needs a
dblink self-connection, which PostgreSQL only grants to a superuser, and
pg_prove fails the whole run when any scanned file executes zero tests —
so a no-op or skip inside the suite tree is not an option. They run only
via the CI `database-tests` job's dedicated race step, as `supabase_admin`:

```bash
supabase test db \
  --db-url "postgresql://supabase_admin:postgres@127.0.0.1:56322/postgres" \
  supabase/race-tests/media_concurrency_race.test.sql \
  supabase/race-tests/media_quota_race.test.sql
```

Each file fails closed if run as a non-superuser or if the self-connection
is unavailable — there is no skip path. Current races:

- `media_concurrency_race.test.sql` — D3: two sessions hold uncommitted
  enqueues on the same org at the same time; the partial unique index
  admits exactly one winner (D3a loser gets P3M09, D3b exactly one
  survivor, D3c survivor is the first committer, D3d loser's row never
  materializes).
- `media_quota_race.test.sql` — C1..C5: two sessions submit different
  lanes concurrently against a tight 550 GPU-s budget; the advisory lock
  serializes check-then-enqueue so exactly one job is admitted (C1 loser
  gets P3M16 not P3M09, C2 exactly one survivor, C3 admitted cost is
  100 GPU-s, C4 lightning/first committer survives, C5 loser's row never
  materializes).

## What the suite covers

| File | Guards |
|---|---|
| `rls_adversarial.test.sql` | cross-tenant reads/writes under real RLS, with `SET ROLE` and injected JWT claims |
| `rls_customer_facing_tables.test.sql`, `rls_operational_tables.test.sql` | RLS enabled, and the policy set, per table |
| `phase3b_permissions.test.sql`, `rpc_execution_permissions.test.sql`, `queue_wrapper_permissions.test.sql` | who holds EXECUTE on what — the grants that keep `anon`/`authenticated` out of the worker's RPCs |
| `phase3b_sqlstate.test.sql` | the P3B* error-code contract the worker and the API error mapper both depend on |
| `phase3b_store_archive.test.sql`, `phase3b_integrity.test.sql` | draft persistence, archival, and that `failed_jobs` carries no customer content |
| `phase3b_quota.test.sql` | reservation/consumption atomicity |
| `phase3b_schema.test.sql`, `phase3b_draft_rpc_wrappers.test.sql` | schema and function shape — the assertions that catch migration drift |
| `draft_attribution_and_audit.test.sql` | the 2026-08-19 migrations: provider-error detail and its 512-char backstop, the extended dead-letter allowlist, provider/model on the completed job row, review events append-only and surviving reviewer erasure, `applied_migration_versions` and its grants |
| `webhook_ingestion.test.sql`, `worker_processing.test.sql`, `queue_read_visibility.test.sql`, `dead_letter.test.sql`, `conversation_lifecycle.test.sql` | the inbound path and PGMQ semantics |
| `phase3b_feature_flag_rls.test.sql` | `is_feature_enabled` and its RLS |
| `invitations_and_ownership.test.sql` | membership lifecycle, double-acceptance protection |
| `invitation_security.test.sql` | the 20260902000001 security model: that `authenticated` can no longer write the invitations table directly (the hole this closed), the rank ceiling on who may be invited, that a stored `token_hash` is not presentable as a token, that accepting never rewrites an existing membership role in either direction, and that cross-tenant probing of organization and invitation ids gets one answer |
| `conversation_activity_ordering.test.sql` | `conversations.activity_at` — that it falls back to `created_at`, that it is generated and unwritable, and that ordering on `last_message_at` still gives the wrong answer (the reason the column exists) |
| `ai_draft_config_defaults.test.sql` | that a config nobody wrote is Spanish and usable, that `business_instructions` stays empty because it has no true generic value, and that the backfill left written configs alone |
| `draft_quota_period_lifecycle.test.sql` | that `ai_draft_generation` cannot be enabled for an organization with no quota period covering today (P3B17), proved by a positive control that makes the forbidden write happen, plus the exemptions that keep the rule from refusing every flag write |
| `organizations_locale.test.sql` | the locale vocabulary: `organizations.locale` defaults to `es`, permits `en`, refuses anything else and is case-sensitive; the same for `profiles.preferred_locale` (ADR-017) |
| `contact_entity.test.sql` | `public.contacts` — that a contact is `(organization_id, phone)` and NOT scoped to a WhatsApp number (one human on a business's two numbers is one contact), that `contacts.phone` is immutable and `conversations.contact_id` is derived and refuses to disagree with `contact_phone`, and that the backfill collapses pre-migration rows the same way |
| `plans_and_entitlements.test.sql` | ADR-015 D5's entitlement layer — that resolution FAILS CLOSED for an organization with no subscription, that override beats plan and an expired override does not, that `past_due` still resolves while `canceled` does not, that unlimited (`granted` with a NULL allowance) stays distinguishable from denied, and that every declared metric has a counting branch |
| `conversation_assignment_and_handoff.test.sql` | that `needs_human` actually stops AI drafting — proved end to end through `process_inbound_message` with positive controls in both directions, since a status column that no code reads would look identical — plus assignment compare-and-set, the `conversation_events` record of who switched it, and that erasing a reviewer releases their conversations instead of blocking the delete |
| `provider_usage_and_cost.test.sql` | token and cost accounting — that an event's cost equals the sum of its components (tampering with either side is refused), that an unpriced call is recorded with a NULL cost rather than dropped or valued at zero, that a later price change does not re-price history, and that audio bills on the provider's `billing_time` (duration x channels) rather than on the duration we measured |
| `table_privilege_hygiene.test.sql` | the one privilege rule that row policies cannot enforce — that no table in `public` grants TRUNCATE, TRIGGER or REFERENCES to `anon` or `authenticated`, checked as a query over the catalogue rather than a list of table names so a table added tomorrow is covered; with positive controls that the DML those roles need is still present, that `service_role` was left alone, and — by creating a table inside the test — that a brand-new table arrives holding all three for both roles, which is why the guard exists rather than a one-time revoke |
| `connect_mcp_privilege_hygiene.test.sql` | the MCP approval/audit privileges of migration `20261120000001` — that `anon` and PUBLIC hold nothing on `tool_approvals` / `mcp_tool_calls`, `authenticated` and `service_role` hold exactly SELECT, every writer RPC is SECURITY DEFINER and not executable by `anon` (while `sso_control` keeps EXECUTE on `record_mcp_tool_call`); that TRUNCATE / DELETE / UPDATE / INSERT by `authenticated` are refused (no self-approval, no un-consuming, audit undeletable and unforgeable) and `service_role` cannot TRUNCATE or DELETE the audit; and that the trusted claim path still consumes an approval single-use while a foreign tenant neither sees nor claims it (since `20261120000010` that path is `claim_tool_approval_audited` — `true:OK`, then `false:ALREADY_USED`, foreign `false:FORBIDDEN` — and `authenticated` can no longer execute the unaudited `claim_tool_approval`, P0) |
| `mcp_snapshot_versioning.test.sql` | MCP tool-snapshot versioning in `create_mcp_snapshot` (migrations `20261120000002`, `20261120000004`, `20261120000005`) — v1, v2, v3 accepted strictly in order; a replay, a stale v1 (the old hard-coded value), a skip to v5, NULL and 0 each refused with `PT409` SNAPSHOT_VERSION_CONFLICT (PostgREST answers HTTP 409 and never retries it; the earlier `40001` made PostgREST re-run the transaction until the bridge JWT expired); the function carries `lock_timeout=2s` (C3; C7 checks it is at most 3 s, leaving 2 s of the app's 5 s PostgREST request timeout) and maps `lock_not_available` on the endpoint row to `PT409` (C5) and on any other lock to `PT503` SNAPSHOT_STORE_BUSY (C6), and no function in `public`/`private`/`sso` raises a retryable SQLSTATE (`40001`/`40P01`); non-array / NULL `p_tools` refused with `22023`; an invalid tool name, a duplicate name or an over-long description aborts the whole snapshot so no row and no partial tools persist and no version is consumed; new tools default to least-privilege; another tenant's endpoint is `P0002` and another tenant's org or a `manager` (highest non-admin role) is `42501`. Since `20261120000007` the function is no longer executable by any API role, so this file grants `authenticated` EXECUTE inside its own transaction (rolled back) to keep exercising the body; C2 asserts `anon` and `service_role` cannot execute it. The concurrent race (row lock, then conflict) is exercised separately through real PostgREST (`N` = 2/5/10 parallel callers: one 200, the rest 409, contiguous versions), not in this file |
| `mcp_snapshot_idempotency.test.sql` | Idempotent snapshot creation (migration `20261120000006`): `create_mcp_snapshot_idempotent` creates one snapshot per (endpoint, `Idempotency-Key`) — a replay of a committed key returns the original id/version with `replayed=true` and writes nothing; a different key gets the next version (assigned by the database, max + 1 under the endpoint row lock); `get_mcp_snapshot_request` reports `committed` (with the snapshot) / `not_found`; malformed keys `22023`; the snapshot, its tools and the idempotency record commit or roll back together; a deadline in the past raises the non-retryable `PT504` and writes nothing; the deadline is capped at statement start + 3 s and checked as the last step; `lock_timeout=2s`; `SECURITY DEFINER`; a `manager` and another tenant are `42501`, another tenant's endpoint `P0002`; the same key on another endpoint is independent; `external_tool_snapshot_requests` has RLS on, no policies and no direct table privileges for `anon`/`authenticated`/`service_role`; `UNIQUE (endpoint_id, idempotency_key)`. `IN_PROGRESS` (`PT409`, a second session holding the key), `ENDPOINT_BUSY` and the lock/timeout matrix need concurrent sessions and are exercised through the real route by `scripts/regression/snapshot-idempotency.py`, not in this file |
| `mcp_snapshot_legacy_and_tenant.test.sql` | Migration `20261120000007` (M9 follow-up; renumbered from `20261120200001` to resolve collision B-2 with the Workspace migration of the same version, SQL byte-identical — the header comment and the stored `COMMENT ON FUNCTION` text still say `20261120200001`). Legacy (L1–L10): no overload of the keyless `create_mcp_snapshot` is executable by PUBLIC, `anon`, `authenticated` or `service_role`; a real org owner and `service_role` calling it are refused by the grant and nothing is written, while the same owner still creates v1 through `create_mcp_snapshot_idempotent`, which stays executable by `authenticated` and not `anon` (the migration also marks the legacy function DEPRECATED; that comment is not asserted). Ownership first (O1–O6): the bodies of `create_mcp_snapshot_idempotent` and `get_mcp_snapshot_request` check endpoint ownership before `pg_advisory_xact_lock` / the try-lock; an owner of another org naming this org's endpoint gets `P0002` NOT_FOUND from both, naming this org itself is `42501` FORBIDDEN, and those calls write nothing. Endpoint lookup (E1–E5): `get_mcp_endpoint_url` has `lock_timeout` ≤ 2 s (below the app's 5 s PostgREST timeout); an owner gets their URL; a missing endpoint and another tenant's endpoint are NULL (the only results the app may turn into 404); a `manager` is `42501` (403 in the app). That a foreign tenant does not wait on, or learn about, an in-flight key needs two sessions and is measured through the real route by `scripts/regression/snapshot-idempotency.py cross-tenant-in-progress` |
| `mcp_resolve_requires_no_credential.test.sql` | the MCP execution resolver of migration `20261120000003` — that `sso_control` keeps EXECUTE on `resolve_mcp_execution` and `authenticated` has none; that members still cannot read `auth_connection_id` or `url`, so the old app query that selected `auth_connection_id` is refused (`42501`, the production bug that made every MCP tool unrunnable) while the new shape (`id, organization_id, status`) works; and that an endpoint resolves only for its own organization and only while it has no stored credential, removing the credential being the only difference |
| `mcp_activation_requires_approved_snapshot.test.sql` | Migration `20261120000008` — `activate_mcp_endpoint` refuses (SQLSTATE `PT409`, `SNAPSHOT_NOT_APPROVED`, status unchanged) unless the endpoint's newest snapshot is approved and not revoked: no snapshot, an unreviewed rediscovery hiding an older approval, and a revoked newest snapshot are all refused; approving the newest snapshot allows first activation and re-activation; idempotent re-activation; manager refused (`42501`); another tenant's endpoint returns `false` and stays untouched; anon has no EXECUTE; SECURITY DEFINER with pinned `search_path` |
| `mcp_tool_error_outcome.test.sql` | Migration `20261120000009` — the customer-MCP audit accepts the new `TOOL_ERROR` outcome (tool ran and answered `isError: true`) in both `record_mcp_tool_call` and the `mcp_tool_calls` CHECK; every earlier outcome still accepted, unknown outcomes still rejected (`22023` / `23514`), RPC ACL unchanged (no anon/authenticated EXECUTE, SECURITY DEFINER, pinned search_path). |
| `mcp_approval_audit.test.sql` | Migration `20261120000010` — append-only `mcp_approval_events` (UPDATE/DELETE refused, FORCE RLS, owner/admin-only SELECT, no write grants for `anon`/`authenticated`/`service_role`, arguments stored as SHA-256 only); `claim_tool_approval_audited` records `claimed` or exactly one denial reason (`approval_requested` for a chat turn; `CLAIM_AFTER_REJECT`, `ALREADY_USED`, `CLAIM_AFTER_REVOKE`, `EXPIRED`, `NOT_REQUESTER`, `ARGUMENTS_MISMATCH`, `NO_APPROVAL` for an approved call), a non-member is `FORBIDDEN` with no event; the legacy `claim_tool_approval` is no longer executable by `authenticated`; triggers record `approved`, `revoked` (reason from `tugpt.revoke_reason`) and `executed` / `execution_failed`; `reject_tool_call` by requester or owner/admin, a later approval of a rejected call raises `CALL_REJECTED`; `record_mcp_approval_event` writes only into the caller's org and nulls foreign ids; a foreign tenant sees no events |
| `secret_storage.test.sql` | encrypted credential storage — that `authenticated` and `anon` hold *nothing* on either table (not even SELECT, and specifically not TRIGGER or REFERENCES), that the metadata reader returns an exact column set carrying no ciphertext, iv, auth_tag or key_id, that a wrong-length GCM nonce or truncated tag is refused at the write, and that a nonce reused under one key is refused |
| `voice_transcription.test.sql` | the Gladia seeds — that the `voice_transcription` flag ships false and that `is_feature_enabled` ANDs its global and per-org rows in both directions (an organization opting in while the global switch is off stays off; flipping the global switch alone enables nobody), and that the seeded audio rate is USD 0.61 per hour rather than the literal the migration inserted |
| `multi_currency.test.sql` | two currencies in the price book — that an event's currency is derived from the prices resolved for it rather than taken from a column default (the bug 20260903000005 fixes), that currency is NULL exactly when cost is, that components disagreeing on currency are refused, that the cost meter raises rather than under-reporting when a period holds spend it cannot convert, and that the eight Langdock rates recover to the EUR-per-1M figures they were read from |
| `fx_conversion.test.sql` | EUR→USD accounting at the ECB reference rate — that the rate in force is the latest one at or before an event's instant (never reached backwards for), that identity needs no row, that the rate and its date are stored per row so a later rate cannot re-price recorded history, that an event already in the accounting currency stores no rate at all, and that a stale rate warns rather than blocking |
| `org_usage_summary.test.sql` | the analytics v1 read path (20260911000001) — that the aggregate RPC is the ONLY way `authenticated` reaches usage data (a direct SELECT on `provider_usage_events` is still refused), that membership is the authorization and a non-member gets the same P3J02 as a nonexistent organization id (no existence oracle), that the window is [from, to) and an unordered or >366-day window is refused, that an unpriced call is counted and its quantity summed while contributing nothing to any cost total, and that one organization's events move none of another's totals |
| `transcript_ingest.test.sql` | the path a voice note takes to a draft — that a body can never exist without a `body_source` saying whether a person or a machine produced it (and never a source without a body), that each of the five conditions gating a billable transcription is independently load-bearing against a positive control run on the same fixture, that one message can hold only one transcription job, that completing one writes the transcript, closes the job and enqueues the draft in a single call, that an empty transcript still completes and still bills but writes no body and enqueues nothing, and that a failed or dead-lettered job never puts provider diagnostics in front of a reviewer |
| `transcription_worker_rpcs.test.sql` | the five queue verbs the transcription worker runs on — that a job already carrying a provider job reference is never re-submitted, that the fourth delivery dead-letters without a fourth billable call and records three attempts rather than four, that a completed job's stale queue message is deleted while a dead letter is archived (a success must not appear beside the failures an operator reads), that every terminal code the worker can produce is accepted by both the archive RPC and the `failed_jobs` CHECK — asserted one code at a time, because a set comparison passes while one is missing from one of the two lists — that a job no worker ever claimed cannot be dead-lettered with an invented attempt count, that a recorded provider job reference is never overwritten by a different one, and that `fail_transcription_job` is deliberately absent from the public schema |
| `media_worker_rpcs.test.sql` | the media worker's queue verbs — that enqueue validates kind/prompt/params before any side effect (P3M12), that the caller must belong to the named organization (P3M13) and the `media_generation` flag must be on globally and per-org (P3M10), that idempotent resubmits return the existing job while a reused key with different prompt/kind/params is refused (P3M14), that a second active job for the org loses a genuine two-session race with P3M09 (proved with two concurrent dblink sessions, not a serialized approximation), that `prompt_id` is recorded before polling and never overwritten, that cancelling removes the queued message and records a reason, that completing enforces the exact `<org_id>/<job_id>.<png\|mp4>` result path with the extension matching the kind (P3M15), that the `media` storage bucket exists and is explicitly private (`public = false`, asserted not assumed from the default), and that `anon`/`authenticated` hold no EXECUTE on any of the worker RPCs |
| `media_quotas.test.sql` | the per-organization media quotas — that the shared daily/monthly GPU-compute budget is the binding constraint across lanes (lightning usage exhausts it for a quality job and vice versa, pinned against the reference costs lightning 100 / quality 500 / image 10 GPU-s), that `submit_media_job` runs lane resolution + quota gate + reserve + enqueue atomically (a budget-exhausted submission raises P3M16 and reserves nothing; an idempotent replay bypasses the gate but still raises P3M14 on a params mismatch), that two genuinely concurrent submissions admit exactly one job with the loser getting P3M16 (the two-session dblink race lives in supabase/race-tests (not scanned by the regular run)), that `check_media_quota(org, kind, lane)` rejects a submission once that lane's daily or monthly cap is reached (P3M16, with the lane in the detail), that each lane (lightning / quality / image) is capped independently and usage never leaks across lanes, that a video job with no lane in params counts as lightning, that an unknown kind, lane, or mismatched kind/lane pair is rejected (P3M12), that the day/month windows are UTC boundaries (a job from last month or yesterday does not consume the current window), that `skipped` jobs never consume quota while `cancelled` and `dead_lettered` jobs do, that a missing quota row or all-NULL limits mean unlimited, that a limit of 0 disables that lane, that one org's usage never throttles another, and that only `service_role` can execute the check and submit functions |
| `appointment_requests.test.sql` | appointment-request persistence (20261019000001) — that suggestions are the only thing the slice records (no path writes a CONFIRMED state; the CHECK refuses it), that create is idempotent on `(organization_id, idempotency_key)` with the first row winning, that RLS scopes every read to the caller's organizations and `authenticated` holds SELECT only on both tables, that a FAILED request must carry its failure reason and a non-FAILED one must not, that duplicate `(request, start, end)` suggestions are refused, and that `updated_at` is trigger-maintained |
| `organizations_time_zone.test.sql` | the trusted business time zone (20261019000002) — that `organizations.time_zone` accepts only real IANA names from `pg_timezone_names` (offset strings, padded names, wrong case, `localtime`/`posix/*`/`right/*` all refused) and stays NULL when unset, and that the conversions the application resolver relies on hold at the database: Madrid's spring-forward gap and autumn overlap resolve to the post-transition offset, an unknown zone name raises 22023 |
| `oauth_state_nonces.test.sql` | OAuth state consumption (20261020000001) — that the spent-state table exists with RLS enabled and forced and the state hash as its primary key, that a first spend inserts, that spending the same state twice raises unique_violation (the replay wall), that a spend against a missing organization raises foreign_key_violation, that an `authenticated` session is refused by RLS while `service_role` can spend, and that only the successful spends are stored |
| `connect_registry.test.sql` | TuGPT Connect registry (20261112000001, ADR-021 / ADR-020 A1) — RLS enabled and forced on all 13 tables; no `anon` privilege, no `authenticated` writes, no browser read of ciphertext/pending-auth/access-log; append-only logs; composite FKs make cross-org ciphertext, grants, snapshots and endpoint auth unrepresentable; user-connection owner must be a member; GCM nonce reuse rejected; endpoint URL floor (https, :443, no userinfo); approved snapshots immutable; per-role visibility across two orgs; revoke RPC authorization, idempotency, ciphertext deletion, grant revocation and audit; org erasure cascades |
| `sso_reconciliation_core.test.sql`, `sso_reconciliation_support.test.sql` | SSO reconciliation (20261106000001-2): identity-link core and its support functions; imported from the dashboard runtime r01, whose header marks them "source only, not run" — this checkout runs them on the isolated local stack |
| `sso_reconciliation_tenants.test.sql`, `sso_reconciliation_business.test.sql` | tenant selection and the business lifecycle under bridge and legacy claims, with synthetic fixtures (20261106000003) |
| `sso_reconciliation_privileges.test.sql` | effective ACL, owner, search_path and overload audit for the SSO reconciliation objects (P2-DB-01) |
| `create_images.test.sql` | image history (20261115000002): RLS enabled and forced, `anon` holds no privilege, only status fields are updatable and nothing is deletable, the prompt is immutable, unsupported sizes are rejected, a member can record only their own generation in an organization they belong to, rows are visible only to their owner (not to the organization owner, not to another tenant), and a former member loses read and write access (16 tests) |
| `workspace_chat.test.sql` | workspace chat (20261115000001): owner-only threads that also require active membership, append-only messages and tool-call audit, `record_connect_tool_call()` actor/thread/connection checks, and `list_chat_capabilities()` states, across two organizations (30 tests) |
| `knowledge_entries.test.sql` | FAQ v1 (migration 20261022000004) — that a member reads only their own workspace's entries (another workspace's rows are invisible, a non-member sees none), that write authority is owner/admin only (an agent's insert is refused, an owner's cross-workspace insert is refused by WITH CHECK, and a cross-workspace update touches nothing), that the enabled flag defines the worker's candidate set, that blank questions are refused by the content check, and that no destructive grants survive on the table |
| `outbound_delivery.test.sql` | the outbound WhatsApp delivery queue (migration 20261022000001) — that enqueue derives organization, recipient and body from the draft's own rows and takes no tenant input, that it is idempotent per draft (same delivery id, exactly one queue message, so a customer never receives a reply twice), that an unapproved draft (P3W02), a missing draft (P3W01), a body-less approved draft (P3W06) and an inactive connection (P3W05) are each refused, that claim reconciles attempts to PGMQ's read_ct, that completion is identity-checked by organization (P3W04) and archives the queue message, that the terminal archive accepts only the two allowlisted codes (P3W07 otherwise) and writes the `failed_jobs` row, and that `authenticated` can neither execute the RPCs nor read the table under RLS. Enablement is deliberately NOT asserted: the `whatsapp_integration` kill switch lives in `packages/feature-flags` (ADR-010 amendment 2), not in these RPCs |
| `approve_and_enqueue.test.sql` | the atomic approval (migration 20261022000003) — that `approve_and_enqueue_draft` approves and enqueues in one call, that a duplicate approval is refused (P3B04) with still exactly one delivery and one queue message, that an inactive connection fails the whole call (P3W05) and the draft REMAINS in 'draft' (the approval rolled back with the enqueue), that a non-member is refused by approve_draft's own membership check (P3B02), and that the two delivery read RPCs derive the organization from the draft and stay service_role-only |
| `delivery_receipts.test.sql` | delivery receipts (migration 20261022000005) — that a delivered receipt stamps delivered_at at the provider event time and replaying it moves nothing, that read stamps read_at and implies delivered_at, that a failed receipt dead-letters a sent delivery with OUTBOUND_RECEIPT_FAILED and terminal rows then ignore receipts, that receipts match by provider message id alone so one organization's traffic never touches another's delivery, that unknown ids and unknown statuses return FALSE, that the delivery read RPC exposes the receipt times, and that authenticated cannot execute the receipt RPC |

## Writing a test

Every file is one transaction, rolled back:

```sql
BEGIN;
SELECT plan(<n>);
-- ... exactly n pgTAP assertions ...
SELECT * FROM finish();
ROLLBACK;
```

Three rules, each of which was broken by a file in this repo before the gate
existed:

1. **An assertion is a `SELECT` of a pgTAP function.** `SELECT ok(...)`,
   `SELECT is(...)`, `SELECT has_function(...)`. A bare
   `SELECT some_boolean AS ok_2, 'description' AS test_name;` looks like a test
   and is not one — it emits a result set, pg_prove reads TAP, and the line is
   silently ignored. It can never fail. `phase3b_draft_rpc_wrappers.test.sql`
   had twelve of these.
2. **`plan(n)` must equal the number of assertions**, and `finish()` must be
   present to report it when it does not. Two files were missing `finish()`.
3. **An exception aborts the transaction** and every remaining assertion in the
   file with it. `has_function_privilege('anon', 'public.f(int)', 'EXECUTE')`
   raises if `public.f(int)` does not exist — so a signature that drifts does
   not fail one assertion, it kills the file from that point on.

## When you add a migration

Assertions about schema shape live in `phase3b_schema.test.sql` and
`phase3b_draft_rpc_wrappers.test.sql`. If a migration changes a function
signature, adds a column, or changes nullability, update them in the same PR —
the gate will tell you, but only for the shape you already asserted. A new
column nobody asserts is a new column nobody tests.

Behaviour a migration introduces needs its own assertions, and those belong with
the concern rather than with the migration date.
`draft_attribution_and_audit.test.sql` is the example: it exists because the
three 2026-08-19 migrations shipped with none, which is how the older
shape assertions were free to drift behind them. If a new file is the right home,
add it to the table above so the suite stays legible.

Dropping and recreating a function to change its arity deserves a
`hasnt_function` assertion on the old signature as well as a `has_function` on
the new one. Otherwise a `CREATE OR REPLACE` that accidentally leaves the old
overload callable still passes.

## Route-level lock regression (snapshot route)

`scripts/regression/snapshot-route-lock.py` drives the real chain Next → PostgREST → Postgres on a
**disposable** database (it re-creates one endpoint row and, in `slow-write` mode, a temporary trigger).
A real psql session holds the endpoint row lock, a table lock, or slows the insert, for a chosen number
of seconds after one `POST …/snapshot` is sent. Expected results (`lock_timeout=2s`, app timeout 5 s):

| Case | Expected |
|---|---|
| `row` / `tools-ddl` held < 2 s | 201, next version |
| `row` held ≥ 2 s (also just below 5 s) | 409 `SNAPSHOT_VERSION_CONFLICT` after ~2 s, nothing written |
| `tools-ddl` held ≥ 2 s | 503 `SNAPSHOT_STORE_BUSY` + `Retry-After: 2` after ~2 s, nothing written |
| `snap-read` held < 5 s, `slow-write` < 5 s | 201, next version |
| `slow-write` > 5 s | 503 `DATABASE_TIMEOUT` after ~5 s; the outcome is unknown to the app and the snapshot can still commit, complete (all tool rows), after the response |

Every case also asserts no idle-in-transaction sessions, no ungranted locks, contiguous versions,
no snapshot without its tool rows, and that a follow-up request gets the next version. Never 500.
Required environment: `SNAP_BASE_URL`, `SNAP_ORIGIN`, `SNAP_ORG_ID`, `SNAP_ENDPOINT_ID`,
`SNAP_ENDPOINT_URL`, `SNAP_COOKIE_FILE`, `SNAP_PG_CONTAINER`, `SNAP_PG_PW_FILE`.

## Route-level idempotency / timeout regression (snapshot route, M9)

`scripts/regression/snapshot-idempotency.py CASE [ARGS]` drives the real chain Next → PostgREST → Postgres on a
**disposable** database with an `Idempotency-Key` on every POST (same environment as above). Since M9 the route
calls `create_mcp_snapshot_idempotent` with a deadline of now + 3 s; the database rolls back a write that runs past
it, so a snapshot never commits after the app (5 s) has given up, except for commit + response taking > 2 s.

| Case | Expected |
|---|---|
| `slow-timeout 6` / `slow-timeout 9` | 503 `DATABASE_TIMEOUT` at ~5 s; replays while it runs → 409 `IN_PROGRESS`; the write rolls back (deadline / `statement_timeout`); the next replay → 201, exactly one snapshot; the replay after that → 200, same id |
| `lost-response` | client gives up at 0.5 s, the 1.5 s write commits; `GET ?idempotencyKey=` → `committed`; replay → 200 with the original id/version (`Idempotent-Replayed: true`), no duplicate |
| `in-progress` | replay during a 2 s write → 409 `IN_PROGRESS` + `Retry-After: 2`; original → 201 |
| `same-key N` (2/5/10) | one 201, the rest 200 replay or 409 `IN_PROGRESS`; exactly one snapshot |
| `diff-keys N ROUNDS` | all 201, contiguous versions, one record per key |
| `lock row` ≥ 2 s | 503 `ENDPOINT_BUSY` after ~2 s, nothing written; replay → 201 |
| `lock tools-ddl` ≥ 2 s | 503 `SNAPSHOT_STORE_BUSY` after ~2 s, nothing written; replay → 201 |
| `slow-write` ≤ 2.5 s / 4.5 s | 201 / 503 `SNAPSHOT_DEADLINE_EXCEEDED` before 5 s, rolled back; replay → 201 |
| `replay-under-ddl` | replay of a committed key during DDL on `external_tools` → 503 `SNAPSHOT_STORE_BUSY` (never 500) |
| `read-timeout 9` | `GET /snapshots/{id}/tools` with `external_tool_snapshots` locked 9 s → 503 `DATABASE_TIMEOUT` at ~5 s, exactly one database attempt (postgrest-js no longer retries a timed-out GET) |
| `endpoint-lookup-locked post\|get SECS` (M9 follow-up, F-M9-1) | `external_tool_endpoints` locked `ACCESS EXCLUSIVE` for SECS: ≥ 2 s → 503 `DATABASE_TIMEOUT` + `Retry-After: 2` at ~2 s (`get_mcp_endpoint_url` `lock_timeout=2s`), the `Idempotency-Key` echoed, nothing written — never 404 `NOT_FOUND`; a retry with the same key → 201 (POST) / `committed` (GET). 1 s → waits, then 201 / 200 |
| `cross-tenant-in-progress` (M9 follow-up, F-M9-3) | while org A's request for key K is in flight, an owner of org B calling `create_mcp_snapshot_idempotent` / `get_mcp_snapshot_request` with A's endpoint and K gets `P0002` NOT_FOUND in < 1 s (not `PT409` IN_PROGRESS after waiting on A's advisory lock); naming org A is `42501`; A is still in flight after the probes and then 201, exactly one snapshot; nothing written for B. Uses a persistent harness fixture (org `a3100000-…0b`, owner `…b1`) that the case upserts and never deletes (organizations are soft-deleted and the last owner cannot be removed) |

Every case also asserts: no 500, no idle-in-transaction sessions, no ungranted locks, contiguous versions, no
partial snapshots, one idempotency record per snapshot, no `40001` in the Postgres log.

## Known gap

The `database-tests` job runs but is **not yet a required status check** on
`main`. Adding it to branch protection is a repository-settings change; until it
is made, a red database suite does not block a merge.
