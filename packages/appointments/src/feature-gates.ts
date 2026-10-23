/**
 * Per-organization feature gating for provider integrations.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The `GoogleFreeBusyProvider` takes `enabled` in its constructor because
 * this package has no database access (`index.ts` says so). Something has to
 * turn the organization's stored flag into that boolean, per organization, at
 * composition time. This module is that something — against an injected
 * reader, so the gating logic is testable offline and the composition root
 * supplies the actual database query. The intended backing is the database
 * RPC `public.is_feature_enabled(p_organization_id, p_flag_key)` — the
 * repo's legitimate per-organization gate, which ANDs a global
 * `feature_flags` row with the org's row and treats a missing row as false.
 * (Per `@tugpt/feature-flags`' own rule, per-organization capabilities belong
 * in that RPC, never in the hardcoded kill-switch map.)
 *
 * The rules are deliberately asymmetric:
 *
 *   - An explicit enabled row turns the provider ON for that organization.
 *   - Everything else — disabled row, no row, a reader that throws — leaves
 *     it OFF. Gating errors must never enable a provider by accident: a
 *     flags-table outage that silently exposed every organization to a
 *     half-configured integration is strictly worse than the integration
 *     being off while the flags table is repaired.
 *
 * Disabled means the provider answers `NOT_CONFIGURED` without touching the
 * network. See `GoogleFreeBusyProvider` for the flag semantics at the
 * provider level.
 */

import {
  GoogleFreeBusyProvider,
  GOOGLE_FREEBUSY_FLAG_KEY,
  type FreeBusyFetch,
  type GoogleFreeBusyProviderOptions,
} from './google-freebusy-provider.js';

/**
 * Reads one organization's stored feature flag. The intended implementation
 * is a thin call to `public.is_feature_enabled(p_organization_id,
 * p_flag_key)`, wrapped as `{ isEnabled: <rpc result === true> }`. Returning
 * `null` means "unset", which this package treats as disabled — mirroring
 * the RPC, which treats a missing row as false.
 */
export interface FeatureFlagReader {
  readFlag(
    organizationId: string,
    flagKey: string
  ): Promise<{ readonly isEnabled: boolean } | null>;
}

/**
 * Whether the Google free/busy integration is enabled for an organization.
 * Fail-closed: a missing row or a reader error is "no".
 */
export async function isGoogleFreeBusyEnabledForOrg(
  reader: FeatureFlagReader,
  organizationId: string
): Promise<boolean> {
  try {
    const row = await reader.readFlag(organizationId, GOOGLE_FREEBUSY_FLAG_KEY);
    return row?.isEnabled === true;
  } catch {
    return false;
  }
}

export interface GoogleFreeBusyIntegrationOptions {
  readonly organizationId: string;
  readonly flagReader: FeatureFlagReader;
  /**
   * The organization's Google credentials, bound per organization (see
   * `GoogleFreeBusyProviderOptions.getAccessToken`).
   */
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchFn?: FreeBusyFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Build the per-organization provider with its flag resolved.
 *
 * Construction is async because the flag is stored state. The returned
 * provider is fully constructed either way: when the flag is off it is the
 * same `GoogleFreeBusyProvider` answering `NOT_CONFIGURED`, so a caller
 * never needs to branch on whether an integration is live — it asks, and
 * gets an honest answer.
 */
export async function createGoogleFreeBusyProvider(
  options: GoogleFreeBusyIntegrationOptions
): Promise<GoogleFreeBusyProvider> {
  const enabled = await isGoogleFreeBusyEnabledForOrg(
    options.flagReader,
    options.organizationId
  );

  const providerOptions: GoogleFreeBusyProviderOptions = {
    enabled,
    getAccessToken: options.getAccessToken,
    ...(options.refreshAccessToken === undefined
      ? {}
      : { refreshAccessToken: options.refreshAccessToken }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  return new GoogleFreeBusyProvider(providerOptions);
}
