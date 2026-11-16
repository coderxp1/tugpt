# Connect: dashboard frontend

Status of the Connect UI on `feat/connect-dashboard-wiring` (branched from
`integration/connect-dashboard`), wired to the Connect v2 contracts in
`docs/connect/frontend-integration-handover.md`. The UI does not fake
anything: every state it shows comes from a backend response, and where
something cannot be done it says why and names the dependency.

## What the page does

| Area | Behaviour |
| --- | --- |
| Provider cards (`/dashboard/connect`) | Status from `list_chat_capabilities()`, read on every request (`force-dynamic`). "Check again" re-reads without a reload. Customer MCP rows (`providerKey 'mcp'`) are not shown as provider cards. |
| Connect buttons | Owners/admins only (`canManageConnections`). A real top-level link to `GET /api/v1/connect/{google,microsoft}/start`. If this build has no such route, the button is disabled and the missing path is shown. |
| OAuth return | Callbacks redirect to `/settings/integrations?google|microsoft=connected|revoked|error&reason=…`. That page forwards whitelisted values to `/dashboard/connect`, which shows a banner and strips the parameters. Reasons: `forbidden`, `not_configured`, `invalid_callback`, `internal_error`, `disconnect_failed`; anything else renders generically. |
| Disconnect | Confirmation dialog → `POST /api/v1/connect/{provider}/disconnect` with the CSRF header (`lib/connect-ui/disconnect.ts`). The outcome is read from the final redirect URL: `revoked` → banner + status re-read; `disconnect_failed` → error in the dialog + status re-read; unreadable (e.g. a pinned public origin makes the redirect cross-origin, or a network error) → "could not confirm" + status re-read. The card status after a disconnect always comes from a fresh server read, never from the client. |
| Customer MCP | `GET /mcp/endpoints` on mount (owners/admins; members see a message and no request is made). Status badges from the backend. Discover → `GET /mcp/snapshots/{id}/tools` shows each tool's stored permission class; approve needs an explicit level per tool plus a confirmation, then the tools are re-read to show the stored classes; `ALREADY_APPROVED` counts as approved. Activate is enabled only after an approval in this session, and the backend decides (`ACTIVATION_DENIED` is shown). Remove asks for confirmation, then `DELETE /mcp/endpoints/{id}` and a list re-read. Turn off is always available. |
| Customer MCP switch | **Off by default** (`TUGPT_CUSTOMER_MCP_ENABLED`, read server-side in `lib/connect-ui/flags.server.ts`). Off: no registering, discovering, approving or activating (B-8). Listing, reading stored tools, turning off and removing stay available because they only reduce exposure. |
| Chat | The picker shows every capability with a reason when it cannot be used. Google and Outlook calendar availability are registered chat tools; MCP rows show "Not available in chat yet" with the reason for the closed gate until it opens (B-9; see `docs/workspace-chat.md`). A refused MCP write call shows an approval card (B-11). Tool steps name the account ("Checking calendar availability in Microsoft 365"; provider comes from the server-side capability row). The stream reader tolerates malformed lines and reports a cut-off stream as an error, never as a finished answer. |

Route presence is read from the build's own `.next/server/app-paths-manifest.json`
(`lib/connect-ui/routes.server.ts`). Start routes are never probed. If the
manifest cannot be read, provider actions stay enabled (the routes fail
closed); customer MCP actions use the strict check and stay disabled.

## Backend dependencies

B-1 to B-7 were delivered on `integration/connect-dashboard`. Open:

| ID | Needed | Effect until then |
| --- | --- | --- |
| B-8 | Egress proxy passes its DNS-pinning, private-address-blocking and bypass-prevention probe, **and** tool discovery (`POST /mcp/endpoints/{id}/snapshot`) goes through it. Discovery currently calls the customer URL with plain `fetch` (redirects followed, DNS-rebinding window between check and connect), and is not gated on egress. | Customer MCP stays switched off in the UI. |
| B-9 | Chat runs approved MCP tools through the egress proxy and audits them with Agent 2's `record_mcp_tool_call` (wired on `feat/connect-mcp-approval-ui`). Still needed: (a) a deployed, secured egress proxy; (b) `TUGPT_CHAT_MCP_EXECUTION_ENABLED=true`; (c) a credential path for endpoints with `auth_connection_id`. Backend review items: the member read policy (`20261115000007`) exposes pending and disabled endpoints and full URLs; `record_mcp_tool_call` accepts rows any member writes; `list_chat_capabilities` still lists tools of an older approved snapshot. | MCP tools appear in the @ picker as "Not available in chat yet" with the reason, and are never sent to the model. |
| B-10 | `GET /mcp/endpoints` returns the latest snapshot id and approval state. | A review cannot be resumed after a reload; it restarts from Discover. |
| B-11 | The chat approval card is built (`feat/connect-mcp-approval-ui`) and uses Agent 2's approve and revoke routes. Both routes call `record_tool_approval`/`revoke_tool_approval` with the service-role client, where `auth.uid()` is null, so the RPCs raise FORBIDDEN and the routes fail with 500. The service-role token is also rejected by `sso.pre_request` on the dashboard PostgREST. Fix (Agent 2): call the RPCs with the caller's client (`createAuthenticatedServerClient`); the RPCs already check owner/admin. Also missing: a way for members to send an approval request. | The card reports the failure and nothing is approved or run. |

Also noted for the backend owner (not changed here):

- Google and Outlook calendar tools share the model name `calendar_find_availability`, so only one calendar can be attached per message. The messages route returns 409 `Attach one calendar per message` instead of silently dropping one.
- The Outlook tool queries `calendarId 'me'` (existing TODO).
- The v2 Connect mutation routes have no origin check; the `SameSite=Lax` `__Host-` session cookie mitigates cross-site POSTs. The chat routes keep `isSameOriginMutation`.

## Environment

See `docs/workspace-chat.md`: `TUGPT_BROKER_URL`, `TUGPT_BROKER_CALLER_KEY` (hex),
`TUGPT_CHAT_VERIFIED_TOOL_MODELS` (empty by default), and
`TUGPT_CUSTOMER_MCP_ENABLED` (off by default; see B-8 before changing it).
