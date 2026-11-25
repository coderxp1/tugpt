# ADR-022 — Platform-Owned MCP Integrations

**Status:** Accepted (2026-11-25, paul — architecture acceptance + implementation GO)
**Filing note:** approved as "ADR-020 — platform-owned MCP" in the 2026-11-25 product documents; filed under ADR-022 because ADR-020 in this repository is the tool-registry and agent-runtime ADR. Supersedes the platform-owned draft of 2026-11-24.
**Date:** 2026-11-25
**Deciders:** paul (product owner) — decisions D1, D4, D5, D6 recorded 2026-11-25
**Scope:** TuGPT platform-operated connections to third-party MCP servers. First integration: **HeyGen** (video generation).
**Companion:** ADR-021 governs *customer-owned* MCP. This ADR governs *platform-owned* MCP. The two tracks share a runtime and nothing else (§D7).

---

## Context

TuGPT needs capabilities that are part of the product itself, operated on TuGPT's own commercial accounts — professional video generation is the first. Customers must receive the capability (ask for a video in Workspace, receive a finished video) without ever connecting, authenticating, selecting, or seeing the underlying provider.

The existing Connect implementation (ADR-021) models every connection as owned by an organisation or a user: `external_tool_endpoints.organization_id` is `NOT NULL`, `connected_accounts.owner_type ∈ ('organization','user')`, and the credential broker keys every operation by `(organizationId, connectionId)`. There is no platform owner anywhere in the model. Forcing platform connections into that model — e.g. via a reserved "system organisation" — was considered and **rejected** (decision D4): every org-member listing, capability query, and broker call would become a permanent leak risk, and platform governance (who approves a snapshot, who sets policy) does not map onto org roles.

Separately, ADR-019 D1 (2026-09-28) excluded hosted/paid video routes in favour of the self-hosted engine. Field experience since then — WAN output quality, no production-grade voiceover/music — led paul to reverse that for video (2026-11-24): HeyGen becomes the primary video generator. This ADR therefore **supersedes ADR-019 D1 for video only**. ADR-019 continues to govern images (FLUX) unchanged.

## Decision

### D1 — Platform ownership is a first-class concept
The schema gains platform ownership as its own kind: platform endpoints and platform connections live in a **separate platform registry** (new tables, e.g. `platform_tool_endpoints`, `platform_tool_snapshots`, `platform_tools`, `platform_connections`), not in the org-scoped registry with a flag. Platform rows carry no `organization_id`. RLS on platform tables grants **no access to any org role** (`authenticated`, org service contexts); only the platform service identity and platform-operator admin paths can read them.

### D2 — Separate credential namespace in the broker
The credential broker gains a **platform scope** distinct from its org scope: platform credentials are stored, refreshed, and audited under platform keys, and **no org-scoped broker operation can address a platform credential** (and vice versa). Platform entries in `credential_access_log` use a platform caller identity. Encryption, locked refresh with compare-and-swap, short-lived token hand-out, and the "refresh tokens never returned" rule apply unchanged.

### D3 — Platform administration is platform-only
Platform endpoints are registered, discovered, snapshotted, approved, classified, activated, and deactivated exclusively through platform-operator surfaces (admin routes/UI restricted to TuGPT operators). No customer Dashboard page, customer API route, or org role (including org owner) can create, view, modify, or delete a platform connection, its snapshot, its tools, or its credential metadata.

### D4 — Invisibility is a hard boundary, tested not assumed
Org-facing surfaces — Connect UI, `/api/v1/connect/*`, `list_chat_capabilities`, model tool definitions, error messages, usage views — must contain **no platform provider identity**: no provider name, endpoint URL, remote tool names, or connection metadata. Org chats interact with platform capabilities only through **capability-shaped tools** defined by TuGPT (e.g. a video-generation capability), whose definitions are TuGPT's own. This boundary is verified by the leak tests in the security test plan (§Platform isolation), not by code review alone.

### D5 — HeyGen connection (first platform integration)
- Endpoint: HeyGen's MCP server, `https://mcp.heygen.com/mcp/v1/` (resource URI exactly `/mcp/v1`).
- Authentication: OAuth 2.0 authorization-code + PKCE against HeyGen's authorization server, performed once by a TuGPT operator on the **designated TuGPT HeyGen account** (the existing Pro account, confirmed by paul 2026-11-24). Tokens are held only in the broker's platform scope; a HeyGen `TokenRefresher` participates in the broker's locked refresh cycle.
- Discovery: on registration (and on operator demand), the platform resolver fetches a fresh access token and calls `listExternalMcpTools` with `authHeader: 'Bearer …'`; the result is stored as a platform snapshot (~130 tools at time of writing).
- Classification: the platform operator classifies tools. Generation tools are treated as **financial-class in effect** (they consume platform credits) and are governed by D6 policy — not by the customer track's per-call approval cards.

### D6 — Execution policy for platform capabilities
Platform capabilities execute under **platform policy + org entitlement**, not per-call customer approval:
- An org may use a platform capability only if its plan/entitlement includes it (existing entitlement/feature machinery; flags alone are not entitlements, per ADR-015).
- Consumption is metered per org and per job against **configurable** per-org allowances. No numeric allowance is set by this ADR or by code defaults; allowances are set by paul after measured cost data exists (see D8).
- The customer-facing interaction is the *request itself* ("make me a commercial video") — the approval-card pattern of ADR-021 does not apply to platform capabilities. TuGPT's own operational controls (kill switch per capability, per-org disable) sit with platform operators.

### D7 — Shared runtime, separate everything else
Platform execution reuses the ADR-021 runtime components: the MCP client transport (`connect-runtime`), the egress proxy discipline, the runtime check order, snapshot/permission concepts, and the broker's custody machinery. It does **not** reuse: the org registry tables, org approval routes, org capability queries, or `resolve_mcp_execution`. A dedicated **platform resolver** resolves platform endpoints, injects broker-held tokens, and re-checks platform snapshot approval and entitlement on every invocation.

### D8 — Media delivery goes through media jobs, never through the model context
The chat MCP path is synchronous, text-only, and output-capped — unsuitable for minutes-long generation. Platform video generation therefore runs as: chat tool call → create `media_jobs` row (org, user, capability, request) → worker executes against the platform HeyGen connection (submit; persist external id before polling; poll to completion) → MP4 stored in TuGPT Storage under the requesting org's namespace → job completion surfaces the video in the Workspace conversation. **If the platform provider fails, the job fails with a proper error. There is no silent fallback to any other generation engine.**
Measured credit consumption is recorded per job (balance before/after, the Phase 0 method) and attributed to both the requesting org/user and the platform connection (dual-attribution audit). No customer pricing or limits are derived until that measured data has been reviewed by paul.

### D9 — Audit
Every platform invocation writes an append-only audit row: requesting org, requesting user, platform endpoint, capability, outcome, error code, duration, arguments hash (never raw arguments), and measured provider cost where applicable. The audit write is fail-closed for billable operations: if the audit row cannot be written, the generation does not proceed.

## Consequences

- New schema (platform registry + broker platform scope) and new admin surface are required before any platform connection can exist; this is Plan B in the implementation sequence.
- The customer track (ADR-021) is unaffected by this ADR except where the shared runtime changes — such changes must keep both tracks' test suites green.
- HeyGen becomes a hard dependency for the video capability; its failure mode is a visible job error (D8), and platform operators need a capability kill switch (D6).
- Credit exposure is bounded by configurable allowances (D6) and by the standing hard cap paul sets for test phases (**320 credits cumulative for the current test phase**, decision D6 of 2026-11-25; **20 credits spent** on Phase 0 Test 1, **300 remain**). **No additional credit expenditure, and no authorisation of the production HeyGen account for any new purpose, may occur without paul's explicit approval** — this binds every phase of Plan B, including staging evidence runs (B8).

## Alternatives considered

- **Reserved system organisation** — rejected (D4 rationale, and paul's explicit decision D4 of 2026-11-25).
- **Customers connect their own HeyGen accounts (BYO)** — rejected by paul 2026-11-24 for platform capabilities; BYO remains the customer track's model for *their* tools under ADR-021.
- **Direct HeyGen API integration instead of MCP** — rejected: the product strategy is a generic MCP client; HeyGen is reached the same way any future platform MCP service will be.
