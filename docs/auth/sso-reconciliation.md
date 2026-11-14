## Consolidated P2 closure source pass - current status

The owner approved the closure proposal, H09/H12/H17 SQL-text exception and A15-A23 diagnostic-privacy addition: 24 existing editable rows, unchanged 155 candidate / 21 review-path allowlist. This section supersedes earlier unfinished-source descriptions; the previous text below remains historical context, not current execution evidence.

Source is authored for review, not accepted as P2 complete. All derivative execution remains NOT RUN. M2 is ON HOLD; CF-01-CF-07 are OPEN; P3 is unauthorized. D6, hosted/data-owner/identity validation and production release are separate. This pass performed no dependency installation/resolution, build, lint, typecheck, tests, SQL, migration, runtime, service, container, infrastructure, gateway, DNS, credential, deployment or publication operation.

### Diagnostic privacy and ordinary-action boundaries

A15-A23 log fixed events with server-generated correlation and selected outcome/failure-kind/status metadata; variable RPC status is validated against a fixed allowlist. No exception message/name/stack, body, token or arbitrary header text is forwarded. Auth/tenant/feature/role checks, business calls, sanitized HTTP errors and private/no-store remain. Shared logger and draft service are unchanged. This is a nine-route correction, not a whole-application logging audit.

The ordinary matrix covers shell/locale/accessibility, current/stale membership selection, inbox filtering/pagination/order/error, assignment/unassignment/CAS/removed authority, draft read/thread/history/edit/reject/approve, owner/admin knowledge CRUD/preview, analytics dimensions/empty/error/permission, invitation recipient/issuer/freshness/expiry/replay/role preservation/revoke, explicit caller-owned organization creation and holds. Additional CSRF/content-type/shape/large-body denials preserve existing contracts. Owner withdrawal after real login is separately inventoried; the browser receives a case acknowledgement, never owner/signing credentials. Only the two existing synthetic identities are used.

H12 inventories selected business tables, not every database object. SSO-only accounting allows the intended new session and consumed ticket, not business/identity/membership creation. Business changes are case/table/tenant/draft restricted. Approval ends at one synthetic queued delivery, zero attempts and one queue entry. An inert fixture connection is active solely for that DB enqueue contract: no credentials, consumer, dispatch, polling or held HTTP/UI activation. Four held prefixes, frozen files, D03 delivery wrappers/ten-column contract/batch100 and service-only legacy ACLs remain unchanged.

## Historical checkpoint and prior operational guidance

# SSO reconciliation: P2-DB-01 source implementation

## Authority and status

The owner approved two delivery-read wrappers as a narrowly scoped source-only amendment. The 155 candidate / 21 review path boundary is unchanged. No dependencies, builds, tests, services, SQL, migrations, credentials, gateway changes, branches, pushes or deployment are authorized by this document. P3 remains unauthorized; M2 ON HOLD; CF-01 through CF-07 OPEN.

The delivery amendment is authored but unexecuted. This does not close pre-existing wider P2 harness/coverage/review gaps. The manifest must not advertise `P2_SOURCE_COMPLETE` until those are resolved under the appropriate scope. Historical passes are not derivative passes.

## Exact public signatures and columns

- `public.sso_get_outbound_delivery_for_draft(p_organization_id uuid, p_draft_id uuid)`.
- `public.sso_list_outbound_deliveries_for_drafts(p_organization_id uuid, p_draft_ids uuid[])`.

Both return a set with exactly: `id uuid`, `organization_id uuid`, `draft_id uuid`, `status text`, `provider_message_id text`, `attempts integer`, `error_code text`, `updated_at timestamptz`, `delivered_at timestamptz`, `read_at timestamptz`.

The existing HTTP translator is unchanged: `id`, `status`, `providerMessageId`, `attempts`, `errorCode`, `updatedAt`, `deliveredAt`, `readAt`. A sent delivery remains `sent`; receipt timestamps are separate fields, not new status values. The single endpoint retains missing/foreign visibility 404, no-delivery 200/null and sanitized RPC-error 500. List enrichment still degrades to the original list on RPC failure. Both retain private/no-store responses.

## Validation and concurrency boundary

Each wrapper calls `sso.require_actor(organization,false)` before accessing data. This validates bridge claims, mapped session, family revocation, session row, current membership and deadlines using the existing family/session/membership lock order. The organization parameter is never authority by itself. Global and organization `ai_draft_generation` flags must both enable the existing feature function; false/NULL denies.

Both draft and delivery organization identifiers are checked in the actual joined query. Single missing/foreign IDs return no rows after authorization. Bulk mixed-tenant IDs yield only eligible tenant rows, without foreign counts; `ANY` avoids duplication. Null single IDs fail with 22023. Bulk accepts empty one-dimensional-equivalent arrays as zero rows after authorization/gating; otherwise accepts only one-dimensional, one-based arrays, no null elements, at most 100 supplied entries. Duplicates count toward the bound. The existing list service caps pages at 50, so its normal batch remains within the wrapper limit.

After `RETURN QUERY`, PL/pgSQL has buffered results rather than sent them. A repeated actor check and feature check can still raise and discard all results. A final session check follows the feature lookup so a wait there cannot extend assertion/session expiry. These are designed checks with authored observed-blocker tests, not an executed concurrency guarantee or a guarantee about unrelated baseline RPCs. Membership-lock bookkeeping can write; do not describe this as a physically write-free transaction. No delivery/queue/provider business write is added.

## Permission matrix

| Function family | PUBLIC | anon | authenticated | service_role | sso_control | reviewed postgres owner |
|---|---|---|---|---|---|---|
| Two new public SSO delivery wrappers | No | No | EXECUTE | No | No | Inherent owner authority |
| Two existing service-only delivery reads | No | No | No | Existing EXECUTE | No new grant | Existing owner authority |
| Internal require_actor/require_session helpers | No | No | No direct EXECUTE | No | No direct EXECUTE | Internal definer use |
| Existing public is_feature_enabled | No | No | No direct EXECUTE | Existing EXECUTE | No new grant | Internal definer use |

The two new functions have explicit postgres ownership, SECURITY DEFINER and fixed `search_path=pg_catalog`; object references are schema-qualified. Existing service RPC bodies/owners/ACLs are not changed. There are no new table/schema/default grants and no privileged application fallback. A migration-local ACL audit rejects unexpected creator-default grantees or authenticated grant options rather than repairing shared defaults. Direct effective ACLs, inheritance, PUBLIC grants, overloads and ownership require future real database verification; source statements alone cannot establish an existing database's effective state.

## Evidence and non-goals

T10/T34/T35/T36 and H08/H16/H19/H21 contain the amendment adaptations. D06 adds only the matching public type signatures; D03 adds only the two functions and ACLs. The frozen admin factory, feature adapter, guards, core and all historical migrations remain unchanged. Inert synthetic business rows for future H19/H16 use disconnected connections, existing users/organizations, no credentials and no queue message. Setup is explicitly separated from successful browser SSO. Temporary negative-test memberships/sessions are cleaned; family revocation tombstones are retained. Business fixture rows remain only in the future disposable DB for browser reads.

No dispatch, enqueue call, provider polling, worker execution or provider credentials are introduced by this amendment. No historical evidence is relabeled as a derivative result. The complete mapping explicitly identifies unimplemented wider journeys and unexecuted checks. Any further path, permission or dependency requirement must stop for owner review.
