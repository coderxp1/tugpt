# OAuth redirect URIs (canonical domain `tugpt.pro`)

Owner decision 2026-11-12: `tugpt.pro` is canonical, and callbacks live on
`dashboard.tugpt.pro`. **Do not** use `tugpt.app` for new registrations or
callbacks. This supersedes the vendor-callback guidance in ADR-016.

**Status: documentation only.** No vendor apps are registered and no DNS has
changed. Registering requires the owner's own vendor accounts and approval.

## Pattern

```
https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/<provider>
```

A single route handler serves every provider. `<provider>` is a fixed
allowlisted slug, not free text. Each environment gets its own vendor app and
redirect URI, so a staging consent can never land in production.

| Provider | Vendor console | Production redirect URI | Staging redirect URI |
|---|---|---|---|
| Google (Calendar, Gmail, Drive) | Google Cloud Console → OAuth client (Web) | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/google` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/google` |
| Microsoft 365 (Graph) | Entra ID → App registration → Web | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/microsoft` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/microsoft` |
| Slack | api.slack.com → OAuth & Permissions | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/slack` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/slack` |
| Meta (WhatsApp Embedded Signup) | Meta for Developers → Facebook Login for Business | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/meta` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/meta` |
| HubSpot | developers.hubspot.com → App → Auth | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/hubspot` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/hubspot` |
| Salesforce | Setup → External Client App | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/salesforce` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/salesforce` |
| Notion | notion.so/my-integrations → Public | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/notion` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/notion` |
| Atlassian (Confluence/Jira) | developer.atlassian.com → OAuth 2.0 (3LO) | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/atlassian` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/atlassian` |
| Customer MCP / OpenAPI (OAuth 2.1 servers) | Customer's authorization server (dynamic client registration where supported) | `https://dashboard.tugpt.pro/api/v1/connect/oauth/callback/mcp` | `https://staging.dashboard.tugpt.pro/api/v1/connect/oauth/callback/mcp` |

The staging hostname is a proposal. If the owner prefers another name, only
this table and the environment variable change.

## Existing Google route (back-compat)

The current free/busy flow uses `/api/v1/integrations/google/callback`
(`apps/web/src/lib/google-integrations/redirect-uri.ts`). The URI is either
derived from the request origin or pinned by `GOOGLE_OAUTH_REDIRECT_URI`.
Whatever URI the production Google OAuth client currently has registered
**must stay registered** until the Google credential migration is approved and
complete. Adding the new URI to the same client is additive; removing the old
one is a separate, later step.

## Supabase Auth (sign-in) is separate

"Sign in with Google/GitHub" goes through Supabase Auth, whose callback is
`https://<supabase-project>.supabase.co/auth/v1/callback`. It uses a different
OAuth client from the integration client and is out of scope here.
