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
**Files:** <!-- database-tests-count:start -->`supabase/tests/database/*.sql` — 67 files<!-- database-tests-count:end -->, ~800 pgTAP assertions

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
| `workspace_conversations.test.sql` | Workspace conversations (migration 20261119100001): folders are owner-only under RLS, names are unique per owner case-insensitively, a thread can only be filed into the caller's own folder in the same org (composite FK), deleting a folder unfiles rather than deletes, `search_chat_threads` returns only the caller's own threads (title and message full-text search, plain-text snippets, cursor), another tenant and the org owner see nothing, and rename/archive/move/delete are audited |
| `workspace_conversation_cursor.test.sql` | conversation pagination (migration 20261120100007): the 7-argument `search_chat_threads` is replaced (not overloaded) and stays SECURITY INVOKER, anon/PUBLIC cannot execute it; keyset paging on (updated_at DESC, id DESC) with identical and microsecond-adjacent timestamps neither skips nor repeats rows, including page boundaries inside a tie group, exact-multiple and empty final pages, and combined with search, folder and archived filters; the legacy timestamp-only cursor keeps its old meaning; an id without a timestamp is `INVALID_CURSOR`; the limit is capped at 101; another member or tenant using the cursor sees only their own threads |
| `workspace_approval_requests.test.sql` | persistent approval requests (migration 20261119100002): creation requires the caller's own thread, an active endpoint and the newest approved snapshot, and is refused for read tools; identical pending requests are deduplicated; only owner/admin decide, and only the requester cancels; approve goes through Agent 2's `record_tool_approval` and is consumed by `claim_tool_approval` (used), revoke goes through `revoke_tool_approval`; history covers pending/approved/rejected/cancelled/expired/used/revoked and direct approvals; cross-tenant calls are refused; every transition, including the effective revoke, is audited |
| `workspace_files.test.sql` | workspace files (migration 20261119100003): no storage key/path/url column exists, the status machine is uploading→ready/failed only and content is immutable once ready, the 50 MB size CHECK holds, viewers cannot upload, private files are owner-only and organization files are member-readable, delete is owner (or admin for org files), attachments require the caller's own thread and a readable file, cross-tenant access is refused, and uploads/deletes/attachments are audited |
| `workspace_library.test.sql` | knowledge library (migration 20261119100004): private collections are owner-only (the org owner too sees nothing), organization collections are member-readable and only owner/admin create or publish them, viewers cannot write, chunks are written only by the document worker (`complete_document_job`; since 20261120100002 users cannot call `replace_document_chunks`) and are invisible across tenants, `search_knowledge` respects RLS and returns plain-text snippets, thread links require a readable collection and the caller's own thread, and lifecycle events are audited |
| `workspace_document_jobs.test.sql` | document processing and semantic retrieval (migrations 20261120100001-100002): worker functions and the job table are unreachable for users, users cannot choose a document status, adding a document enqueues a job, leases are exclusive and a stale token gets `LEASE_LOST`, embeddings must match chunks, retryable failures back off (30 s, doubling) and the last attempt goes to the dead-letter state, exhausted abandoned leases fail with `PROCESSING_ABANDONED`, hybrid search fuses keyword and vector ranks (RRF) and never compares vectors of another model or dimension, malformed vectors are rejected, other tenants and the org owner (private collection) retrieve nothing, reindex is writer-only, resets the job and is audited, and removing a document removes its embeddings and job |
| `workspace_rate_limits.test.sql` | workspace rate limits (migration 20261120100003): counters and policies are private, budgets are per action, organization and user, the call over the limit is refused with a retry-after, unknown actions and non-members are rejected (so outsiders cannot exhaust a tenant's budget), windows reset, and pruning is service_role only |
| `workspace_custom_agents.test.sql` | custom agents (migration 20261120100004): RLS forced, identity and version not client-writable, private agents owner-only (the org owner too), only owner/admin publish to the organization, viewers cannot create, members cannot edit agents they do not own, tool selection holds only `{capability, provider}` keys without duplicates, starters/instructions/names bounded, the version moves only on real changes, knowledge links need write access to the agent and read access to the collection (never across tenants), conversations can start only from a readable agent and survive its deletion, and agent operations are audited |
| `workspace_storage_maintenance.test.sql` | storage maintenance (migration 20261120100005): maintenance functions are service_role only, deleting a file queues its blob, stale uploads expire after a grace period with a 15 minute floor, deletions are leased and failed ones back off, the orphan check reports surviving file ids, the organization purge refuses live organizations and the grace period (7 day floor), deletes only that organization's workspace data, queues one prefix deletion, is audited once without per-row noise and is idempotent |
| `workspace_document_dedupe.test.sql` | one document per content per collection (migration 20261120100006, Q-8): the content hash is set by the database and cannot be supplied or changed by users, the in-request chunk writer stays closed to users, new documents start pending, a retry with the same file and a re-upload of the same bytes under a new file id are refused in the same collection, the same bytes in another collection or another tenant are independent, refused duplicates enqueue no processing jobs, and removing a document frees its slot so the same file can be added again |
| `workspace_agent_save.test.sql` | atomic custom-agent save (migration 20261120100008): SECURITY INVOKER with pinned search_path, anon/PUBLIC cannot execute; create with links; member org-publish 42501; unreadable, foreign, unknown collections INVALID_COLLECTION; >10 TOO_MANY_COLLECTIONS; NULL ids, identity keys, non-array starters rejected without leaving rows; partial update keeps absent fields and bumps version once; owner-only edits (org owner on a member's agent, org admin on an org agent, demoted owner: P0002); an org admin cannot link into someone else's agent (42501, since 20261120100009); hidden links (the owner linked a shared collection that was later made private) survive replace and clear; the 20-link cap still applies and a failed save rolls back fields, version and links; cross-tenant create and save rejected |
| `workspace_agent_owner_edit.test.sql` | owner-only agent editing and atomic single links (migration 20261120100009): can_edit_agent is SECURITY DEFINER and link_custom_agent_collection SECURITY INVOKER, both with pinned search_path; anon/PUBLIC cannot execute; the org owner cannot rewrite an admin's agent and an admin cannot rewrite, link into or unlink from the org owner's agent, while an owner edits their own; the link function: true then false (idempotent), linked_by is the caller, unreadable / foreign collection COLLECTION_NOT_FOUND, foreign agent or wrong organization id AGENT_NOT_FOUND, the 11th visible link TOO_MANY_COLLECTIONS, re-linking at the limit is a no-op, hidden links do not count toward 10 but are kept, viewers / demoted owners / no user refused; admins can still delete an organization agent (links cascade) |
| `workspace_message_citations.test.sql` | persisted chat citations (migration 20261120100010): `chat_messages.citations` (jsonb, default `[]`) and `knowledge_unavailable` (default false) are NOT NULL; the validator `private.valid_message_citations` is IMMUTABLE, SECURITY INVOKER with pinned search_path, not executable by anon/PUBLIC; a valid assistant message round-trips exactly; plain messages keep the defaults; 14 malformed shapes (extra/missing key, non-canonical or non-uuid ids, n < 1 or non-integer, non-integer ordinal, snippet > 2000, empty title, > 20 entries, object instead of array, scalar elements) fail the CHECK with 23514, not a runtime error; user and tool messages cannot carry citations or knowledge_unavailable; `authenticated` still has no UPDATE (42501); another member of the same org cannot read the messages or find the thread by `agent_id`; another tenant can neither read nor insert; the owner reads `agent_id` |

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

## Known gap

The `database-tests` job runs but is **not yet a required status check** on
`main`. Adding it to branch protection is a repository-settings change; until it
is made, a red database suite does not block a merge.
