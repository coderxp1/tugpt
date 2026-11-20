# Authorization remediation review package

**Status: isolated candidate only. Production deployment and sign-off are NOT approved.**

Base: `38622a8` (`feat/public-login-handoff`). Candidate branch: `fix/production-authorization-review`.
The website, live Dashboard, staging, DNS, Auth configuration, and reserved `supabase_admin` role are outside this change. No push, merge, deployment, or live-service restart was performed.

## Exact migration order

1. `supabase/migrations/20261102000001_membership_authorization.sql` - F1: remove browser membership DML; add checked management and ownership-transfer RPCs, an organization-level serialization row, immutable membership identity, and last-owner protection.
2. `supabase/migrations/20261102000002_invitation_identity.sql` - F2: accept invitations against verified, nondeleted `auth.users.email`, not mutable profile email; preserve display-name/avatar/locale updates through column grants. The migration checks required Auth columns/access without reading user rows.
3. `supabase/migrations/20261102000003_audit_assignment_integrity.sql` - F3/F4: remove browser audit writes; reserve conversation assignment for the existing compare-and-set RPC; enforce assignee membership at the table and acquire the membership guard before the conversation row lock.
4. `supabase/migrations/20261102000004_browser_privilege_cleanup.sql` - remove MAINTAIN on 15 exact relations from anon/authenticated; remove PUBLIC/anon EXECUTE from seven exact mutation signatures; remove redundant browser/PUBLIC nonce privileges. Service access remains.

Every migration is transactional, with a 5-second lock timeout and 60-second statement timeout. Across four files they are four transactions, NOT an atomic release. Complete all preflight checks first; if a file fails, stop and inspect which transactions committed rather than blindly rerunning the chain. New object names must be unused. Migrations assume the reviewed postgres-owned application objects and PostgreSQL 17+.

`optional_future_defaults.sql` is a SEPARATE proposal, not one of the required four migrations. It removes broad postgres-created future-object browser grants and global PUBLIC function execution defaults while retaining service defaults. Its probe test ran and rolled back. It does not modify the reserved role or that role's defaults; those remain a platform-specific limitation.

## Compatibility contract

- Membership readers are unchanged. Browser direct INSERT/UPDATE/DELETE is deliberately no longer supported, even for owners. Use authenticated `manage_organization_member(p_organization_id,p_user_id,p_action,p_role)` with actions `add`, `set_role`, or `remove`. Add requires an existing profile; role is required for add/set_role. Admins cannot manage existing owners or assign owner. Members may remove themselves except the last owner. Owner management remains available.
- Use authenticated `transfer_organization_ownership(p_organization_id,p_new_owner_id)` for atomic transfer to another existing member. It promotes the recipient and demotes the caller to admin; existing additional owners remain owners. Both new RPCs derive the actor from `auth.uid()`, not client-supplied audit fields. Service callers must supply an authenticated actor to these user-oriented RPCs; bare service credentials do not create an actor.
- TypeScript database RPC definitions are included. No new membership UI was invented. No direct membership write was found in the inspected application client code; external clients/integrations were not available and must be reviewed before deployment.
- Invitation tokens/status/expiry/replay behavior remain; verified Auth email must match. Unverified/phone-only users need a verified account email. Stale profile email no longer controls acceptance. Error `P3D10` maps to HTTP 403 / `VERIFIED_EMAIL_REQUIRED`, with English/Spanish text and a route test. No email-provider, Auth policy, or callback setting was changed.
- Profile UPDATE is limited to `full_name`, `avatar_url`, `preferred_locale`. Clients sending full profile objects (including email/id/timestamps/deleted_at) must send a narrow update instead. Email changes must use the existing trusted Auth workflow; end-to-end Auth-provider behavior was not tested here.
- Browser audit writes are deliberately rejected. Security audit events must come from trusted server/definer operations. Historical logs are not repaired or retroactively authenticated.
- Use existing `assign_conversation` for assignment/unassignment, including the expected previous assignee. Ordinary allowed conversation creation/editing remains. Direct `assigned_to` INSERT/UPDATE, full-row writes containing it, and organization reassignment are rejected. Membership removal through the new RPC clears assignments and emits unassign events. Trusted direct membership deletion should use this RPC or equivalent coordinated cleanup; this candidate does not claim to constrain a privileged operator who can bypass/disable database controls.
- Concurrent stale operations fail closed. Clients should refresh/retry appropriately for domain conflicts and retry complete transactions on SQLSTATE 40001/40P01 where applicable; never blindly retry a stale compare-and-set value. Domain conflicts must not use 40001/40P01: PostgREST automatically re-runs transactions that fail with those codes, so a deterministic conflict loops until the request JWT expires. Use a `PTxyz` code (for example `PT409` in `create_mcp_snapshot`), which PostgREST maps to HTTP xyz and never retries. Tested user-facing RPC lock order avoided removal/assignment deadlocks.
- A database wait that a route must report (lock_timeout, statement_timeout inside an RPC) must end before the app stops waiting for PostgREST: at most `POSTGREST_REQUEST_TIMEOUT_MS` (5 s, `apps/web/src/lib/supabase/timeouts.ts`) minus `DB_LOCK_BUDGET_MARGIN_MS` (2 s). Otherwise the app aborts first, sees only a transport error, and the route answers 500 while the database may still commit (Agent 1, M4 re-test). `create_mcp_snapshot` uses `lock_timeout=2s`; a transport timeout is reported as 503 `DATABASE_TIMEOUT`, never 500.
- Writes whose outcome a client cannot otherwise learn after a timeout must be idempotent (M9). `POST …/snapshot` requires an `Idempotency-Key`; `create_mcp_snapshot_idempotent` (migration `20261120000006`) stores it with the snapshot in one transaction (`UNIQUE (endpoint_id, idempotency_key)`), returns the original on replay, answers `PT409` while the same key is running, and rolls back a write that runs past its deadline (now + `SNAPSHOT_WRITE_DEADLINE_MS` = 3 s from the app, capped at statement start + 3 s in the database, checked as the last step). Bound: a snapshot only commits if its body finished at least 2 s before the app's 5 s timeout; the residual window (commit + response delivery > 2 s, app/DB clock skew, PostgREST pool wait before the statement starts, which shortens rather than extends the window) can still produce "committed but the app reported a timeout", and that case is recovered by the replay, never duplicated. The idempotency table has RLS on, no policies and no direct grants; both functions re-check the caller's owner/admin role per organization. The old keyless `create_mcp_snapshot` is revoked from PUBLIC, `anon`, `authenticated` and `service_role` by migration `20261120000007` (no app caller remains: `repo.createSnapshot` was removed); it stays defined, marked DEPRECATED, so deployed code that still called it fails closed with `42501` instead of writing an unkeyed snapshot. The same migration checks endpoint ownership before the per-key advisory lock, so another tenant using the same endpoint id and key gets `P0002` at once instead of waiting and learning `PT409` IN_PROGRESS.
- An endpoint lookup failure is not "not found" (M9 follow-up, F-M9-1). `getEndpointUrl` returns `null` only for a missing or foreign endpoint; a PostgREST/transport/lock failure throws (`42501` → 403 `FORBIDDEN`, anything else → 503 `DATABASE_TIMEOUT` with `retry-after: 2`) in snapshot POST/GET and in delete/activate/deactivate, so a client never discards a retryable request or its `Idempotency-Key` because of a transient 404. `get_mcp_endpoint_url` has `lock_timeout=2s` so a locked endpoint row ends inside the app's 5 s budget.
- PostgREST reads must not be retried after our own timeout: `AbortSignal.timeout` rejects with `TimeoutError`, which postgrest-js 2.112.3 retries 3× on GET (1/2/4 s back-off, a fresh 5 s each), so one read could take ~27 s. `asNonRetryableTimeout` (`apps/web/src/lib/supabase/timeouts.ts`) rethrows it as an `AbortError` in both server PostgREST clients, bounding every read at 5 s.
- Anonymous mutation calls now fail at the privilege boundary, before lookup/row-lock logic. Authenticated EXECUTE remains on all seven cleaned RPCs. No PostgREST runtime was present, so real HTTP schema-cache/discovery behavior remains an acceptance gate.

## Test evidence

All SQL tests used synthetic users/organizations in PostgreSQL 17.6, image `supabase/postgres:17.6.1.178`, repository digest `sha256:c282d393ae56fd165b7ada2ddbac55e582a601b86f3840aa2bbc112e43d3a570`. Container networking was `none`, no ports were published, storage was tmpfs, with 2 CPU / 2 GiB limits.

- Four baseline vulnerabilities reproduced: 4/4. Selected original function definitions and 22 affected relation/RPC ACLs matched the supplied production export; this is not a full production clone.
- Candidate security checks: 69/69, including legitimate workflows, denial cases, tenant isolation, nonce defaults/uniqueness, and privilege cleanup.
- Overlapping-session tests: 30/30, with lock waits observed. Last-owner races covered READ COMMITTED, REPEATABLE READ, SERIALIZABLE; other races covered transfer, invitation replay, actor revocation, assignment CAS, and assignment/removal ordering. Higher isolation correctly produced retryable serialization errors.
- Original DB baseline: 44/46 suites, 1,154 passing assertions and two failures. Candidate with explicitly updated contracts/verified fixtures: 44/46 suites, 1,156 passing assertions and the SAME two failures. The untouched-original candidate run is retained to show the intentional contract differences, not hide them.
- Residual DB failures: appointment_requests test P3 expects no service-role DELETE but the reviewed baseline grants it; transcription_worker_rpcs V1 lease-extension assertion fails while its requested-seconds check passes. Neither was changed as part of these authorization fixes.
- Web: 46/46 suites, 640/640 tests. Web build and typecheck pass. All workspace typecheck/build dependencies: 20 successful tasks. Web lint: zero errors, two pre-existing warnings.
- Full application test aggregation: 1,726 pass, one inherited failure in `no-dead-domain.test.ts`. The scanner flags unchanged prohibited-domain literals in auth/cookie denial code and tests. No authentication behavior was changed to silence it. Full CI is therefore NOT green.
- Rollback: 344/344 catalog checks restore original public/private functions, table ACLs, and original owner trigger; candidate column grants/guard objects disappear. Original vulnerabilities reproduce again after rollback, as expected. Reapplication passes 69/69.
- Optional future-default probes pass and are rolled back. Supplemental inventory SQL parses/runs read-only on the disposable DB only.

The image has a legacy Auth skeleton, not a running GoTrue deployment. `disposable-auth-fixture.sql` adds fixture columns and production-equivalent auth claim helpers. A minimal `storage.buckets` fixture and a migration-ledger fixture were needed for repository migrations/tests. This is NOT browser E2E, hosted Auth/Storage, email delivery, Realtime, provider integration, or HTTP Data API validation. No real identities, production data, or production credentials were copied. The disposable container has now been stopped and removed; no exact-name container remains. Its tmpfs databases were discarded; the isolated worktree and evidence remain.

## Running the supplied test tools

These commands require the named disposable container and the matching isolated worktree, not a database URL:

```sh
python3 security-review/run_security_tests.py baseline
python3 security-review/run_regressions.py baseline
# Apply only the four candidate files to the named isolated database.
python3 security-review/run_security_tests.py post
python3 security-review/run_regressions.py candidate-updated-tests
# security_concurrency is a disposable template clone of the candidate database.
python3 security-review/run_concurrency_tests.py
```

The baseline must use the original files from base commit `38622a8`, not the updated contract tests. Preserve baseline evidence before candidate test changes. The fixture files document local bootstrap adaptations and MUST NOT be applied to production. Detailed execution and preliminary bootstrap failures are retained in `evidence/`; final result JSON/logs identify the completed runs.

## Production inventory: still blocked

Run `production_supplemental_inventory.sql` in the intended hosted project, `rbiumegrwtavmljxbknp`, and return the JSON export. It uses a READ ONLY transaction and metadata SELECTs, not application functions, sequence advancement, grants, or object changes. It covers existing sequences/privileges/dependencies, extension-owned functions, event-trigger registrations/functions, allowlisted database/role API settings, Auth column/access preflight, current table/column ACLs, and candidate-name collisions.

Also provide a redacted view/export of the actual Data API enabled state, exposed schemas, extra search path and pre-request hooks/runtime overrides. SQL-session settings do not establish external PostgREST runtime configuration. Do not send API keys, JWT secrets, passwords, or user records. These production facts remain UNVERIFIED; the supplied earlier exports did not contain them and no live production SQL connector was available.

Do not move/drop `btree_gist` or alter extension-owned functions under this approval. Do not change `supabase_admin`. Before production approval, review outstanding inventory, drift, external-client compatibility, existing invalid assignments/ownerless organizations through separately agreed read-only checks, and residual test failures. Existing compromised roles or forged historical logs require separate investigation; these migrations prevent future browser paths, not historical data repair.

## Rollback procedure - approval required

1. Prefer a forward corrective migration. Full rollback reopens all four reviewed vulnerabilities and broad browser privileges. Obtain explicit owner approval and an approved access-containment plan first.
2. Verify target project, migration ledger, object ownership/ACL drift, backups/PITR, and the exact applied candidate checksums. Do not overwrite later legitimate schema changes using an old snapshot.
3. `rollback/restore_reviewed_baseline.sql` is the tested full reverse SQL for this exact candidate. It restores original function bodies and exact reviewed browser grants, removes new triggers/RPCs/guard table, and removes newly added column grants. It does not grant blanket ALL to browser roles and does not change reserved roles/defaults.
4. Execute through the agreed deployment mechanism only after approval. Keep migration history auditable: if using migration-managed deployment, package the reverse SQL as an approved forward rollback migration rather than silently deleting ledger rows.
5. Verify catalog/ACL comparison and legitimate workflows. Never run the synthetic seed/exploit scripts on production. Restoring baseline behavior intentionally makes F1-F4 possible again, so containment is mandatory.
6. Rollback does not reverse legitimate membership/ownership changes or audit/event records made after deployment. It is schema/authorization rollback, not data recovery. The optional defaults proposal is independent and is not covered by this reverse script.

## Approval gate

**STOP. No production execution is authorized by this package.** Complete the missing read-only inventory and acceptance/compatibility review, resolve or explicitly disposition residual failures, then obtain explicit approval for the exact migration checksums and deployment/rollback plan. The live Dashboard remains on self-hosted staging; this package does not authorize a production cutover.
