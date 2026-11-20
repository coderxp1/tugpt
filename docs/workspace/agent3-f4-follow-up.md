# Agent 3: F-4 and Workspace follow-up

## Review boundaries

Accepted Q-9b baseline: `e28868741c6b48a26244e79569fa402d5c78942e`.
F-4 only: `fix/agent3-f4-permissions`, `af46cfb44944067ea6b451545947e15779d032ab`.
Frontend follow-up: `feat/agent3-workspace-preview-ux`, directly on F-4.
No migration or release-gate change; no push, merge, deployment, or customer execution.

## F-4 contract

`canEdit` describes an owner save preserving current visibility. A manager/agent
can edit their private agent, not retain organization visibility on an ordinary
save. API flags and PATCH checks now match existing RLS. Explicit non-viewer
owner privatization remains supported; ownership and admin moderation deletion
are unchanged. Knowledge-link authorization remains separately governed by its
existing ownership/non-viewer policy. Instructions are redacted when canEdit is false.

## Completed frontend follow-up

Removed the inaccurate claim that the builder adapter is incompatible with the
API. A successfully loaded catalogue now explains the closed release gate,
including when custom-agent cards are present. Empty-list copy is neutral, so an
enabled catalogue is not described as an unsavable preview. English and Spanish
copy and regression tests cover this. Preview submission remains blocked.

## Independent verification

- F-4 targeted tests: 75 passed; full hermetic tests: 2,732 passed, 52 opt-in skipped.
- Real PostgREST integration suite: 52 passed (including the skipped opt-in suite above).
- Workspace database pgTAP: 583 assertions passed across 16 files.
- Frontend follow-up targeted tests: 55 passed; final hermetic tests: 2,735 passed.
- Production build: 15/15 tasks. Full lint/typecheck/test gates: see ux-gates.log.
- Authenticated Chromium/API: 54 checks passed with synthetic SSO sessions and
  real isolated PostgREST/RLS. Checked manager flags, denied organization save,
  private edit, viewer denial, foreign ownership, tenant isolation, explicit
  privatization and moderation. No LLM or customer MCP execution.
- Preview browser checks at 320, 390, 768, 1024 and 1440 pixels: visible explanations,
  no page overflow, modal within viewport, disabled save, keyboard open/Escape and
  focus restoration, no preview mutations, no browser page errors.
- Existing six lint warnings remain; no new warning remediation claimed.
- Logs, browser script/results and screenshots: `/srv/tugpt-workspace/ws-agent3-f4-evidence`.

## Unfinished UX and acceptance gaps (not claimed complete)

1. **Release acceptance:** custom-agent UI writes/runs remain disabled. Gate-on UI
   tests are mocks, not enabled real-browser acceptance. Enabling requires a
   separately authorized acceptance scope; a successful API read cannot enable it.
2. **Mobile identity:** the composer AgentMenu label uses `hideNarrow`, hiding its
   visible name below 640px. Accessible name remains, but restored-agent identity
   needs a deliberate mobile layout and long-name browser regression coverage.
3. **Demoted-owner recovery:** no explicit privatization action is surfaced when
   canEdit=false. A future UI needs a clear sharing-impact confirmation, not an
   automatic visibility change to make Save succeed.
4. **Knowledge permissions:** API knowledge-link authorization is distinct from
   ordinary-save authorization. The current UI conservatively hides the editor
   when canEdit=false; do not broaden DB access to resolve this UX distinction.
5. **Production-path evidence:** external canonical SSO handoff, live customer
   MCP execution, and complete browser upload-to-worker-to-retrieval acceptance
   remain outside these isolated tests. Synthetic sessions and earlier manually
   seeded retrieval chunks are not evidence for those paths.

Original accepted worktrees and the Q-9b evidence checksum were verified unchanged.
