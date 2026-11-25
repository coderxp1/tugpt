# Egress proxy (S0.1) — deployment groundwork, NOT deployed

Status: **groundwork only.** Deploying and verifying this proxy is
checkpoint **CP-2** and needs paul's separate approval. Until CP-2 passes,
customer MCP execution and platform calls stay disabled in production
(the code fails closed with EGRESS_UNAVAILABLE).

## Why

Every outbound MCP call (customer track and platform track) must leave
through a controlled egress proxy (`createEgressMcpFetch` /
`CONNECT_EGRESS_PROXY`) so that:

- server-side request forgery is bounded by an allowlist, not by trust in
  endpoint URLs (the runtime's own SSRF floor is defense-in-depth);
- TLS is terminated/inspected at one point (SEC-1.7: TLS + DNS behaviour
  at the proxy is part of the security test plan);
- DNS rebinding is pinned down: the proxy resolves once and connects to
  the validated address.

## Choice

**Smokescreen** (Stripe) — a CONNECT proxy built for exactly this:
domain allowlists, deny-by-default for private/loopback/link-local/
metadata ranges, and per-request audit logging.

## Files

- `smokescreen.yaml` — proxy configuration (listen address, timeouts,
  deny ranges, audit log destination).
- `acl.yaml` — access policy: default deny; allow `:443` only for the
  domains an operator has explicitly listed. Customer MCP endpoints are
  arbitrary customer servers, so the customer-track policy decision
  (allowlist vs. deny-private-only) is part of CP-2's security review —
  the platform track is strictly allowlist (provider domains only).

## CP-2 verification checklist (run at deployment, in order)

1. Proxy denies RFC1918, loopback, link-local and 169.254.169.254 targets
   even when the domain is allowlisted (DNS rebinding test).
2. Proxy refuses non-443 ports and non-CONNECT methods per policy.
3. A TuGPT staging build with `CONNECT_EGRESS_PROXY` set completes a
   customer MCP discovery + call and a platform discovery through the
   proxy; with the proxy stopped, both fail closed (no direct egress).
4. Proxy audit logs show source, host, bytes and decision for each call;
   logs contain no Authorization headers or credential material (SEC-3.8).
5. Direct outbound internet access from the app hosts is firewalled off
   (the proxy is the only egress path).

## S0.3 note (broker-side OAuth code exchange)

MCP OAuth (customer A2 + platform B4) uses RFC 7591 dynamic client
registration with **public clients + PKCE S256** — there is no client
secret for the web process to hold, and tokens land in the broker
immediately after exchange. Moving the code exchange itself into the
broker service remains a hardening option for built-in providers; it is
not a blocker for either MCP track and is intentionally not bundled
into CP-2.
