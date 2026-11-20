# Workspace customer-flow demonstration

## What the demonstration proves

A real browser creates a private collection, uploads a text file, runs the existing
knowledge worker against that uploaded blob, sees Ready, saves a private agent
with a chosen model and collection, starts a chat from the agent card, receives a
streaming reply with a real retrieved source, and reopens the persisted conversation.
Separate browser checks search the indexed text, edit the agent, and check manager
and viewer permissions. Authenticated API checks download the original file and
deny another user's access. No search chunks are manually inserted.

## Explicit limitations

- This is an isolated localhost demonstration, not a public customer deployment.
- Login uses synthetic test SSO sessions, not external provider consent/handoff.
- Model output is a deterministic local fixture, visibly labeled simulated. It
  does not prove model quality or provider availability. Only one model endpoint
  is configured; multi-provider switching is not claimed demonstrated.
- The existing knowledge worker is invoked as a batch by the harness. Text
  extraction and keyword indexing are real; embeddings are not configured.
- No real integration tools, OAuth, WhatsApp or paid providers are invoked.
- This branch builds on the preserved F-4/frontend candidate. Agent 1/5 still own
  Q-9c compatibility/security integration and the shared staging deployment.
- Mobile restored-agent accessible identity works, but the visible composer label
  remains hidden below 640px. This is a known remaining UI improvement.

## This cycle's implementation

The hardcoded custom-agent UI gate is now an explicit, default-off **staging build**
opt-in. Both `NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER=staging` and
`NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS=true` must be set. Other values fail closed.
These settings are build-time values, not browser storage or URL switches; changing
one requires rebuilding. Turbo hashes both so enabled/disabled builds do not share
cache entries. This is not authorization: authenticated API guards and RLS still
apply. Existing accepted branches and production settings are untouched.

Updated English/Spanish agent introduction copy and added fail-closed gate tests.
Committed browser/worker-batch demonstration scripts provide a repeatable flow.
A cold test run exposed an omitted F-4 SQL test inventory entry; corrected it on
this branch and included the SQL test directory and inventory doc in Turbo cache
inputs. Earlier cached full-suite passes did not catch that documentation omission.

## Reproduce the isolated demonstration on the existing VPS

Prerequisites already provisioned only for this demo:
- Worktree `/srv/tugpt-workspace/ws-agent3-delivery`.
- Environment `/srv/tugpt-workspace/ws-agent3-delivery-env` (restricted secrets,
  synthetic sessions, local blob store; do not copy this directory into evidence).
- PostgreSQL `tugpt-a3delivery-pg-validation`, PostgREST
  `tugpt-a3delivery-rest-validation` and `tugpt-a3delivery-browser-rest`.
- Chromium and Playwright installed under the paths in the scripts.

If the isolated containers have been stopped, start only these three:

```bash
docker start tugpt-a3delivery-pg-validation tugpt-a3delivery-rest-validation tugpt-a3delivery-browser-rest
```

Build the opt-in frontend (stop this demo's web process before rebuilding):

```bash
cd /srv/tugpt-workspace/ws-agent3-delivery
pnpm install --offline --frozen-lockfile --ignore-scripts
NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER=staging NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS=true pnpm exec turbo build
```

The web and model processes are left running for review, bound to localhost. If
stopped, run these in separate terminals; do not start duplicates on occupied ports:

```bash
/srv/tugpt-workspace/ws-agent3-delivery-env/run-web.sh
node /srv/tugpt-workspace/ws-agent3-delivery-env/llm.cjs
```

Run the actual customer interaction sequence:

```bash
cd /srv/tugpt-workspace/ws-agent3-delivery
node scripts/workspace-demo/browser.cjs
node scripts/workspace-demo/customer-checks.cjs
```

Each browser run creates uniquely named synthetic records. The checks intentionally
change only Clara's membership in this disposable DB, restoring her role afterward.
Outputs: `/srv/tugpt-workspace/ws-agent3-delivery-evidence`. No secrets or browser
storage-state files are included in the exported evidence bundle.

For a manual walkthrough in an authenticated review browser, use
`https://localhost:3609/workspace`: Library -> New collection -> upload text;
Agents -> Create agent -> select TuGPT Scout and the collection -> Create agent;
Start a chat -> ask about shipping -> expand Sources -> reload/reopen. The browser
harness installs the synthetic session automatically. For a human-accessible shared
staging URL and real login, use Agent 5's environment rather than exposing this
local harness or distributing its session cookies.

## Next customer-facing milestone and dependencies

Agent 3: improve visible mobile agent identity and demonstrate the same journey on
Agent 5's authenticated shared staging instance. Agent 5 must supply its staging
URL and provision a test-user login. A real model endpoint/model ID (and credential
installed server-side, if required) is needed to replace the simulated response;
no credentials should be pasted into chat. Agent 4 owns any API/worker defects
found there. Agent 2 owns all real-provider integration work.
