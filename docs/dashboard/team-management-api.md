# Dashboard backend — Team & Organization Management (M1)

Owner: Agent 7 (Dashboard backend). Frontend consumer: Agent 1.
Migration: `supabase/migrations/20261121700001_dashboard_team_management.sql` (review candidate; production approval required).

All routes live under the existing `/api/v1/organizations` proxy prefix (the
proxy file is hash-frozen by the SSO integration boundary, so no proxy change
was made). Every route authenticates itself (JSON 401), resolves the active
organization from `x-tenant-id` / `tugpt_tenant_id` (JSON 403 when foreign),
responds `Cache-Control: private, no-store`, and every write requires a
same-origin JSON request with `x-tugpt-csrf: 1`. Authorization lives in the
RPCs/RLS; `permissions` fields in responses are UI hints only.

| Method | Path | Who | Backing |
|---|---|---|---|
| GET | `/api/v1/organizations/me` | any signed-in user (no org needed) | profiles RLS + AuthService |
| PATCH | `/api/v1/organizations/me` | self | `profiles` column grant (full_name, preferred_locale), own-row RLS |
| GET | `/api/v1/organizations/current` | any member | organizations / organization_members RLS |
| PATCH | `/api/v1/organizations/current` | owner, admin | `update_organization_settings` (audited) |
| POST | `/api/v1/organizations/current/transfer-ownership` | owner | `transfer_organization_ownership` (audited) |
| GET | `/api/v1/organizations/current/members` | any member | organization_members + co-member profiles RLS |
| PATCH | `/api/v1/organizations/current/members/:userId` | owner; admin for members below admin | `manage_organization_member` set_role (audited) |
| DELETE | `/api/v1/organizations/current/members/:userId` | owner; admin below admin; anyone for self (leave) | `manage_organization_member` remove (audited) |

Invitations are unchanged: `/api/v1/invitations` (create/list), `/api/v1/invitations/:id/revoke`, `/api/v1/invitations/accept`.
Membership is only ever created by accepting an invitation; `manage_organization_member(..., 'add')` is refused.

## Examples

```http
PATCH /api/v1/organizations/current/members/0b6c…   {"role":"manager"}
200 {"member":{"userId":"0b6c…","action":"set_role","previousRole":"agent","role":"manager","changed":true}}

DELETE /api/v1/organizations/current/members/<self>
200 {"member":{…,"action":"leave"},"left":true}   + Set-Cookie: tugpt_tenant_id=; Max-Age=0

PATCH /api/v1/organizations/current   {"name":"Acme SL","timeZone":"Europe/Madrid"}
200 {"organization":{"id":"…","name":"Acme SL","slug":"acme","locale":"es","timeZone":"Europe/Madrid"},"changed":true}

GET /api/v1/organizations/current/members
200 {"members":[{"userId":"…","name":"Bob","email":"bob@acme.test","avatarUrl":null,"role":"agent",
     "joinedAt":"…","isSelf":false,"canChangeRole":true,"canRemove":true}],"ownerCount":1,
     "permissions":{"editSettings":true,"manageMembers":true,"invite":true,"transferOwnership":false,
     "viewAuditLog":true,"assignableRoles":["admin","manager","agent","viewer"]}}
```

## Error codes

| SQLSTATE | HTTP | `error.code` |
|---|---|---|
| P3S01 | 404 | ORGANIZATION_NOT_FOUND (also non-member; no enumeration) |
| P3S02 | 403 | FORBIDDEN (role may not; admin touching an owner; `add`) |
| P3S03 | 422 | INVALID_MEMBERSHIP_CHANGE (bad name/locale/time zone, unknown key, empty change) |
| P3S05 | 409 | LAST_OWNER |
| P3S06 | 404 | MEMBER_NOT_FOUND |
| P3S07 | 403 | MEMBER_RANK_FORBIDDEN (admin vs peer admin, or assigning above own rank) |

Shape errors are `400 INVALID_BODY`; unknown body fields are rejected (an
organization id can never be supplied in a body).

## Audit actions

`membership.set_role`, `membership.remove`, `membership.leave`,
`organization.update_settings` (with from/to diff), `organization.transfer_ownership`,
plus the existing `invitation.create|revoke|accept`. No-op role changes are not audited.

## Behaviour changes in 20261121700001

- `manage_organization_member('add')` → P3S02 (previously let owner/admin attach any user id without consent).
- Admins can no longer demote/remove peer admins (P3S07).
- `REVOKE UPDATE ON public.organizations FROM authenticated` — settings change only through the audited RPC.
- `rls_adversarial.test.sql` Tests 5–7 and 10 updated accordingly (plan 37 → 41).

## Known limitations

- Removing a member does not revoke their connected accounts (`organization_connected_accounts`); owned by the integrations area.
- Owner soft-delete of an organization (`DELETE` policy) is still not audited.
- `AuthService.getUserOrganizations` has no ORDER BY, so the default active organization for multi-org users is not deterministic.
- Audit-log read API is not part of M1.
