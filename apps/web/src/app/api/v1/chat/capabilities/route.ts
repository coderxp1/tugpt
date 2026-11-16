import { NextResponse } from 'next/server';
import { chatContext, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { listCapabilities } from '@/lib/chat/store';
import { toolAvailable } from '@/lib/chat/connect';
import { loadChatToolRegistry } from '@/lib/chat/mcp';

export const dynamic = 'force-dynamic';

/** The @-picker: every catalogue capability with the caller's real state. */
export async function GET(request: Request) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rows = await listCapabilities(ctx.db, ctx.tenant.organizationId);
    // Built-in tools plus runnable customer MCP tools; the MCP gate (lib/chat/mcp.ts) keeps MCP off unless provably runnable.
    const registry = await loadChatToolRegistry(ctx.db, ctx.tenant.organizationId);
    // connectionId stays server-side: the browser selects capabilities, the server picks the connection.
    const capabilities = rows.map((r) => ({
      capabilityKey: r.capabilityKey, providerKey: r.providerKey, providerName: r.providerName,
      description: r.description, permissionClass: r.permissionClass, state: r.state,
      // false: listed, but chat cannot run it here (no tool on this build, or MCP not provably runnable).
      toolAvailable: toolAvailable(r, registry),
    }));
    return NextResponse.json({ capabilities }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}
