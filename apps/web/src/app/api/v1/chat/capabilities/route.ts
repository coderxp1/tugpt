import { NextResponse } from 'next/server';
import { chatContext, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { listCapabilities } from '@/lib/chat/store';
import { hasRegisteredTool } from '@/lib/chat/connect';

export const dynamic = 'force-dynamic';

/** The @-picker: every catalogue capability with the caller's real state. */
export async function GET(request: Request) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rows = await listCapabilities(ctx.db, ctx.tenant.organizationId);
    // connectionId stays server-side: the browser selects capabilities, the server picks the connection.
    const capabilities = rows.map((r) => ({
      capabilityKey: r.capabilityKey, providerKey: r.providerKey, providerName: r.providerName,
      description: r.description, permissionClass: r.permissionClass, state: r.state,
      // false: the catalogue lists it, but chat has no tool for it on this build.
      toolAvailable: hasRegisteredTool(r.capabilityKey, r.providerKey),
    }));
    return NextResponse.json({ capabilities }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}
