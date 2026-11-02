# Dashboard reference redesign

## Scope

Branch: `feat/dashboard-reference-redesign`, based on `d1269b1`.
Review destination: https://dashboard.tugpt.pro. No merge into main.
The supplied TuGPT-Dashboard-Preview.html is the visual reference, not a source of application behavior.

- Replaces the overview constellation with the reference sidebar, typography, warm canvas, yellow/pink hero, exact self-hosted reference assets and Connect/Create/Operate cards.
- Reuses real authentication, organization/session resolution, module routes and API permissions. No preview dialogs or simulated operations.
- English-first runtime, including organizations with stored Spanish locale. Stored locales and customer data are not changed; Spanish dictionaries and explicit Spanish regression fixtures remain.
- Search, clear/empty states, real server refresh, mobile drawer focus loop/Escape, skip link and reduced motion.
- Existing six module destinations are retained; Integrations gets the shared authenticated frame. Knowledge form styling is improved. Analytics has only one main landmark.
- Reads the existing ai_draft_generation and media_generation flags for accurate availability. Never changes or bypasses those flags. Unknown query results are not converted to zero.

## Blueprint coverage

All 14 official areas are represented through 19 grouped entries, not advertised as 14 completed modules.

| Official area | Dashboard representation and actual scope |
| --- | --- |
| Core Workspace | Separate future Workspace phase; no external Workspace navigation |
| CRM Hub | CRM Hub and Catalog, not yet available |
| Messaging Center | Existing Conversations route; organization feature flag required |
| TuGPT MCP Layer | Customer-facing connections not yet available; administrative bridge untouched |
| Research & Search | Research and Meeting Intelligence, not yet available |
| Custom AI Agents | Agent builder not yet available |
| Knowledge & Integrations | Existing FAQ route behind organization flag; document connectors unavailable |
| Workflow Automation | Existing draft review and calendar settings; no workflow builder or booking |
| Developer Platform | Internal APIs exist; no developer self-service |
| Administration & Governance | Existing usage report and organization permissions; no administration console |
| Privacy & Deployment | Deployment controls unavailable in Dashboard |
| Live Voice Assistants | Not enabled in this Dashboard |
| Video Generation | Existing Media Studio route behind organization flag; provider-dependent generation, video not enabled |
| WhatsApp Business Suite | Connection signal retained; self-service assistants not yet available |

## Verified candidate evidence

- 613 tests in 44 suites passed; TypeScript passed; production standalone build passed.
- ESLint passed with two pre-existing warnings, no errors.
- Chromium using real staging authentication: English with Spanish browser locale, server session, limited organization visibility, all six real module links, search/reset, 14 unique Blueprint areas, reference font/image responses, mobile focus loop and Escape, sign-out and protection after sign-out, no uncaught JavaScript errors.
- Screenshots captured and horizontal overflow checks passed at 1440, 1366, 768 and 390px. These are automated browser checks, not a pixel-diff certification.
- Foreign organization Knowledge request rejected with 403.
- Existing staging feature restrictions are preserved: Conversations, Knowledge and Media list APIs return 503 FEATURE_UNAVAILABLE for the seeded test organization; Knowledge writes also return 503 and show an error. The usage report API returns 200. No successful Knowledge CRUD is claimed.
- No feature flags, database schema or reviewer credentials changed. No test knowledge rows were created because the existing gate rejected writes.

## Deployment and rollback

The build uses TUGPT_NEXT_DIST_DIR=.next-redesign, preserving the prior .next standalone bundle. Only the existing Dashboard launcher's bundle path and its service restart are needed; no reverse-proxy, database, network or GPU restart.
The previous launcher is backed up before activation. Rollback restores the prior launcher and restarts only tugpt-dashboard-review.service.

Private credentials and test evidence remain outside the repository under the existing protected validation directories. No credentials are committed.
Public website/login, workspace.tugpt.pro, MCP/admin authentication, GPU services, Supabase configuration and unrelated infrastructure are out of scope and unchanged.
