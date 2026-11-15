# Customer-MCP egress proxy â€” staging deployment package

Status: **prepared, not deployed.** No firewall/network changes have been made.
This package is the concrete implementation plan for the mandatory SSRF boundary.

## 1. Why a proxy (not just the in-process guard)

`assertPublicEndpoint` (in `@tugpt/connect-runtime`) resolves the hostname and
rejects private/reserved addresses, but `fetch` re-resolves after the check, so a
DNS-rebinding window remains. Only a proxy that **resolves once and connects to
the address it checked** closes that window. Customer-MCP endpoints are
customer-supplied arbitrary HTTPS hosts, so the policy is "public-unicast-only +
DNS pinning", not a fixed hostname allowlist.

## 2. Recommended implementation

**Smokescreen** (Stripe, Go) â€” purpose-built CONNECT egress allowlist with
private-range blocking (`deny_ranges`), no TLS interception, small, self-hosted,
free. Alternative: Squid with explicit private-range ACLs (more surface).

## 3. Network topology

```
customer-mcp-egress-int (--internal, no default route)   <-- app containers (web/worker)
             |
     [ egress-proxy :3128 ]  CONNECT only, resolves once, public-unicast only
             |
   customer-mcp-egress (routed)  --- TLS passthrough ---> customer MCP hosts (public)
```

- The app containers that call customer MCP run on an **`--internal`** network,
  so a compromised dependency has **no route** to reach anything directly â€”
  the proxy is the only path (bypass prevention).
- The proxy attaches to that internal network and to one routed network; it
  identifies callers **by network/listener, not headers**.
- **TLS is end-to-end**: the proxy sees only `host:port`, never tokens or payloads.

## 4. Listener policy (enforced before any upstream socket opens)

1. `CONNECT` only; anything else â†’ 405.
2. Resolve the target **once** (via the proxy's own resolver).
3. **Every** resolved address must be public unicast â€” reject RFC1918, loopback
   (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`),
   cloud metadata (`169.254.169.254`), CGNAT (`100.64.0.0/10`), ULA (`fc00::/7`),
   multicast, documentation (`2001:db8::/32`), and reserved ranges.
4. Connect to **the address that was checked** (DNS-pinning; no rebinding window).
5. One JSON log line per decision (identity, client, target, allow/deny, reason).
   No headers, no payloads.
6. Connect timeout 10 s, idle timeout 60 s, per-identity connection cap.

## 5. Fail-closed behaviour

- The application refuses to **activate** any customer-MCP endpoint when
  `CONNECT_EGRESS_PROXY` is unset (`decideActivation` â†’ 409). See
  `packages/connect-runtime/src/egress.ts`.
- The proxy refuses every non-public / non-CONNECT request (deny-by-default).
- If the proxy is unreachable at runtime, the tool call fails closed
  (`PROVIDER_UNAVAILABLE`), never falls back to direct egress.

## 6. Automated tests (prepared; run against a deployed proxy)

`tests/egress-probe.cjs` asserts each hostile target is refused:

| Case | Target | Expected |
|---|---|---|
| direct egress (bypass) | any host from the app network | `ENETUNREACH` (no route) |
| DNS rebinding | host resolving to private after public TTL | refused (pin to first resolution) |
| private IPv4 | `10.0.0.1:443`, `172.16.0.1:443`, `192.168.1.1:443` | 403 |
| loopback | `127.0.0.1:8080`, `[::1]:8080` | 403 |
| link-local | `169.254.169.254:80` (cloud metadata) | 403 |
| CGNAT / ULA | `100.64.0.1:443`, `[fc00::1]:443` | 403 |
| internal service | this host's own address (`82.165.50.109`) | 403 |
| plain HTTP forward | non-CONNECT request | 405 |

**Distinction:** the 14/14 smoke test in `docs/connect/broker-egress.md` ran
against a throwaway harness on 2026-11-14 (the allowlist refused everything, so
rule 3's DNS check was never triggered). These tests are **prepared but not yet
run against a deployed production-configured proxy** â€” that requires the
deployment step below, which is owner-gated.

## 7. Deployment steps (NOT executed â€” owner approval required)

1. Build/run the Smokescreen container (read-only, `--cap-drop ALL`,
   `no-new-privileges`, non-root, no published ports) on the internal network.
2. Set `CONNECT_EGRESS_PROXY=http://egress-proxy:3128` for the app containers.
3. Run `egress-probe.cjs` and confirm every case passes.
4. Only then enable customer-MCP activation for real endpoints.
