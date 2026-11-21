# Usage & Analytics API (dashboard M2)

Owner: **Agent 6 — Dashboard backend**. Consumers: Agent 1 (dashboard UI), Agent 4 (chat route — recording).
Migration: `20261121700002_usage_accounting.sql`. Tests: `supabase/tests/database/usage_accounting.test.sql`,
`apps/web/src/app/api/v1/analytics/analytics-usage-route.test.ts`, `apps/web/src/lib/usage/chat-usage.test.ts`,
`scripts/http-acceptance/dashboard-usage.mjs`.

## Principles

| Rule | How it is enforced |
|---|---|
| Customers see **capabilities and usage only** — never provider, model, endpoint, price or cost | `org_usage_report` builds its JSON without those columns; `provider_usage_events`/`components` stay service_role-only; `org_usage_summary` (which returned provider/model/cost) is **revoked from `authenticated`**. Tests assert no such keys/values in any response. |
| Tenant isolation | Membership is derived from `auth.uid()` inside the definer; non-member, nonexistent and soft-deleted orgs all get the same `P3J02` (403). The route never reads an org id from the query. Thread FK is `(chat_thread_id, organization_id)`, so a usage row can't point at another tenant's thread. |
| RBAC | `scope=self` for any member (own requests only). `scope=organization` (all requests + per-user breakdown) for **owner/admin** only, else `P3S02` (403). |
| No double counting | Each model call is keyed `chat:<turn_id>:<call_index>`, unique per organization, with an advisory lock. A retry returns `{duplicate:true}` and the original event. |
| Unknown ≠ zero | `usage_basis = reported | estimated | unavailable`. `unavailable` rows count as requests, carry no tokens and have NULL cost. |
| Estimated vs actual cost | `cost_micros`/`accounting_cost_micros` = **estimated** (price table × quantities at call time). `actual_cost_micros/_currency/_source/_recorded_at` = **actual**, from invoice reconciliation; all four NULL until reconciled. Both are kept and neither overwrites the other. Both are backend-only. |

## `GET /api/v1/analytics/usage`

Auth: session cookie. Active org from session / `x-tenant-id`. Response headers: `Cache-Control: private, no-store`.

| Query | Values | Default |
|---|---|---|
| `range` | `7d`, `30d`, `90d` | `30d` |
| `bucket` | `day`, `month` (bucketed in the org time zone) | `day` |
| `scope` | `organization`, `self` | `organization` for owner/admin, else `self` |

### 200

```json
{
  "range": "30d",
  "window": { "from": "2026-10-21T19:00:00.000Z", "to": "2026-11-20T19:00:00.000Z" },
  "scope": "organization",
  "bucket": "day",
  "report": {
    "scope": "organization",
    "bucket": "day",
    "time_zone": "Europe/Madrid",
    "window": { "from": "…", "to": "…" },
    "totals": {
      "requests": 4, "succeeded": 2, "failed": 1, "cancelled": 1,
      "input_tokens": 147, "output_tokens": 63, "audio_seconds": 0,
      "unmetered_requests": 1, "estimated_usage_requests": 1
    },
    "by_feature": [
      { "feature": "chat", "requests": 4, "failed": 2, "input_tokens": 147, "output_tokens": 63, "audio_seconds": 0 }
    ],
    "series": [
      { "bucket_start": "2026-11-20", "requests": 4, "failed": 2, "input_tokens": 147, "output_tokens": 63 }
    ],
    "by_user": [
      { "user_id": "…", "name": "Ana", "email": "ana@example.com", "is_member": true,
        "requests": 3, "input_tokens": 140, "output_tokens": 60 }
    ],
    "unattributed_requests": 0
  }
}
```

- `feature`: `chat | agents | drafts | transcription | images | other`. `other` covers legacy rows recorded before features were tracked.
- `by_feature[].failed` and `series[].failed` count every request that did not succeed (failed + cancelled).
- `by_user` and `unattributed_requests` are `null` for `scope=self`. Former members keep their history with `is_member: false`.
- `unmetered_requests`: the provider reported no usage. Show as "N requests without usage data", never as 0 tokens.
- Types: `apps/web/src/lib/analytics/usage-report.ts` (`UsageReport`, `parseUsageQuery`).

### Errors

| Status | `error.code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | no session (`P3J01`) |
| 403 | `FORBIDDEN` | no active org; not a member / org deleted (`P3J02`); `scope=organization` without owner/admin (`P3S02`) |
| 400 | `INVALID_QUERY` | bad `range`/`bucket`/`scope` (route) or `P3J03`/`P3U03` |
| 400 | `QUERY_WINDOW_TOO_LARGE` | `P3J04` (unreachable via presets) |
| 500 | `INTERNAL_ERROR` | anything else; no raw SQLSTATE or message is returned |

### Breaking change vs. v1 (action for Agent 1)

v1 returned `{ range, window, summary }` with `summary.totals.costs_by_currency`, `accounting_cost_micros` and
`summary.by_provider[] {provider, model, modality, costs…}`. **That data is now internal-only (finding N8).**
`components/analytics/UsageAnalytics.tsx` must move to `report` (totals, `by_feature`, `series`, `by_user`) and drop
the cost rows and the "by provider" table, plus their i18n keys (`analytics.byProviderTitle`, `analytics.provider`,
`analytics.model`, `analytics.column.cost`, `analytics.costUnknown`, `analytics.unpricedNotice`, …). Internal cost
reporting will get a separate staff-only surface; it is not part of the customer dashboard.

## Recording (server-only) — `public.record_chat_usage`

Executable by `sso_control` and `service_role` only. Called by the chat route through
`apps/web/src/lib/usage/chat-usage.ts`:

```ts
import { parseOpenAiUsage, recordChatUsage } from '@/lib/usage/chat-usage';

await recordChatUsage(control, {
  organizationId, userId, threadId, turnId,
  callIndex,                 // 0..63, one per model call in the turn (tool loops)
  feature: 'chat',           // or 'agents'
  provider, model,           // internal ids — stored backend-only
  outcome: 'succeeded',      // 'failed' | 'cancelled'
  usage: parseOpenAiUsage(finalChunk.usage), // null → estimate or 'unavailable'
  requestId,
}, logger);                  // never throws; logs codes only
```

| SQLSTATE | Meaning |
|---|---|
| `P3U01` | invalid reference/classification/quantities (e.g. tokens on `unavailable`, call index > 63) |
| `P3U02` | thread is not this org's / not this user's, or the user is not a member |

## Remaining limitations

- **Chat recording is not wired yet.** It needs Agent 4 to set `stream_options: { include_usage: true }`, capture `usage` per model call and call `recordChatUsage` (request filed in `agent6-handoffs/`). Until then, only drafts and transcription produce usage rows.
- Actual-cost reconciliation (invoice import) has no writer yet; columns and constraints are in place.
- There is no staff-only internal cost report API yet. `org_usage_summary` is still available to `service_role` for that.
- Report presets only (7d/30d/90d); no custom date range.
