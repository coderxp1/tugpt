/**
 * Disconnect a provider (Google/Microsoft): revoke the credential through the
 * broker and mark the connected_accounts row revoked so the runtime stops
 * exposing it. Fails closed â€” a broker revoke failure throws and leaves the
 * connection untouched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrokerClient } from '@tugpt/credential-broker';

export type ConnectProvider = 'google' | 'microsoft';

export async function disconnectProvider(opts: {
  readonly db: SupabaseClient;
  readonly broker: BrokerClient;
  readonly provider: ConnectProvider;
  readonly organizationId: string;
}): Promise<{ connectionId: string | null }> {
  const { data, error } = await opts.db
    .from('connected_accounts')
    .select('id')
    .eq('organization_id', opts.organizationId)
    .eq('provider_key', opts.provider)
    .eq('owner_type', 'organization')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return { connectionId: null };
  const connectionId = (data[0] as { id: string }).id;

  const revoked = await opts.broker.revoke({ organizationId: opts.organizationId, connectionId });
  if (!revoked.ok) throw new Error('the credential broker could not revoke the credential');

  const { error: updErr } = await opts.db
    .from('connected_accounts')
    .update({ status: 'revoked' })
    .eq('id', connectionId)
    .eq('organization_id', opts.organizationId);
  if (updErr) throw new Error('failed to mark the connection revoked');

  return { connectionId };
}
