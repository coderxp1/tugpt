# Connect: dashboard frontend

Status of the Connect UI on `feat/dashboard-frontend` and what it depends on.
The UI does not fake anything: every action calls a real route, and where a
route is missing it says so and names the dependency.

## What the page does

| Area | Behaviour |
| --- | --- |
| Provider cards (`/dashboard/connect`) | Status from `list_chat_capabilities()`, read on every request (`force-dynamic`). "Check again" re-reads without a reload. |
| Connect buttons | Owners/admins only (`canManageConnections`). A real top-level link to `GET /api/v1/connect/{google,microsoft}/start`. If this build has no such route, the button is disabled and the missing path is shown. |
| OAuth return | Callbacks redirect to `/settings/integrations?google|microsoft=connected|revoked|error&reason=…`. That page forwards whitelisted values to `/dashboard/connect`, which shows a success or error banner and strips the parameters from the URL. Unknown reasons render as a generic message. |
| Disconnect | Confirmation dialog (alertdialog, Escape/Cancel, focus returns to trigger). The confirm button is disabled because no v2 disconnect route exists (B-5). |
| Customer MCP | Register → discover → review → activate/deactivate against the v2 MCP routes. Review requires an explicit permission level per tool plus a confirmation; it is locked while the tool list cannot be read (B-2). Activation errors (`ACTIVATION_DENIED`) and security holds are shown verbatim in plain language. |
| Chat | The picker shows every capability with a reason when it cannot be used: not connected, turned off, no chat tool on this build (`toolAvailable: false`), or the model has not passed tool-calling verification. Tool failures and 409s are worded for people, with a Connect link when reconnecting fixes it. |

Route presence is read from the build's own `.next/server/app-paths-manifest.json`
(`lib/connect-ui/routes.server.ts`). Start routes are never probed: they create
pending authorization rows. If the manifest cannot be read the actions stay
enabled, because the routes themselves fail closed.

## Backend dependencies

| ID | Needed | Effect until then |
| --- | --- | --- |
| — | Connect v2 routes committed to this branch (`/api/v1/connect/{google,microsoft}/start`, OAuth callbacks, MCP routes) | Connect and MCP actions show "not part of this build". |
| B-1 | `GET /api/v1/connect/mcp/endpoints` | Only servers registered in the current page session are listed. |
| B-2 | `GET /api/v1/connect/mcp/snapshots/{id}/tools` | Tool review and approval stay locked; only the tool count is shown. |
| B-3 | Outlook calendar and active MCP tools in the chat tool runtime | Outlook capability shows "not in Chat yet"; picker disables it. |
| B-4 | Active MCP tools in `list_chat_capabilities()` | MCP tools never appear in the @ picker. |
| B-5 | `POST /api/v1/connect/{google,microsoft}/disconnect` | Disconnect dialog cannot confirm. |
| B-6 | Start routes redirect with `?{provider}=error&reason=…` instead of JSON | A not-configured start shows JSON in the browser. |
| B-7 | Per-call approval for MCP write/irreversible/financial tools | Review warns when a non-read level is chosen. |

Also open on the backend side: the Microsoft calendar scope seeded by the chat
migration (`https://graph.microsoft.com/Calendars.ReadBasic`) differs from the
one the v2 flow requests (`Calendars.ReadBasic`), and the v2 migration version
numbers collide with this branch's.

## Environment

See `docs/workspace-chat.md`: `TUGPT_BROKER_URL`, `TUGPT_BROKER_CALLER_KEY` (hex),
`TUGPT_CHAT_VERIFIED_TOOL_MODELS` (empty by default).
