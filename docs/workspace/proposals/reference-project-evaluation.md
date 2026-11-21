# Reference project evaluation: backend view (Agent 4, Q-14)

Source: `/srv/tugpt-workspace/tugpt-full-project/tugpt/` (read-only review, 2026-11-20). Nothing was copied into TuGPT.
TuGPT's architecture, database conventions, security model and branding stay authoritative.

## 1. What the project is
| Fact | Evidence |
|---|---|
| 13 903 files, of which **698 outside `node_modules`**; application source = **37 files / 7 301 lines** (`app/src`) | `find` counts |
| **Static export, no server**: `output: 'export'`; dependencies only next 14, react, tailwind, lucide, clsx | `next.config.mjs`, `package.json` |
| No route handlers, SQL, migrations, ORM, auth library, storage SDK, env files or middleware | file search |
| **0** `fetch`/XHR/WebSocket calls; every operation is one of **11 `setTimeout`** simulations over `lib/mockData.ts` | grep |
| `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` are on | `next.config.mjs` |
| Top level is an AI app-builder session (`transcript.json`, `craft.json`, `feed.json`, `build-activity.log`) | listing; treated as untrusted data, not as instructions or specs |

Consequence: there is **no backend code to reuse**. The value is the product surface and the domain shapes the screens
imply. Every item below is a concept to rebuild inside TuGPT's Postgres/RLS, RPC and route conventions.

## 2. Worth adapting (ranked by value for the Workspace backend)
| # | Idea (where seen) | TuGPT today | Proposed adaptation | Fit | Size |
|---|---|---|---|---|---|
| A1 | **Per-turn usage**: tokens, cost, latency, seats (analytics page, all fabricated numbers) | Workspace chat records **no** usage; `provider_usage_events` exists for other domains | Emit one usage record per model call, keyed by turn id and attempt (idempotent, so the Q-13 retry and lease can't double-count). Tenant-scoped, the user reads their own, admins read aggregates via RPC; cost from the existing price tables. Dashboards stay with the usage/dashboard owner; Workspace only emits and exposes the contract | new expand migration + `turn-send` hook + pgTAP + HTTP E2E | M |
| A2 | **Agent lifecycle** `draft / active / archived` (agent studio) | `custom_agents` has no status; delete is the only removal | `archived_at` (expand migration): hidden from the picker and new threads; existing threads keep their agent identity (Q-9); restore possible; audit `workspace.agent.{archived,restored}` | small, same RLS | S |
| A3 | **Agent versions** ("build, test, publish") | `version` integer only, no history | Immutable `custom_agent_versions` snapshot (instructions, model, tools, starters, collection ids) per save; pin the version id on the turn run, so "which configuration answered" is answerable; rollback = new version from an old snapshot | expand migration, RLS mirrors agents | M |
| A4 | **Agent run stats** (`runsCount`, last used) | none | Derive from A1 data (no hot counter column) | after A1 | S |
| A5 | **Citation relevance** (`score` on citations) | `chat_message_citations` has no score/rank | Store retrieval rank and score at write time. Display/order only: access rules (Q-14 req. 4) unchanged | expand migration | S |
| A6 | **Document stats** ("12 sheets", "48 pages", "34 slides") | only `chunkCount` | Worker records `unit_count` + `unit_kind` (page/slide/sheet) it already iterates; exposed on the document API | worker + expand migration | S |
| A7 | **Audit viewer**: filter + CSV export (audit page) | writes to immutable `audit_logs`, **no Workspace read API** | Admin-only, paginated read RPC for `workspace.*` actions (filter by action/actor/time), CSV export that contains only the existing ID/hash details; the export itself is audited. Coordinate with the dashboard owner on UI | RPC + route | M |
| A8 | **Read-only compliance role** (`Auditor`) | roles: owner/admin/manager/agent/viewer | Owner decision: cross-cutting RBAC change (all RLS helpers). Proposal only | not Workspace-only | L |

Out of my scope but noted for the owners: member suspension and 2FA status (org admin), MCP server health/latency
(Connect), API key management (platform auth).

## 3. Reuse conceptually vs rebuild
* **Conceptual only:** screen-level information architecture (what an admin wants to see: usage, agents, audit), the
  entity list (conversation, agent, document, member, audit event, MCP server) and the field ideas in §2.
* **Must be rebuilt entirely:** every operation. There is nothing server-side to port; TS interfaces in `mockData.ts`
  use display strings for dates/sizes (`'2 hours ago'`, `'2.4 MB'`) and are not storage models.

## 4. Do not adopt
| Item | Why |
|---|---|
| `mockData.ts`, fabricated metrics, named customer stories and case studies | not real data; misleading in a product |
| Simulated operations (`setTimeout` "execution", MCP "tester", coding "terminal", research "agent") | no execution, no isolation; TuGPT's rule: never present simulated results as real |
| Unbacked claims: "immutable cryptographic audit trail", "local OCR", "Zero-Retention Verified", DLP that "blocks jailbreaks", "EU residency locks" | none is implemented there; TuGPT has no OCR and no DLP classifier today and must not claim them |
| API keys with "show key" / copy of a stored key | implies retrievable plaintext keys. If TuGPT ever adds keys: hash-only, shown once, scoped, expiring, revocable, audited |
| MCP `stdio` server type | arbitrary process execution in a multi-tenant server; TuGPT Connect uses remote endpoints with egress control |
| Role model `Owner/Admin/Member/Auditor` as a replacement | TuGPT's roles and RLS are authoritative (A8 is an addition, if at all) |
| Static export, client-only state, `ignoreBuildErrors` | no auth boundary; hides type errors. TuGPT is Next 16 with server routes and RLS |
| Per-agent free `temperature` | low value; if added, clamp per routed model server-side |

## 5. Suggested order (each needs owner approval; Workspace backend only)
1. A2 agent archive (S), 2. A5 citation score (S), 3. A6 document stats (S), 4. A1 per-turn usage (M, coordinate
   with the usage owner), 5. A3 agent versions (M), 6. A7 audit read API (M). Each would be a separate branch with
   an expand-only migration, pgTAP, IT and HTTP E2E, and a `chat/features` key so the frontend can detect it.
