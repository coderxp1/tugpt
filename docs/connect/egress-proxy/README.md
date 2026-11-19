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

## 6. Acceptance probe (prepared; NOT yet run against a real proxy)

`docs/connect/egress-proxy/egress-probe.cjs` is the acceptance gate for customer MCP. Run it from a
container on the web tier's internal network against the **digest-pinned** proxy:

```
PROBE_REBIND_HOST=<rebinding name> PROBE_CANARY_PORT=443 node egress-probe.cjs http://egress-proxy:3128
```

It is fail-closed. It prints `ALL_BLOCKED` and exits 0 **only** when every check below holds;
anything else is a non-zero exit with a named reason.

| Check | Pass condition | Otherwise |
|---|---|---|
| preflight | proxy accepts TCP | exit 2 `PROXY_UNREACHABLE` |
| positive control | `CONNECT <control>:443` → 200 (proxy is live and forwarding) | exit 3 `NO_POSITIVE_CONTROL` |
| direct-egress bypass | a direct TCP connection to the control host (no proxy) fails | FAIL |
| IPv4 literals | 10/8, 172.16/12, 192.168/16, 127/8, 0/8, 169.254.169.254, 100.64/10, 198.18/15, 192.0.0/24, TEST-NET-1, multicast, 240/4 → non-2xx HTTP answer | FAIL |
| loopback encodings | `2130706433`, `0x7f.0.0.1`, `127.1`, `0177.0.0.1` → non-2xx | FAIL |
| IPv6 literals | `::1`, `::`, `fc00::/7`, `fe80::/10`, `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, NAT64 `64:ff9b::a9fe:a9fe`, `2001:db8::/32` → non-2xx | FAIL |
| names the proxy resolves | `localhost`, `localtest.me` (→127.0.0.1), `10.0.0.1.nip.io`, `169.254.169.254.nip.io` → non-2xx | FAIL |
| plain HTTP forward / non-443 port | non-2xx | FAIL |
| DNS rebinding | name alternating public / *this probe container's* private IP, 20 tries; the probe listens there as a canary — **zero canary connections** (a 200 alone is fine: it resolved public that time) | FAIL, or exit 4 `REBINDING_NOT_TESTED` if no host given |

A socket error or timeout after a good preflight is **ambiguous** and counts as FAIL: an unreachable
target looks identical to a policy denial. (The previous probe counted refused/timeout as blocked, so a
dead proxy printed `ALL_BLOCKED` and exited 0 — reproduced on 2026-11-19; regression tests in
`apps/worker/tests/egress-probe.test.ts`, which exercise the probe's verdict logic against local stub
proxies only.)

**Known configuration defects fixed here, still to be verified on the pinned image:**

- The deny list used to be passed as a `DENY_RANGES` environment variable. Smokescreen reads deny ranges
  only from `--deny-range` (repeatable) or `--config-file` — none of its flags has an environment source
  (`cmd/smokescreen.go`, upstream `master`) — so that list was silently ignored. Smokescreen's built-in
  private-range default still applied, but the extra ranges (e.g. NAT64 `64:ff9b::/96`, documentation
  and benchmark ranges) were not enforced as written. `docker-compose.yml` now passes `--deny-range`.
- The image is `stripe/smokescreen:latest`. Acceptance on `:latest` is invalid; pin by digest after an
  approved supply-chain review and run the probe against exactly that digest.

**Web-tier ordering (verified 2026-11-19 over real HTTP, isolated harness):** with no
`CONNECT_EGRESS_PROXY` the snapshot route answers 503 `EGRESS_UNAVAILABLE` before any DNS or socket. With
a proxy configured, the web tier first runs its own pre-check (`assertPublicEndpoint`, defence in depth)
and refuses private or unresolvable targets with one uniform 422 — deliberately uniform, so it is not an
oracle for which internal names exist. Only then does it send `CONNECT <hostname>:443`; the proxy does the
final resolution. Consequence for deployment: the web tier needs working public DNS. On a network where
it has none, every discovery fails with 422 rather than 503.

The 14/14 smoke test in `docs/connect/broker-egress.md` ran against a throwaway harness on 2026-11-14
(the allowlist refused everything, so rule 3's DNS check was never triggered). It is not acceptance.

## 7. Deployment steps (NOT executed â€” owner approval required)

1. Build/run the Smokescreen container (read-only, `--cap-drop ALL`,
   `no-new-privileges`, non-root, no published ports) on the internal network.
2. Set `CONNECT_EGRESS_PROXY=http://egress-proxy:3128` for the app containers.
3. Pin the image by digest, then run `egress-probe.cjs` (with `PROBE_REBIND_HOST`) and confirm it
   prints `ALL_BLOCKED` and exits 0. Any other exit code blocks activation.
4. Only then enable customer-MCP activation for real endpoints.
