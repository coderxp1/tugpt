# Staging deployment proposal (for owner approval â€” nothing deployed)

## 1. Domain / URL
- Staging URL: `https://staging.tugpt.pro` (one A record + Let's Encrypt TLS).
- OAuth redirect URIs must be registered under this exact origin (see Â§7).

## 2. Services and containers (all self-hosted, Docker)
| Service | Purpose | Notes |
|---|---|---|
| `apps/web` | TuGPT dashboard + API routes | Next.js, the app you test in the browser |
| `apps/worker` | Connect runtime tool execution | internal network only |
| Postgres/Supabase | data (separate from production) | Â§3 |
| `credential-broker` | AES-256-GCM credential storage | only process with the key ring |
| `egress-proxy` (Smokescreen) | mandatory customer-MCP egress boundary | `docs/connect/egress-proxy/` |
| GPU image service | image generation | already running; reachable from staging only |

## 3. Database isolation from production
- A **separate Supabase project / database** for staging â€” never the production DB.
- A dedicated **test organization** + test account; all seeded data is staging-only.
- No production tables, rows, or credentials are touched.

## 4. Broker and egress proxy configuration
- Broker: `TUGPT_BROKER_URL`, caller key via `TUGPT_BROKER_CALLER_KEY`; key ring provisioned once.
- Egress proxy: `CONNECT_EGRESS_PROXY=http://egress-proxy:3128`; container read-only,
  `--cap-drop ALL`, non-root, no published ports, on an `--internal` network (Â§5).
- Customer MCP endpoints can only reach `active` after `verifyEgressEnforced` (configured
  + reachable) AND the deployed probe passes â€” otherwise activation fails closed.

## 5. Required environment variables (names only â€” no values here)
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secret), `TUGPT_BROKER_URL`,
`TUGPT_BROKER_CALLER_KEY` (secret), `CONNECT_EGRESS_PROXY`, `TUGPT_API_TOKEN` (secret),
Langdock key (secret), plus platform secrets `google/oauth_client`,
`google/oauth_state_secret`, `microsoft/oauth_client`, `microsoft/oauth_state_secret`.

## 6. OAuth redirect URLs
- Google: `https://staging.tugpt.pro/api/v1/connect/oauth/callback/google`
- Microsoft: `https://staging.tugpt.pro/api/v1/connect/oauth/callback/microsoft`

## 7. Test-account creation
- Create the staging test org + user via the Supabase auth admin (invite email),
  or a seeded dev account. Credentials are delivered to you out-of-band (not chat).

## 8. Estimated cost
| Component | Cost |
|---|---|
| web / worker / broker / egress proxy containers | **free (self-hosted)** |
| staging database | **free** (existing Supabase plan or a new free project) |
| domain + TLS | **free** (Let's Encrypt; existing domain) |
| Langdock (chat/model) | **paid, per-token â€” needs your approval** |

## 9. Rollback
1. Stop/remove the staging containers (`docker compose down`).
2. Deactivate all customer-MCP endpoints (`status='disabled'`).
3. Revoke the staging OAuth clients / remove platform secrets.
4. Drop the staging database or leave it isolated (no production impact).
No production component is part of this deployment.
