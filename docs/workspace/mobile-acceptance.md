# Workspace mobile identity and customer-flow acceptance

Branch: feat/agent3-mobile-workspace-flow. Base: f3bd517dc1b56682b6bd700d4b5ba62b97e1b5db.

## Changes
The full selected agent name is always visible above the composer, wraps on narrow screens, and is announced politely when it changes. Requested custom agents show loading/unavailable identity instead of briefly claiming to be the built-in assistant. Rejected messages with restored drafts offer an explicit Send draft again action (English and Spanish); no automatic resend or partial-stream regeneration.

## Evidence
91 browser assertions passed: main flow 66, lifecycle 12, permissions/search 13. At widths 360, 390, 768 and 1440, the full identity is visible without horizontal overflow, including after leaving/reopening and refreshing. Two assistant messages and two citation sections persist.

The demonstration covers normal chat and the backend-configured Scout model; collection creation, text upload and actual worker indexing; agent creation/model/knowledge selection; two cited turns; persisted identity/history/sources; text attachment and rejected-draft resend; conversation search/rename/archive/restore/delete; agent instructions/name edits and knowledge unlink/relink; search, authorized original-file download and second-user denial. Private-agent UI sharing controls were checked for owner/admin/manager/agent/viewer; viewer forged edits were rejected by the API. This is not exhaustive organization-agent moderation acceptance.

Latest lint/typecheck/test gate: 57/57 tasks passed, 55 cached. Web build passed. An earlier Dashboard DraftReviewUi stale-version assertion failed once; it passed in isolation and on the subsequent full run without source changes. Earlier failed logs are preserved separately; this does not prove the test is non-flaky. Existing lint warnings remain.

## Reproduction on the existing isolated VPS environment
Use only the already provisioned disposable delivery environment. Do not copy secrets into evidence or provision new credentials. Local HTTPS frontend: port 3619; this is not a shared staging URL. The previous port 3609 demonstration remains separate.

Build from /srv/tugpt-workspace/ws-agent3-mobile with NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER=staging and NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS=true using pnpm --filter web build. The existing restricted run-web.sh in the mobile evidence directory supplies server configuration.

Run sequentially from the worktree:

```sh
node scripts/workspace-demo/browser.cjs
node scripts/workspace-demo/lifecycle.cjs
node scripts/workspace-demo/customer-checks.cjs
pnpm exec turbo lint typecheck test --concurrency=2
```

The first script creates uniquely named test resources. The lifecycle script deletes only its newly created normal conversation; rerun the first script before rerunning lifecycle. Permission checks temporarily change only the disposable Clara membership and restore it to agent. Scripts require the existing Playwright/Chromium, local services, worker harness and restricted synthetic session files; they are not a standalone production installer.

Evidence directory: /srv/tugpt-workspace/ws-agent3-mobile-evidence. Results: demo-results.json, lifecycle-results.json and customer-checks.json. Screenshots: identity-360.jpg, identity-390.jpg, identity-768.jpg and identity-1440.jpg.

## Limits and dependencies
Model output is explicitly simulated. Storage, keyword indexing, API authorization, retrieval and citations are real within the disposable environment. The retry test injects one HTTP 503; recovery uses the actual API and simulated model. Authentication uses pre-existing synthetic sessions, not external SSO. Only one configured model was available; multi-provider switching and embeddings remain unverified/unconfigured.

Agent 5 was requested, through agent3-handoffs/agent5-workspace-staging-dependencies.md, to provide shared staging URL, provisioned test-user access (including a second user), and approved real model endpoint/model ID with credentials installed server-side. No acknowledgment is claimed.

Remaining product work includes safe recovery/regeneration after accepted partial streams, broader document-format and standalone file-management acceptance, and full mobile CRUD coverage beyond the identity/chat persistence checks. This is not a declaration of full product completion.

No backend source changes, migrations, production changes, paid services, push, merge or deployment were performed for this follow-up. Prior accepted branches and evidence remain preserved.
