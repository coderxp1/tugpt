/**
 * GET /api/v1/chat/capabilities/models: the assistant capabilities this caller can
 * choose (CONF-1, contract `chat-model-capabilities/1`).
 *   200 { contract, capabilities: [{ id, label, description, available, reasonCode, features: { toolCalling } }],
 *         defaultCapabilityId }   (defaultCapabilityId null = nothing configured; chat unavailable)
 *   401 no session
 * Ids are opaque and stable; the server maps them to its routes. No provider, model,
 * endpoint, infrastructure or routing data is ever returned. Private, no-store.
 * Send `capabilityId` (or the `modelKey` alias) back on thread create / send / agent save.
 */
import { NextResponse } from 'next/server';
import { chatContext, PRIVATE_HEADERS } from '@/lib/chat/request';
import { capabilityCatalogue } from '@/lib/chat/capability-catalogue';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(capabilityCatalogue(), { headers: PRIVATE_HEADERS });
}
