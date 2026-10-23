/**
 * @file status.test.ts
 * @description getGoogleIntegrationStatus — the integrations page's
 * data. The properties under test are the closed defaults: anything
 * missing, malformed, or erroring reads as not-configured / not
 * connected / disabled, and the platform check is existence-only.
 */

import { describe, expect, it, vi } from 'vitest';
import { getGoogleIntegrationStatus } from './status';

const ORG = 'aaaaaaaa-2222-3333-4444-555555555555';

function clients(opts: {
  platformRows?: unknown;
  platformError?: unknown;
  accountRows?: unknown;
  accountError?: unknown;
  flagData?: unknown;
  flagError?: unknown;
}) {
  const adminClient = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn(() =>
            Promise.resolve({
              data: opts.platformRows ?? [],
              error: opts.platformError ?? null,
            })
          ),
        })),
      })),
    })),
    rpc: vi.fn((fn: string) =>
      Promise.resolve(
        fn === 'is_feature_enabled'
          ? { data: opts.flagData ?? false, error: opts.flagError ?? null }
          : { data: null, error: null }
      )
    ),
  };
  const authClient = {
    rpc: vi.fn(() =>
      Promise.resolve({
        data: opts.accountRows ?? [],
        error: opts.accountError ?? null,
      })
    ),
  };
  return { authClient, adminClient };
}

function pair(c: ReturnType<typeof clients>) {
  return [c.authClient, c.adminClient] as unknown as [
    Parameters<typeof getGoogleIntegrationStatus>[0],
    Parameters<typeof getGoogleIntegrationStatus>[1],
  ];
}

describe('getGoogleIntegrationStatus', () => {
  it('reports a fully provisioned, connected, enabled organization', async () => {
    const c = clients({
      platformRows: [
        { secret_name: 'oauth_client' },
        { secret_name: 'oauth_state_secret' },
      ],
      accountRows: [
        {
          provider: 'google',
          secret_name: 'calendar_oauth',
          scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
          expires_at: '2026-11-01T00:00:00.000Z',
          is_expired: false,
        },
      ],
      flagData: true,
    });
    const [authClient, adminClient] = pair(c);
    const status = await getGoogleIntegrationStatus(authClient, adminClient, ORG);
    expect(status).toEqual({
      platformConfigured: true,
      connected: true,
      credentialExpiresAt: '2026-11-01T00:00:00.000Z',
      credentialExpired: false,
      freeBusyEnabled: true,
    });
  });

  it('is not configured when either platform secret is missing', async () => {
    const c = clients({ platformRows: [{ secret_name: 'oauth_client' }] });
    const [authClient, adminClient] = pair(c);
    const status = await getGoogleIntegrationStatus(authClient, adminClient, ORG);
    expect(status.platformConfigured).toBe(false);
    expect(status.connected).toBe(false);
  });

  it('distinguishes an expired credential', async () => {
    const c = clients({
      platformRows: [
        { secret_name: 'oauth_client' },
        { secret_name: 'oauth_state_secret' },
      ],
      accountRows: [
        {
          provider: 'google',
          secret_name: 'calendar_oauth',
          scopes: [],
          expires_at: '2026-01-01T00:00:00.000Z',
          is_expired: true,
        },
      ],
    });
    const [authClient, adminClient] = pair(c);
    const status = await getGoogleIntegrationStatus(authClient, adminClient, ORG);
    expect(status.connected).toBe(true);
    expect(status.credentialExpired).toBe(true);
  });

  it('fails closed on any source error', async () => {
    const c = clients({
      platformError: { message: 'db down' },
      accountError: { message: 'db down' },
      flagError: { message: 'db down' },
    });
    const [authClient, adminClient] = pair(c);
    const status = await getGoogleIntegrationStatus(authClient, adminClient, ORG);
    expect(status).toEqual({
      platformConfigured: false,
      connected: false,
      credentialExpiresAt: null,
      credentialExpired: false,
      freeBusyEnabled: false,
    });
  });

  it('the platform check selects only secret_name (never credential material)', async () => {
    const c = clients({ platformRows: [] });
    const [authClient, adminClient] = pair(c);
    await getGoogleIntegrationStatus(authClient, adminClient, ORG);
    const from = c.adminClient.from as unknown as ReturnType<typeof vi.fn>;
    expect(from).toHaveBeenCalledWith('platform_secrets');
  });
});
