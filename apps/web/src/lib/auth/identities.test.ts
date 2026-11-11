import { describe, expect, it } from 'vitest';
import {
  hasProvider,
  linkableProviders,
  normalizeIdentities,
  type RawIdentity,
} from './identities';

const github = (overrides: Partial<RawIdentity> = {}): RawIdentity => ({
  identity_id: 'id-github-1',
  provider: 'github',
  identity_data: { email: 'owner@example.com', sub: '12345' },
  created_at: '2026-11-01T10:00:00.000Z',
  last_sign_in_at: '2026-11-11T09:00:00.000Z',
  ...overrides,
});

const google = (overrides: Partial<RawIdentity> = {}): RawIdentity => ({
  identity_id: 'id-google-1',
  provider: 'google',
  identity_data: { email: 'owner@example.com', sub: '67890' },
  created_at: '2026-11-01T10:05:00.000Z',
  last_sign_in_at: '2026-11-11T09:05:00.000Z',
  ...overrides,
});

describe('normalizeIdentities', () => {
  it('keeps two providers that share one verified email as two identities', () => {
    // The rule the whole linking journey rests on: same email is not the same
    // identity. Collapsing here would make the screen claim a link that does
    // not exist in auth.identities.
    const result = normalizeIdentities([github(), google()]);

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.provider)).toEqual(['github', 'google']);
  });

  it('reads the email from identity_data rather than the canonical user row', () => {
    const [identity] = normalizeIdentities([github()]);
    expect(identity.email).toBe('owner@example.com');
  });

  it('survives an identity with no email at all', () => {
    const [identity] = normalizeIdentities([github({ identity_data: {} })]);
    expect(identity.email).toBeNull();
    expect(identity.labelKey).toBe('accounts.provider.github');
  });

  it('labels the providers the journey uses and falls back for new ones', () => {
    const result = normalizeIdentities([
      github(),
      google(),
      { identity_id: 'id-email', provider: 'email', identity_data: { email: 'a@example.com' } },
      { identity_id: 'id-apple', provider: 'apple', identity_data: { email: 'a@example.com' } },
    ]);

    expect(result.map((i) => i.labelKey)).toEqual([
      'accounts.provider.github',
      'accounts.provider.google',
      'accounts.provider.email',
      'accounts.provider.other',
    ]);
  });

  it('drops a row with no provider instead of rendering "Other"', () => {
    const result = normalizeIdentities([{ identity_id: 'x', provider: null }]);
    expect(result).toEqual([]);
  });

  it('normalizes provider casing', () => {
    const [identity] = normalizeIdentities([github({ provider: '  GitHub ' })]);
    expect(identity.provider).toBe('github');
    expect(identity.labelKey).toBe('accounts.provider.github');
  });

  it('collapses a duplicate identity_id exactly once', () => {
    const result = normalizeIdentities([github(), github()]);
    expect(result).toHaveLength(1);
  });

  it('keeps an identity with the same provider but a different subject', () => {
    // Two GitHub accounts linked to one user is unusual but legal, and hiding
    // one would make the screen unable to explain which one is in use.
    const result = normalizeIdentities([
      github(),
      github({ identity_id: 'id-github-2', identity_data: { email: 'second@example.com' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('sorts deterministically regardless of the order Supabase returns', () => {
    const a = normalizeIdentities([google(), github()]).map((i) => i.provider);
    const b = normalizeIdentities([github(), google()]).map((i) => i.provider);

    expect(a).toEqual(['github', 'google']);
    expect(b).toEqual(['github', 'google']);
  });
});

describe('linkableProviders', () => {
  it('offers both providers to an account with none linked', () => {
    expect(linkableProviders([])).toEqual(['github', 'google']);
  });

  it('never offers a provider that is already linked', () => {
    expect(linkableProviders(normalizeIdentities([github()]))).toEqual(['google']);
    expect(linkableProviders(normalizeIdentities([github(), google()]))).toEqual([]);
  });

  it('treats an email/password identity as neither OAuth provider', () => {
    const identities = normalizeIdentities([
      { identity_id: 'id-email', provider: 'email', identity_data: { email: 'a@example.com' } },
    ]);
    expect(linkableProviders(identities)).toEqual(['github', 'google']);
  });
});

describe('hasProvider', () => {
  it('matches on the normalized provider, not the label', () => {
    const identities = normalizeIdentities([github()]);
    expect(hasProvider(identities, 'github')).toBe(true);
    expect(hasProvider(identities, 'google')).toBe(false);
  });
});
