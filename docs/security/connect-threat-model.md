# Threat model — TuGPT Connect (integrations, customer MCP, agent tools)

Scope: ADR-021 and ADR-020 Amendment 1. The method is STRIDE per trust
boundary. Each control has an owner artefact (code or test). "Planned" means
designed but not yet implemented on the branch.

## Assets

| ID | Asset | Impact if lost |
|---|---|---|
| A1 | Encryption key ring | All stored vendor credentials decryptable |
| A2 | Vendor refresh/access tokens (per connection) | Account takeover at the vendor, data exfiltration |
| A3 | Vendor OAuth client secrets (platform) | Impersonating TuGPT to vendors |
| A4 | Caller keys (web/worker → broker) | Requesting tokens as a service |
| A5 | Tenant data returned by tools | Cross-tenant disclosure |
| A6 | Infrastructure admin MCP bridge | Full infrastructure control |
| A7 | Audit trail | Loss of accountability |

## Trust boundaries

```
 Browser ─B1─► web (public) ─B2─► credential-broker (internal) ─B3─► Postgres
                    │                        ▲
                    └──B4── worker / agent runtime ──B5──► egress ──► vendors / customer MCP
 LLM provider ◄─B6── agent runtime            (admin MCP bridge: private network, NOT reachable via B5)
```

## Threats and controls

### OAuth and connections (B1)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-OA-01 | CSRF / login-CSRF on callback (attacker's account bound to victim org) | HMAC state + single-use nonce row (`oauth_pending_authorizations`) bound to user, org, provider, and 10-minute expiry; callback must come from the same session | Existing for Google (state + nonce); generalized in registry migration |
| T-OA-02 | Authorization-code interception | PKCE S256 for every provider that supports it | Planned (current Google flow has no PKCE) |
| T-OA-03 | Open redirect via `return_to` | Post-flow destination is a fixed allowlisted path; never taken from the query | Existing (`redirect-uri.ts`) |
| T-OA-04 | Scope escalation (vendor grants more or less than requested) | Store *granted* scopes; refuse if a required scope is missing (`SCOPE_NOT_GRANTED`); show scopes at connect time | Existing for Google; generalized |
| T-OA-05 | Wrong-org binding through stale active-org selection | Callback binds to the org recorded in the pending authorization, not the cookie; active-org resolution is membership-validated | **Fixed this phase** (`lib/tenant/resolve.ts`) + planned |

### Credential broker (B2, B3)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-CB-01 | Public reach to broker | Internal Docker network, no published port | Planned (staging test defined) |
| T-CB-02 | Forged or replayed service calls | HMAC signature, ±60 s skew, single-use nonce, constant-time compare | In progress (package) |
| T-CB-03 | Caller over-reach (web asks for tokens) | Per-caller capability matrix, deny by default | In progress |
| T-CB-04 | Cross-org token fetch | Query by `(organization_id, connection_id)`; AAD v2 includes both; mismatch → NOT_FOUND | In progress |
| T-CB-05 | Ciphertext transplant between rows | AAD v2 binds connection id + version | In progress |
| T-CB-06 | Refresh-token loss / race | Advisory lock + CAS + mandatory persist | In progress |
| T-CB-07 | Key ring exposure on disk / backups | systemd-creds encrypted at rest; Docker secret on tmpfs; key ring never in web | Planned |
| T-CB-08 | Key loss | Offline owner backup + restore drill | Planned (owner action) |
| T-CB-09 | Secrets in logs | Structured logger redaction; tests assert no token substrings in logs | Planned |

### Tool runtime and model (B4, B6)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-TR-01 | Prompt injection via tool output / emails / documents | Results passed as delimited data; never alter grants/trust; every call re-runs D4 ladder | Planned (ADR-020 A1.4) |
| T-TR-02 | Model invents tool or arguments | Only granted tools are offered; JSON Schema validation at call time; unknown tool → denied | Planned |
| T-TR-03 | Side effects without consent | Write/irreversible/financial classes require approval per trust state; approval card shows exact action | Planned (ADR-020 D7) |
| T-TR-04 | Duplicate side effects on retry | `UNIQUE(org, tool, idempotency_key)` | Planned (ADR-020 D5) |
| T-TR-05 | Credentials reaching the model | Tools receive scoped clients, never tokens; model sees schemas/results only | Design rule (ADR-020 D8) |
| T-TR-06 | Data leak to LLM provider | Only approved models; per-org model policy; minimal tool output | Existing policy + planned |

### Customer MCP / OpenAPI (B5) — separate from the admin bridge

| ID | Threat | Control | Status |
|---|---|---|---|
| T-MCP-01 | SSRF to internal services / metadata | Egress guard: HTTPS:443 only; resolved-IP denylist (RFC1918, loopback, link-local, CGNAT, ULA, metadata) checked per request after DNS; no cross-host redirects | Planned (test per range) |
| T-MCP-02 | **Reaching the infrastructure admin MCP bridge** | Separate package with no import path (lint rule); bridge hostnames/IPs on registration denylist; bridge only on private interfaces, which the egress guard refuses; bridge credentials never in vault | Partly implemented: static separation guards in `connect-runtime` and `credential-broker` (`src/separation.test.ts`, dependency allowlist + no process/eval imports + no bridge identifiers; 7 planted violations caught); egress proxy refuses the bridge host address (staging smoke 2026-11-14, `docs/connect/broker-egress.md`). Pending: registration denylist (with customer MCP registration). |
| T-MCP-03 | Tool redefinition ("rug pull") | Immutable approved snapshots; new list → new snapshot needing approval | Planned (A1.1) |
| T-MCP-04 | Customer server executing on our hosts | Remote Streamable HTTP only; no stdio; no spawning | Design rule |
| T-MCP-05 | Cross-org use of a customer server | Snapshot/tool/grant FKs carry `organization_id`; pgTAP two-org tests | In progress (migration) |
| T-MCP-06 | Oversized / slow responses (DoS) | Size and time limits; per-org concurrency caps | Planned |
| T-MCP-07 | Malicious tool descriptions (instruction injection) | Descriptions shown to admins at approval; delimited in prompts; length-capped | Planned |

### Audit (A7)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-AU-01 | Tampering with audit | `audit_logs` append-only (existing); `credential_access_log` append-only, REVOKE UPDATE/DELETE | Existing / planned |
| T-AU-02 | Repudiation of approvals | Approver id + timestamp + exact action payload hash on `approval_requests` | Planned |

## Residual risks (accepted, stated)

- A live root compromise of the host can read the key ring from the broker's
  memory. Without a TPM or HSM this is not preventable at zero cost. The
  OpenBao transit backend remains the upgrade path.
- Vendor-side compromise of a customer's account is outside TuGPT's control.
  Revocation is one click, and health checks surface `error` states.
