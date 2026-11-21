/**
 * @file analytics-usage-route.test.ts
 * @description GET /api/v1/analytics/usage — usage v2 (migration 20261121700002).
 *
 * The route is thin: authenticate, resolve the active organization, map
 * `?range=`/`?bucket=`/`?scope=`, call `org_usage_report` on the USER's client
 * and hand the report back. These tests hold the thin parts honest:
 *   1. Auth and tenant: no user → 401; no active organization → 403.
 *   2. The RPC runs on the user's claims, with the resolved org id only.
 *   3. The window is a preset computed server-side; bucket/scope are closed sets.
 *   4. Scope defaults from role (owner/admin → organization, others → self) and
 *      the database's P3S02 refusal surfaces as 403 — the route never widens it.
 *   5. Errors are mapped, not leaked.
 *   6. No provider/model/cost ever appears in the response.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET } from "./usage/route";

const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createAuthenticatedServerClient: vi.fn(() =>
    Promise.resolve({ rpc: mockRpc }),
  ),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock("@tugpt/auth", () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

const ORG_ID = "aaaaaaaa-c057-0000-0000-0000000000a1";
const USER = { id: "user-1", email: "owner@espiga.test" };

function report(overrides: Record<string, unknown> = {}) {
  return {
    scope: "organization",
    bucket: "day",
    time_zone: "Europe/Madrid",
    window: {
      from: "2026-10-21T00:00:00.000Z",
      to: "2026-11-20T00:00:00.000Z",
    },
    totals: {
      requests: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      input_tokens: 1000,
      output_tokens: 500,
      audio_seconds: 0,
      unmetered_requests: 1,
      estimated_usage_requests: 0,
    },
    by_feature: [
      {
        feature: "chat",
        requests: 4,
        failed: 2,
        input_tokens: 1000,
        output_tokens: 500,
        audio_seconds: 0,
      },
    ],
    series: [
      {
        bucket_start: "2026-11-19",
        requests: 4,
        failed: 2,
        input_tokens: 1000,
        output_tokens: 500,
      },
    ],
    by_user: [
      {
        user_id: "u1",
        name: "Ana",
        email: "ana@espiga.test",
        is_member: true,
        requests: 4,
        input_tokens: 1000,
        output_tokens: 500,
      },
    ],
    unattributed_requests: 0,
    ...overrides,
  };
}

function setup(opts: { user?: unknown; tenant?: unknown; role?: string } = {}) {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(
    opts.user !== undefined ? opts.user : USER,
  );
  mockResolveTenantContext.mockResolvedValue(
    opts.tenant !== undefined
      ? opts.tenant
      : {
          organizationId: ORG_ID,
          organizationName: "Panadería La Espiga",
          role: opts.role ?? "owner",
        },
  );
  mockRpc.mockResolvedValue({ data: report(), error: null });
}

function request(query = "", tenant: string | null = ORG_ID) {
  const headers: Record<string, string> = {};
  if (tenant) headers["x-tenant-id"] = tenant;
  return new Request(`http://localhost/api/v1/analytics/usage${query}`, {
    headers,
  });
}

async function call(query = "", tenant: string | null = ORG_ID) {
  const res = await GET(request(query, tenant));
  return { res, body: await res.json() };
}

function rpcArgs() {
  return mockRpc.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => setup());

describe("authentication and tenant resolution", () => {
  it("A1: 401 when there is no user", async () => {
    setup({ user: null });
    const { res, body } = await call();
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("A2: 403 when there is no active organization", async () => {
    setup({ tenant: null });
    const { res, body } = await call();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("A3: resolves the tenant from the session with the requested x-tenant-id", async () => {
    await call();
    expect(mockResolveTenantContext).toHaveBeenCalledWith(USER.id, ORG_ID);
  });

  it("A4: responses are private and uncacheable, success and error alike", async () => {
    const ok = await call();
    expect(ok.res.headers.get("Cache-Control")).toBe("private, no-store");
    setup({ user: null });
    const denied = await call();
    expect(denied.res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("the membership-checked RPC", () => {
  it("R1: calls org_usage_report (not the provider/cost summary) with the resolved org", async () => {
    await call();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][0]).toBe("org_usage_report");
    expect(rpcArgs().p_organization_id).toBe(ORG_ID);
  });

  it("R2: never sends an organization id taken from the query string", async () => {
    await call(
      "?organization_id=dddddddd-0000-0000-0000-000000000000&p_organization_id=x",
    );
    expect(rpcArgs().p_organization_id).toBe(ORG_ID);
  });
});

describe("window, bucket and scope", () => {
  it("W1: defaults to 30d / day", async () => {
    const { body } = await call();
    expect(body.range).toBe("30d");
    expect(body.bucket).toBe("day");
    expect(rpcArgs().p_bucket).toBe("day");
  });

  it("W2: accepts each range preset and rejects anything else before calling", async () => {
    for (const range of ["7d", "30d", "90d"]) {
      setup();
      const { res } = await call(`?range=${range}`);
      expect(res.status).toBe(200);
    }
    for (const range of ["365d", "1y", "", "abc"]) {
      setup();
      const { res, body } = await call(`?range=${encodeURIComponent(range)}`);
      if (range === "") continue; // empty = default
      expect(res.status).toBe(400);
      expect(body.error.code).toBe("INVALID_QUERY");
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it("W3: from/to come from the server clock and span the preset", async () => {
    const before = Date.now();
    await call("?range=7d");
    const { p_from, p_to } = rpcArgs() as { p_from: string; p_to: string };
    const span = Date.parse(p_to) - Date.parse(p_from);
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    expect(Date.parse(p_to)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("W4: bucket=month is passed through; unknown buckets are rejected", async () => {
    await call("?bucket=month");
    expect(rpcArgs().p_bucket).toBe("month");
    setup();
    const { res, body } = await call("?bucket=week");
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_QUERY");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("S1: owner and admin default to organization scope", async () => {
    for (const role of ["owner", "admin"]) {
      setup({ role });
      await call();
      expect(rpcArgs().p_scope).toBe("organization");
    }
  });

  it("S2: every other role defaults to self scope", async () => {
    for (const role of ["manager", "agent", "viewer"]) {
      setup({ role });
      await call();
      expect(rpcArgs().p_scope).toBe("self");
    }
  });

  it("S3: an explicit scope is passed through; the database decides, and P3S02 becomes 403", async () => {
    setup({ role: "agent" });
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "P3S02",
        message: "Organization-wide usage requires owner or admin",
      },
    });
    const { res, body } = await call("?scope=organization");
    expect(rpcArgs().p_scope).toBe("organization");
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(body)).not.toContain("P3S02");
  });

  it("S4: an owner may narrow to self; unknown scopes are rejected", async () => {
    await call("?scope=self");
    expect(rpcArgs().p_scope).toBe("self");
    setup();
    const { res } = await call("?scope=everyone");
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("E1: P3J02 (non-member / nonexistent / deleted) becomes 403 with no raw code", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P3J02", message: "Organization not found" },
    });
    const { res, body } = await call();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(body)).not.toContain("P3J02");
  });

  it("E2: P3U03 (bad report parameters) becomes 400 INVALID_QUERY", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P3U03", message: "Invalid report parameters" },
    });
    const { res, body } = await call();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_QUERY");
  });

  it("E3: a privilege error (42501) is a generic 500, leaking nothing", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "42501",
        message: "permission denied for function org_usage_report",
      },
    });
    const { res, body } = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(
      /permission denied|org_usage_report|42501/,
    );
  });

  it("E4: a thrown error is caught and returns 500", async () => {
    mockRpc.mockRejectedValue(new Error("socket hang up"));
    const { res, body } = await call();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("socket");
  });
});

describe("the report", () => {
  it("P1: passes the report through with the request envelope", async () => {
    const { res, body } = await call("?range=7d");
    expect(res.status).toBe(200);
    expect(body.range).toBe("7d");
    expect(body.scope).toBe("organization");
    expect(body.report.totals.requests).toBe(4);
    expect(body.report.totals.unmetered_requests).toBe(1);
    expect(body.report.by_user).toHaveLength(1);
    expect(body).not.toHaveProperty("summary");
  });

  it("P2: no provider, model, price or cost keys anywhere in the response", async () => {
    const { body } = await call();
    expect(JSON.stringify(body)).not.toMatch(
      /provider|model|cost|micros|price|currency/i,
    );
  });

  it("P3: a NULL report from the wire becomes null, not a crash", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.report).toBeNull();
  });
});
