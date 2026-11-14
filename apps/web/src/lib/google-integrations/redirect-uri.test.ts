/**
 * Post-OAuth redirects must land on the public origin, not the container's
 * bind address. Regression for the 2026-11-14 observation on
 * dashboard.tugpt.pro: the callback redirected to https://0.0.0.0:3000/...
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GOOGLE_CALLBACK_PATH,
  publicAppOrigin,
  resolveGoogleRedirectUri,
  settingsIntegrationsUrl,
} from './redirect-uri';

// What Next.js standalone sees behind the reverse proxy (HOSTNAME=0.0.0.0).
const INTERNAL = new Request('https://0.0.0.0:3000/api/v1/integrations/google/callback?code=x&state=y');

afterEach(() => {
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
});

describe('settingsIntegrationsUrl', () => {
  it('uses the pinned redirect URI origin, not the internal request origin', () => {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `https://dashboard.tugpt.pro${GOOGLE_CALLBACK_PATH}`;
    const url = settingsIntegrationsUrl(INTERNAL, { google: 'connected' });
    expect(url).toBe('https://dashboard.tugpt.pro/settings/integrations?google=connected');
    expect(url).not.toContain('0.0.0.0');
  });

  it('follows the staging host when staging pins its own redirect URI', () => {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `https://staging.dashboard.tugpt.pro${GOOGLE_CALLBACK_PATH}`;
    expect(settingsIntegrationsUrl(INTERNAL, { google: 'error', reason: 'invalid_callback' })).toBe(
      'https://staging.dashboard.tugpt.pro/settings/integrations?google=error&reason=invalid_callback'
    );
  });

  it('falls back to the request origin when nothing is pinned (local development)', () => {
    const local = new Request('http://localhost:3000/api/v1/integrations/google/callback');
    expect(settingsIntegrationsUrl(local, { google: 'revoked' })).toBe(
      'http://localhost:3000/settings/integrations?google=revoked'
    );
  });

  it('falls back instead of throwing when the pin is malformed', () => {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'not a url';
    expect(publicAppOrigin(new Request('http://localhost:3000/x'))).toBe('http://localhost:3000');
  });

  it('never takes the destination from the request query (no open redirect)', () => {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `https://dashboard.tugpt.pro${GOOGLE_CALLBACK_PATH}`;
    const hostile = new Request(
      'https://0.0.0.0:3000/api/v1/integrations/google/callback?next=https://evil.example&redirect_uri=https://evil.example'
    );
    const url = new URL(settingsIntegrationsUrl(hostile, { google: 'connected' }));
    expect(url.origin).toBe('https://dashboard.tugpt.pro');
    expect(url.pathname).toBe('/settings/integrations');
  });
});

describe('resolveGoogleRedirectUri', () => {
  it('returns the pinned URI verbatim', () => {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `https://dashboard.tugpt.pro${GOOGLE_CALLBACK_PATH}`;
    expect(resolveGoogleRedirectUri(INTERNAL)).toBe(`https://dashboard.tugpt.pro${GOOGLE_CALLBACK_PATH}`);
  });
});
