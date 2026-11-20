# Customer-MCP egress proxy: recommendation (M5)

Status: **recommendation only. Nothing is deployed, built, pulled or approved.**
Customer MCP stays disabled. `smokescreen:latest` (or any unpinned tag) is **not approved**.
Facts below were checked on 2026-11-19 against the upstream source at a fixed commit; anything not
executed is marked **UNVERIFIED**.

## 1. Decision summary

| Item | Recommendation |
|---|---|
| Software | Stripe Smokescreen, release `v0.1.0`, **commit `609eb8931420453daf5893509be0b25b21bd9edb`** (pin the commit, not the tag: the GitHub release is marked `immutable: false`) |
| Image | **Build it ourselves** from that commit and push it to our own registry, then reference it **only by digest** (`<registry>/tugpt/smokescreen@sha256:<digest>`) |
| Upstream images | **None to use.** `stripe/smokescreen` on Docker Hub returns 404, and an anonymous pull of `ghcr.io/stripe/smokescreen` is denied. Any image under that name is unofficial, so the old `image: stripe/smokescreen:latest` line was a typosquatting / name-claim risk. It has been replaced with a placeholder that cannot pull |
| Policy | No hostname ACL (customer endpoints are arbitrary). Every resolved address must be public unicast, the proxy connects to the address it checked, and any `allow_*` override is forbidden |
| Not enforced by Smokescreen (must be enforced elsewhere) | CONNECT-only, port 443-only, and no client-chosen upstream proxy. See §5 |
| Go | ≥ 1.25 (required by v0.1.0 release notes) |

## 2. Image provenance

### 2.1 Upstream reference values (from the GitHub API, 2026-11-19)

| Artifact | SHA-256 |
|---|---|
| tag `v0.1.0` → commit | `609eb8931420453daf5893509be0b25b21bd9edb` |
| `SHA256SUMS` | `c0f782a569aefc1455556a1f20b9d0c6b90296c78fcb72cf8014f9adf3a4b8bb` |
| `smokescreen_v0.1.0_linux_amd64.tar.gz` | `4e1e447449e3cc653dae956208588722b5c8fe8ce894f633adc756a851d1ec46` |
| `smokescreen_v0.1.0_linux_arm64.tar.gz` | `f15ddd0dc2b2cbc6d7318f441928939eb9bedfab2a1881508af3096a1e24b7c9` |

### 2.2 Build recipe (proposal; **not executed**)

The upstream repo has no `Dockerfile` at this commit (404), so we own the image definition:

```dockerfile
# Base images MUST be pinned by digest at review time:
#   docker buildx imagetools inspect golang:1.25-bookworm
#   docker buildx imagetools inspect gcr.io/distroless/static-debian12:nonroot
FROM golang:1.25-bookworm@sha256:<pin-at-review> AS build
ARG SMOKESCREEN_COMMIT=609eb8931420453daf5893509be0b25b21bd9edb
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/stripe/smokescreen \
 && git fetch -q --depth 1 origin "$SMOKESCREEN_COMMIT" && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$SMOKESCREEN_COMMIT"
RUN go mod verify && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/smokescreen .
RUN go test ./pkg/smokescreen/... ./cmd/...

FROM gcr.io/distroless/static-debian12:nonroot@sha256:<pin-at-review>
COPY --from=build /out/smokescreen /smokescreen
COPY smokescreen.yaml /etc/smokescreen/smokescreen.yaml
USER 65532:65532
ENTRYPOINT ["/smokescreen", "--config-file=/etc/smokescreen/smokescreen.yaml"]
```

- `CGO_ENABLED=0` means Go's own resolver is used, so there is no libc / `nsswitch` / `/etc/hosts` surprise path. The image contains no `/etc/hosts` entries beyond the runtime's.
- The upstream unit tests (`go test`) run inside the build. A failing test fails the build.
- Approval artifact: the **resulting image digest**, the two base-image digests, the `go version` used, and an SBOM (`syft`) plus vulnerability scan (`grype`/`trivy`) of that digest. Only that digest may appear in any compose or manifest.
- Cross-check: `smokescreen --help` from our build should list the same flags as §3, and a binary built from the release tarball (verified against `SHA256SUMS`) should give identical policy results in the §6 suite.

## 3. Configuration

Use a config file, not flags. Note that at this commit a CLI `--deny-range` / `--allow-range` **replaces** the file's list (`conf.SetDenyRanges(...)` in `cmd/smokescreen.go`), so passing both silently drops one. Pass only `--config-file`. YAML keys verified in `pkg/smokescreen/config_loader.go` at `609eb89`:

```yaml
# /etc/smokescreen/smokescreen.yaml  (proposal; not executed)
ip: 0.0.0.0
port: 3128
network: ip            # A and AAAA; IPv6 answers are classified like IPv4 ones
resolver_addresses:    # our dedicated resolver only (see section 4)
  - "10.98.0.53:53"    # placeholder: the egress resolver's address on mcp-egress
dns_timeout: 5s
connect_timeout: 10s
idle_timeout: 60s
read_header_timeout: 10s
max_concurrent_connect_tunnels: 256
max_concurrent_requests: 256
unsafe_allow_private_ranges: false
allow_ranges: []        # MUST stay empty: an allow range wins over every deny, even loopback
allow_addresses: []     # MUST stay empty
deny_ranges:            # belt and braces; most are also denied by built-in classification
  - 0.0.0.0/8
  - 10.0.0.0/8
  - 100.64.0.0/10
  - 127.0.0.0/8
  - 169.254.0.0/16
  - 172.16.0.0/12
  - 192.0.0.0/24
  - 192.0.2.0/24
  - 192.88.99.0/24
  - 192.168.0.0/16
  - 198.18.0.0/15
  - 198.51.100.0/24
  - 203.0.113.0/24
  - 224.0.0.0/4
  - 240.0.0.0/4
  - 255.255.255.255/32
  - ::/128
  - ::1/128
  - ::ffff:0:0/96
  - 64:ff9b::/96
  - 64:ff9b:1::/48
  - 100::/64
  - 2001::/32
  - 2001:db8::/32
  - 2002::/16
  - fc00::/7
  - fe80::/10
  - ff00::/8
  - <docker/host subnets of this deployment, e.g. the mcp-int and mcp-egress subnets>
# Deliberately absent: acl_file, mitm_ca_cert_file, mitm_ca_key_file, support_proxy_protocol,
# cert_file/key_file (internal network only), statsd_address unless a collector exists.
```

The container runs `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, non-root, with no published ports and Prometheus off.

**Config guard (required before deploy):** a CI check that fails if the proxy config contains any of `allow_ranges`/`allow_addresses` with entries, `unsafe_allow_private_ranges: true`, `mitm_*`, `acl_file`, or any CLI argument besides `--config-file`.

## 4. DNS policy

1. **The proxy is the only resolver path for customer hosts.** The app sends `CONNECT host:443` and never resolves customer hostnames itself on the request path. The pinning in §5.2 depends on that.
2. **Dedicated recursive resolver** (e.g. Unbound) on the `mcp-egress` network, set as `resolver_addresses`. It serves **no internal zones**: no split-horizon, no forwarding to Docker's embedded DNS (`127.0.0.11`), the cloud VPC resolver or corporate DNS. Docker service names (`postgres`, `egress-proxy`) and `*.internal` must return NXDOMAIN.
3. **Defence in depth at the resolver:** `private-address:` for every range in §3, so rebinding answers are stripped before they reach the proxy. `private-domain:` stays empty.
4. The resolver's own outbound traffic is limited to udp/tcp 53 (and 853 if DoT upstream is used) by firewall.
5. Caching: honour TTLs and do not raise them. Correctness never depends on TTL, because the proxy connects to the address it checked.
6. **App activation check:** `assertPublicEndpoint` resolves in-process at activation. On an `internal: true` network that lookup may fail or go through Docker's embedded DNS. It is a UX/defence-in-depth check only, never the security boundary. **UNVERIFIED:** its behaviour inside the target network must be confirmed by bypass test B16.

## 5. Private-address and rebinding protections

### 5.1 What Smokescreen does (source-verified at `609eb89`, `pkg/smokescreen/smokescreen.go`)

`classifyAddr` runs on **every** resolved IP, in this order:

1. Self-connection: the proxy's own IP on its own port → deny (`addrIsLocalIp`).
2. `!IsGlobalUnicast() || IsLoopback()` → deny (covers loopback, link-local incl. `169.254.169.254`, multicast, unspecified), **unless** matched by `allow_ranges`.
3. `allow_ranges` → allow. **This is why that list must stay empty.**
4. `deny_ranges` → deny.
5. IPv6 embedding IPv4 (NAT64, 6to4, Teredo, IPv4-mapped) → deny.
6. `IsPrivate()` (RFC 1918, `fc00::/7`) → deny unless `unsafe_allow_private_ranges`.
7. CGNAT `100.64.0.0/10` → deny.
8. Otherwise allow.

`selectTargetAddr` picks the **first allowed** IP from a mixed answer (public plus private gives the public one; all denied means the request is denied).

### 5.2 Rebinding

`dialContext` resolves once (`safeResolve`), stores `d.ResolvedAddr`, then calls `net.DialTimeout(network, d.ResolvedAddr.String(), …)`. It dials the **checked IP literal**, never the hostname, so there is no second lookup and no rebinding window inside the proxy. TLS is end to end (no MITM). The app validates the server certificate against the hostname, so a rebinding to another public IP still fails TLS unless the attacker holds a valid certificate for the customer's own hostname.

### 5.3 Gaps Smokescreen does *not* close, and who closes them

| Gap | Fact at `609eb89` | Required control |
|---|---|---|
| Plain HTTP proxying | Smokescreen proxies absolute-URI HTTP as well as CONNECT | Firewall on `mcp-egress`: allow tcp/443 only from the proxy. The app only sends CONNECT (undici `ProxyAgent`, https URLs) |
| Any port | No port allowlist; ACLs match hosts, not ports | Same firewall rule, **plus an app change before enabling** (see next row) |
| App accepts any HTTPS port and `http://localhost` | `assertHttpsEndpoint` / `assertPublicEndpoint` accept `https:` on any port and `http:` on loopback | **Pre-enable code change:** require port 443 (or empty), and allow the loopback-http exception only when `NODE_ENV=development`. Not fixed in M5 (recommendation only) |
| Client-chosen chained proxy | **Source-verified risk.** The `X-Upstream-Https-Proxy` request header is read in `checkACLsForRequest`. With no ACL that function returns allow early, and after `safeResolve` succeeds `selectUpstreamProxy` sets `SelectedUpstreamProxy = ClientRequestedProxy` (no `UpstreamProxySelector` configured), which is forwarded through `setUpstreamProxyHeader`. A caller can therefore ask the proxy to chain through a proxy of its choosing. Whether the dial to that proxy is re-checked by `safeResolve` (`dialContext` re-resolves when `OutboundHost != addr`) is **UNVERIFIED** | **Hard pre-deploy requirement:** neutralise it by building with an `UpstreamProxySelector` that ignores the client value, or by a small wrapper that deletes the header before Smokescreen sees it. The app never sets it. Bypass test **B12** must show no connection to the named proxy, private or public |
| Unauthenticated callers | No client TLS; anything on `mcp-int` can use the proxy | `mcp-int` contains only web and worker; no published ports |
| Redirects | n/a | App: MCP requests use `redirect: 'manual'` and any non-200 reply is refused (already in `external-mcp-tool.ts`) |

## 6. Bypass tests required before deployment

All run **against the exact digest proposed for deployment**, in an isolated staging network, never production. The proof of "no connection" is a packet capture on the proxy's egress interface plus the proxy's decision log, not only the HTTP status. Extend `egress-probe.cjs` and the test zone accordingly. Any failure blocks deployment.

| ID | Attack | Expected |
|---|---|---|
| B1 | `CONNECT 169.254.169.254:443`, `[fd00:ec2::254]:443`, `metadata.google.internal:443` | 403-class deny; no SYN on egress |
| B2 | Literals `127.0.0.1`, `127.1`, `0.0.0.0`, `[::]`, `[::1]`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `100.64.0.1` | deny |
| B3 | Odd encodings `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.000.000.001` | deny or NXDOMAIN; never a connection to loopback |
| B4 | IPv6 embedding: `[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`, `[64:ff9b::7f00:1]`, `[2002:7f00:1::]`, a Teredo address | deny |
| B5 | Test-zone names whose A/AAAA records are private, loopback, link-local, CGNAT or ULA | deny |
| B6 | **Rebinding:** test resolver with TTL 0 alternating public/private answers, ≥ 1000 iterations | every SYN goes to the public IP that was logged as checked; zero SYNs to private ranges |
| B7 | Mixed answers (public A + private A; private AAAA + public A) | connects only to the public address |
| B8 | CNAME chain ending at an internal name or private IP | deny |
| B9 | Self-connection: proxy IP or hostname `:3128` | deny (`self_connection`) |
| B10 | Docker names and gateways: `postgres:5432`, `egress-proxy:3128`, `host.docker.internal`, bridge gateway IP | NXDOMAIN or deny |
| B11 | Non-CONNECT: `GET http://169.254.169.254/` and `GET http://<public>:80/` via the proxy | first denied by the proxy; second dropped by the firewall |
| B12 | `CONNECT <public>:443` with `X-Upstream-Https-Proxy` set to `http://10.0.0.1:3128`, `http://127.0.0.1:3128` and an attacker-controlled **public** proxy | never a connection to the named proxy; direct tunnel to `<public>:443` or deny |
| B13 | Ports: `CONNECT <public>:22/25/6379/8443` | dropped by the firewall; app refuses non-443 endpoint URLs |
| B14 | Direct egress from web/worker containers: TCP 443 to a public IP, UDP 53 to `8.8.8.8`, UDP 443 (QUIC), IPv6 | all fail (no route) |
| B15 | App with `CONNECT_EGRESS_PROXY` unset, or proxy down | activation 409 (`decideActivation`); calls fail closed with `PROVIDER_UNAVAILABLE` (proved in-harness by M5 HTTP case C9; re-run against staging) |
| B16 | `assertPublicEndpoint` inside `mcp-int` for a public name and a private name | documented behaviour; it must never be the only control |
| B17 | Trailing dot / case: `LOCALHOST.`, `Metadata.Google.Internal.` | deny |
| B18 | Zone-id literal `[fe80::1%25eth0]` | deny |
| B19 | Exhaustion: 2× `max_concurrent_connect_tunnels`, slow headers, DNS that never answers | limits enforced; DNS times out at 5 s; proxy stays healthy |
| B20 | Config guard: CI fails on a config with `allow_ranges`, `unsafe_allow_private_ranges: true` or `mitm_*` | CI red |
| B21 | Provenance: running digest = built digest; `docker inspect` shows non-root, read-only, no caps, no ports | match |
| B22 | Logs | one decision line per request; no headers, no bodies, no tokens |

## 7. What remains before anyone may deploy

1. Approve the build recipe, then build and record the digests (§2.2). Run the SBOM and vulnerability scan.
2. Neutralise `X-Upstream-Https-Proxy` (§5.3) and prove it with B12.
3. App change: port-443-only and dev-only loopback (§5.3). This needs its own milestone, its own tests and Agent 1 review.
4. Firewall rules for `mcp-egress` (tcp/443 from the proxy, DNS from the resolver only). Requires explicit approval; none have been made.
5. Run B1–B22 against the digest and attach evidence.
6. Then, and only then, a separate approval to enable customer MCP for a pilot tenant.
