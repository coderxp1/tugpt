# Migration integrity (forward-only policy)

Applied migrations are **immutable**. Once a migration has shipped to any
environment, its file must never change. A correction to an applied migration
is itself a new migration with a new id.

## Rules

1. Corrections use a **new migration id** (never edit, rename or delete an existing file).
2. A new migration's 14-digit version must sort **after** the newest migration on the target branch.
   If the target moved while your branch was open, renumber your (unmerged) migration.
3. Record a new migration with `node scripts/update-migration-checksums.cjs`. It only **adds**
   entries; it refuses (exit 1) to re-record an edited migration or to drop the entry of a deleted one.
   To correct your *own, not yet merged* migration: edit it, delete its line from `checksums.json`,
   re-run the script. Anything already on the target branch is immutable.
4. `checksums.json` is canonical: keys sorted, 2-space indent, trailing newline, raw-byte SHA-256.

## How it is enforced

One implementation, `scripts/migration-integrity.cjs` (Node, no dependencies), with three layers:

| Layer | Command | Catches | Where it runs |
|---|---|---|---|
| Consistency | `verify` | missing entry, hash mismatch, **orphan entry** (file deleted, entry kept), duplicate keys, bad names, duplicate versions, non-canonical manifest | `apps/worker/tests/migration-integrity.test.ts` (every `pnpm test`) |
| Immutability | `verify --base <merge-base>` | **deleted / renamed / modified** migration vs the merge base (byte comparison against the git blob), **manifest entry changed or removed** (the edit-and-rehash bypass), **out-of-order** new versions | CI job `migration-integrity` |
| History | `verify --history` | any commit from the anchor to the base that deleted, modified or renamed a migration, or changed/removed a manifest entry (a tampered base, e.g. a direct push) | CI job `migration-integrity`; the worker test when the clone has full history |

Why a manifest alone is not enough: it lives in the same repository as the files it protects, so it
proves only that the two agree. Editing a migration and recomputing its checksum in the same change,
or deleting a file together with its entry, passes it. Layers 2 and 3 compare against git instead.

Exit codes: `0` verified, `1` violations, `2` **cannot verify** (shallow clone, unknown base, anchor
missing or not an ancestor, base with no migrations, unreadable manifest). `2` is never a pass.

**Anchor.** History is walked from `b1470098ac6da095c7e04742659d5912dc9c2793` (b147009, "F-3
migration integrity"), the commit that introduced `checksums.json`. The anchor is a constant in the
script; `MIGRATION_INTEGRITY_ANCHOR` overrides it **for the tool's own tests only** (temporary
repositories). CI refuses to run if it is set, and `migration-integrity-ci.test.ts` asserts nothing
under `.github/` sets it.

**Bootstrap.** The first pull request that brings the manifest to a branch has a merge base from
before the anchor. That case alone is accepted: the base must be a strict ancestor of the anchor and
contain no manifest. The immutability layer still byte-compares every migration on that base. Any
other non-ancestry fails closed. Today both `feat/product-control-center` (merge base `e82dcec`) and
`main` (`7114ffb`) are pre-anchor, and verify clean in this mode: none of their migrations changed.

**CI.** `.github/workflows/ci.yml` job `migration-integrity` checks out with `fetch-depth: 0` and
`persist-credentials: false`, and runs `.github/scripts/migration-integrity-ci.sh`. Event refs are
passed only through `env:`. On `pull_request` it uses `pull_request.base.sha`, on `push`
`event.before`; it computes the merge base with HEAD and runs `verify --base <merge-base> --history`.
An empty, malformed (not 40 lowercase hex), all-zero (pull request) or unknown base is exit 2. The
first push of a branch (all-zero `before`) verifies full history from the anchor.

**Review.** `.github/CODEOWNERS` assigns `@coderxp1` to `supabase/migrations/`, the manifest, both
scripts, the three integrity tests, this document and all of `.github/` (whoever can edit CI can
switch the check off).

### Not enforced until an admin acts

Verified on 2026-11-19 with the GitHub API: `feat/product-control-center` has **no branch
protection** (`protected: false`, no required checks). Until a repository admin:

1. adds a branch protection rule or ruleset on the target branches with **"Require a pull request
   before merging"**, **"Require review from Code Owners"** and **"Do not allow bypassing"**;
2. makes **`migration-integrity`** (and the other CI jobs) **required status checks**;

the job and CODEOWNERS only advise, and a direct push skips both. The history layer then catches the
tampering on the next pull request, but does not prevent it.

Caveat: every pull request so far is opened by `coderxp1`, the only code owner. GitHub does not count
an author's approval of their own pull request, so "Require review from Code Owners" will block those
merges unless a second owner (e.g. a team) is added. That is a staffing decision, not a code change.

## Known pre-policy history (cannot be fixed retroactively)

Before the anchor, applied migrations were edited in place: **24 commits**. Git history is not
rewritten, and the files are not reverted (reverting would itself be an edit). What that means:

- **19 commits** are already part of the default branch's history (before `e82dcec`): `294a4b4`,
  `f33f4b4`, `290bd2b`, `8587a1e`, `a1c7fe2`, `ed86748`, `946f8b9`, `9e00016`, `07a90ae`,
  `8c8c06e`, `d6810c8`, `0f1c0a6`, `856a5e6`, `dcfe72c`, `97a23a1`, `9cb7cb2`, `c116895`,
  `864a9ef`, `b1e4067` (2026-07-18 .. 2026-10-22).
- **5 commits** are on the integration line after `e82dcec` and touch migrations that are **not on
  the default branch**:

| Commit | Migration edited in place |
|---|---|
| `31b3494` | `20261102000004_browser_privilege_cleanup.sql` |
| `4396b48` | `20261115000004_mcp_capabilities.sql` |
| `287da3d` | `20261115000005_tool_approvals.sql` |
| `6cc944d` | `20261115000015_policy_recursion_fix.sql` |
| `c2438e8` | `20261115000016_outcome_not_null.sql` |

**Drift risk.** Any database that applied an *earlier* version of one of these files (the shared
preview database, developer databases, any environment deployed from an integration branch) records
the version as applied and will **not** re-run the new content. Its schema can differ from a fresh
build. For each such environment, run a schema diff against a fresh database built from these
migrations and reconcile with a new forward migration, using the recovery order below. A fresh build
(CI, new environments) is unaffected. `verify --base 16a77c6` reproduces two of these edits as
`MODIFIED_MIGRATION`.

## Cross-branch ordering hazard (open)

`feat/workspace-backend-agent4` adds `20261119100001`..`20261119100004` and
`20261120100001`..`20261120100004`; `agent2/m4-snapshot-egress` adds `20261120000001` and
`20261120000002`. The two sets interleave. Whichever branch merges second fails `OUT_OF_ORDER`
and must renumber its unmerged migrations above the other's newest version, then re-run
`update-migration-checksums.cjs`. That is the intended behaviour, not a reason to relax the check.

## Upgrading environments with divergent histories

If an environment has been partially migrated out-of-band (e.g. applied via
`psql` rather than the migration tool) and its `supabase_migrations` history is
out of sync with the files on disk, do **not** reset or hand-edit history.
Recovery order:

1. Take a full `pg_dump` backup and verify it restores.
2. Run a schema diff between the live schema and the migrations to confirm the
   schema matches the intended end state.
3. Reconcile history only with the migration tool (`supabase migration repair
   --status applied <version>`), never by hand-inserting rows.
4. Re-run the schema diff to confirm no drift.

Never delete audit or approval rows to make a constraint pass; map invalid
legacy rows to a documented value in a new migration, or leave them for manual
review behind a `NOT VALID` constraint.

## Recorded renumbering: B-2 (MCP vs Workspace version collision)

The M9 follow-up migration `20261120200001_mcp_snapshot_legacy_revoke_owner_first.sql` (Agent 2,
never merged or deployed) collided with the Workspace migration
`20261120200001_workspace_agent_instructions_confidential.sql` (Agent 4). Under rule 2 it was renumbered
to `20261120000007_mcp_snapshot_legacy_revoke_owner_first.sql`. The SQL is byte-identical
(sha256 `b476315003d05b2d3a2cc9786ea7989ed47a95fe8ed9d12824d3bb7b55f4edd5`), so its header comment and the
`COMMENT ON FUNCTION` text it stores still name the old id; only the file name and the manifest key changed.

Combined order with the Workspace series: `20261119100001-100004` (Workspace),
`20261120000001-000007` (MCP), `20261120100001-100011` and `20261120200001-200003` (Workspace).

The rename commit deletes a file that earlier commits on the same branch added. `verify --history` treats
any deletion as a violation, so that commit must not reach a protected branch's history: land the branch
by squash merge, or use the equivalent branch whose history creates the migration as `20261120000007` from
the start (same final tree). Agent 2 applied the old file name only to its own disposable harness databases; it was never merged or
deployed. Any other database that recorded version `20261120200001` for this file must be checked before the
Workspace migration of that version is applied there.
