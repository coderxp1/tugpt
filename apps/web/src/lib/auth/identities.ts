/**
 * Provider identities, as the account screen needs them.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN THE PAGE
 *
 * The rule this product has to keep is "one customer, one canonical UUID,
 * several provider subjects". Supabase already enforces the storage half of
 * that: `auth.identities` is keyed on `(provider, provider_id)` and a user row
 * is the canonical identity. What the app owes is the other half — never
 * *implying* an identity by email, and never showing a person two providers
 * they think are one account when they are not.
 *
 * So the normalization is kept out of the component: it has no React, no
 * network, and no Supabase import, which is what lets it be tested against the
 * shapes the provider actually returns (including the ones it returns badly —
 * a null provider, an identity with no email, a duplicate row).
 *
 * Explicit linking only: nothing here matches identities by email address.
 * Two identities are the same row only when Supabase says they are the same
 * row (`identity_id`).
 */

/** Providers the account screen offers to link explicitly. */
export const LINKABLE_PROVIDERS = ['github', 'google'] as const;

export type LinkableProvider = (typeof LINKABLE_PROVIDERS)[number];

/**
 * Dictionary keys for provider names. Typed as a closed union so a provider
 * without a translation is a compile error rather than a raw identifier on
 * screen — the same rule the rest of the dictionaries follow.
 */
export type ProviderLabelKey =
  | 'accounts.provider.github'
  | 'accounts.provider.google'
  | 'accounts.provider.email'
  | 'accounts.provider.other';

/** The subset of Supabase's `UserIdentity` this screen reads. */
export interface RawIdentity {
  readonly identity_id?: string | null;
  readonly provider?: string | null;
  readonly identity_data?: Record<string, unknown> | null;
  readonly created_at?: string | null;
  readonly last_sign_in_at?: string | null;
}

export interface LinkedIdentity {
  /** Stable key for React and for de-duplication. */
  readonly id: string;
  /** The provider's own identifier, lowercased. */
  readonly provider: string;
  readonly labelKey: ProviderLabelKey;
  readonly email: string | null;
  readonly createdAt: string | null;
  readonly lastSignInAt: string | null;
}

const KNOWN_PROVIDERS: Readonly<Record<string, ProviderLabelKey>> = {
  github: 'accounts.provider.github',
  google: 'accounts.provider.google',
  email: 'accounts.provider.email',
};

/**
 * Display order. Not alphabetical and not provider-declaration order: it is
 * "the identity you signed in with most recently" first is tempting and wrong
 * (the order would move under the reader), so it is fixed — the two OAuth
 * providers the linking journey uses, then email, then anything new.
 */
const PROVIDER_ORDER: readonly string[] = ['github', 'google', 'email'];

function labelKeyFor(provider: string): ProviderLabelKey {
  return KNOWN_PROVIDERS[provider] ?? 'accounts.provider.other';
}

function emailFrom(identity: RawIdentity): string | null {
  const value = identity.identity_data?.email;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Normalize what Supabase returns into something the screen can render.
 *
 * Three decisions worth stating:
 *
 *  * An identity with no provider is dropped rather than rendered as
 *    "unknown". There is nothing to show and nothing to link it to; a row
 *    saying "Other" with no email is noise on a security screen.
 *  * Duplicates are collapsed on `identity_id`, not on email. Two providers
 *    legitimately share one verified email address, and treating that as a
 *    duplicate is exactly the automatic email matching this product forbids.
 *  * Sorting is fixed so a re-render cannot reorder the list under the reader.
 */
export function normalizeIdentities(raw: readonly RawIdentity[]): LinkedIdentity[] {
  const seen = new Set<string>();
  const normalized: LinkedIdentity[] = [];

  for (const identity of raw) {
    const provider = (identity.provider ?? '').trim().toLowerCase();
    if (provider === '') continue;

    const id = identity.identity_id?.trim() || `${provider}:${emailFrom(identity) ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);

    normalized.push({
      id,
      provider,
      labelKey: labelKeyFor(provider),
      email: emailFrom(identity),
      createdAt: identity.created_at ?? null,
      lastSignInAt: identity.last_sign_in_at ?? null,
    });
  }

  return normalized.sort((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a.provider);
    const bi = PROVIDER_ORDER.indexOf(b.provider);
    const ar = ai === -1 ? PROVIDER_ORDER.length : ai;
    const br = bi === -1 ? PROVIDER_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return a.provider.localeCompare(b.provider);
  });
}

/** Is this provider already linked to this account? */
export function hasProvider(
  identities: readonly LinkedIdentity[],
  provider: string
): boolean {
  return identities.some((identity) => identity.provider === provider);
}

/**
 * Providers the person could still link, in a fixed order.
 *
 * Derived from what is already linked rather than from a separate "pending"
 * list, so the screen cannot offer a provider it already shows above.
 */
export function linkableProviders(
  identities: readonly LinkedIdentity[]
): LinkableProvider[] {
  return LINKABLE_PROVIDERS.filter((provider) => !hasProvider(identities, provider));
}
