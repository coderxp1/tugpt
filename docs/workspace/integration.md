# Integration path: Workspace UI (Agent 3) + Workspace backend (Agent 4)

Nothing here has been merged or pushed. This is the exact base and the order in which to
integrate once the backend fixes are accepted.

## Exact base

| Ref | Commit | What |
|---|---|---|
| Base | `b1470098ac6da095c7e04742659d5912dc9c2793` (`b147009`) | `integration/connect-fix4`: "fix(connect): F-1 … F-4". Also the base of `feat/workspace-backend-agent4` |
| Cherry-pick 1 | `30d7001` ← `c002302` from `feat/workspace-shell` | Phase 1 Workspace shell at /workspace |
| Cherry-pick 2 | `c10ab66` ← `51d0b27` from `feat/workspace-shell` | Focus moves into the mobile drawer |
| Agent 3 | `447f2a2`, `3eedecf`, `9b9654f`, then the commit that adds this file | Workspace frontend, touch targets, link-colour fix, this milestone |

`feat/workspace-shell` therefore must **not** be merged separately on top of this branch: its two
commits are already here (as cherry-picks with different SHAs). Merging it would only produce
empty or duplicate changes.

## Order

1. Accept `agent2/connect-hardening` / `integration/connect-fix4` (= `b147009`) as usual.
2. Merge `feat/workspace-backend-agent4` (Agent 4, migrations `20261201*`).
3. Merge `feat/workspace-agent3` (this branch).

Steps 2 and 3 are independent: `git merge-tree --write-tree feat/workspace-agent3 feat/workspace-backend-agent4`
completed with **no conflicts** at `9b9654f` × `710f8a6`. The only overlap is
`apps/web/src/lib/workspace-data/{contracts,errors}.ts`, which this branch vendors byte for byte
from `710f8a6`, so git sees identical additions on both sides.

If Agent 4 changes the contract before merging, re-vendor:

```bash
git show feat/workspace-backend-agent4:apps/web/src/lib/workspace-data/contracts.ts > apps/web/src/lib/workspace-data/contracts.ts
git show feat/workspace-backend-agent4:apps/web/src/lib/workspace-data/errors.ts   > apps/web/src/lib/workspace-data/errors.ts
pnpm --filter web typecheck   # every UI call site is typed against the client
```

## Verify after merging

```bash
pnpm turbo run typecheck lint test build --force --concurrency=3
```

Then, against a database with Agent 4's migrations and `TUGPT_FILE_STORAGE` set:

1. Sidebar shows **Folders**; create one, move a chat into it, archive with Undo, delete with confirmation.
2. Type in search: results include message matches with an excerpt; the note says "Searching all your chats".
3. Attach a PDF in the composer: chip goes Uploading → size; Send waits; after sending, "Files in this chat" lists it with a download link.
4. Library → New collection → upload a `.docx` (Queued → Ready, passages count) and a `.pdf` ("Not indexed", PDF note); search finds the `.docx` text.
5. Approvals appears in the nav for owner/admin with a pending count; approve with a 15-minute validity after the confirmation dialog.
6. Without Agent 4's backend (this branch alone), each of the above shows "not available in this workspace yet" and chat, streaming and the Dashboard work as before.

The Playwright acceptance script used for evidence (`accept-agent3.cjs`) checks the base
behaviour. The integration screenshots come from a local, never-pushed merge of both branches
against a disposable database.
