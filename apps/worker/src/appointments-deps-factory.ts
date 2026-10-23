import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AppointmentsService,
  AvailabilityService,
  GoogleFreeBusyProvider,
  GOOGLE_FREEBUSY_SCOPE,
  GOOGLE_OAUTH_PROVIDER,
  GOOGLE_CALENDAR_SECRET_NAME,
  GOOGLE_OAUTH_CLIENT_SECRET_NAME,
  GOOGLE_TOKEN_URL,
  isGoogleFreeBusyEnabledForOrg,
  SupabaseAppointmentStore,
  type AppointmentStore,
  type FeatureFlagReader,
  type FreeBusyFetch,
  type OrganizationTimeZoneConfig,
  type SupabaseClientLike,
} from '@tugpt/appointments';
import {
  keyRingFromEnv,
  readOrganizationSecret,
  readPlatformSecret,
  writeOrganizationSecret,
  type KeyRing,
} from '@tugpt/security';

/**
 * @file appointments-deps-factory.ts
 * @description The worker's composition root for the appointments slice:
 * builds, per organization, an `AppointmentsService` backed by the
 * Supabase store, the Google free/busy provider, and the organization's
 * trusted time zone.
 *
 * ===========================================================================
 * WHAT IS WIRED, AND WHAT IS DELIBERATELY NOT
 * ===========================================================================
 *
 * Wired: request persistence (`SupabaseAppointmentStore`, service-role
 * client), per-organization feature gating, the read-only Google free/busy
 * provider, and the trusted business time zone
 * (`organizations.time_zone` — never a customer-supplied override).
 *
 * NOT wired: any booking write. There is no booking slice in the
 * appointments package to compose — the provider exposes no write method
 * and the database refuses a CONFIRMED suggestion — and there will not be
 * one here until an authoritative booking integration exists.
 *
 * ===========================================================================
 * FAIL-CLOSED, IN EVERY LAYER
 * ===========================================================================
 *
 *   - Flag: read through the `is_feature_enabled` RPC (the only legitimate
 *     per-organization gate); an RPC error or a missing row is "off". Off
 *     means the provider answers NOT_CONFIGURED without any network call.
 *   - Credentials: the organization's Google OAuth credential lives in the
 *     vault (`organization_secrets`), encrypted, scoped to
 *     `GOOGLE_FREEBUSY_SCOPE`. A missing row, a decrypt failure, a malformed
 *     credential, or a credential granted under the wrong scope all resolve
 *     to "no token" — the provider then answers NOT_CONFIGURED. Nothing in
 *     this file throws for a credential problem, and no credential value is
 *     ever logged or interpolated into an error.
 *   - Refresh: access tokens are refreshed against Google's token endpoint
 *     only when a refresh token AND TuGPT's OAuth client credential (a
 *     platform secret) are both present. A failed refresh is "no token",
 *     not an exception. Refreshed credentials are written back to the vault
 *     best-effort: a write failure never fails the current request, it only
 *     means the next expiry refreshes again.
 *
 * ===========================================================================
 * WHY PER-ORGANIZATION, PER CALL
 * ===========================================================================
 *
 * `buildAppointmentsDeps` is cheap and shared (one store). The per-org
 * runtime is resolved per call, like `buildTranscriptionDeps` per job: a
 * flag flip, a credential rotation, or a time-zone change takes effect on
 * the next request rather than the next restart.
 */

/**
 * The vault names and the token URL are owned by the appointments
 * package's OAuth module (one definition for the worker, the web routes,
 * and the provider); re-exported here for this module's existing
 * consumers.
 */
export {
  GOOGLE_OAUTH_PROVIDER,
  GOOGLE_CALENDAR_SECRET_NAME,
  GOOGLE_OAUTH_CLIENT_SECRET_NAME,
  GOOGLE_TOKEN_URL,
};

const DEFAULT_FREEBUSY_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_SKEW_SECONDS = 60;

export interface AppointmentsDepsOptions {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Fetch implementation used for BOTH the free/busy query and the token
   * refresh. Defaults to the global `fetch`; tests inject a stub.
   */
  readonly fetchFn?: FreeBusyFetch;
  /** Fixed clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seam. Defaults to `keyRingFromEnv(env)`, read per organization call. */
  readonly keyRing?: KeyRing;
  /** Vault key id used when writing refreshed credentials back. Defaults to `env.TUGPT_SECRET_WRITE_KEY_ID`, then to skipping the write-back. */
  readonly writeKeyId?: string;
  /** See `OrganizationTimeZoneConfig`. Defaults to `env.PLATFORM_DEFAULT_TIME_ZONE`, then `'UTC'`. */
  readonly platformDefaultTimeZone?: string;
}

export interface OrganizationAppointments {
  readonly store: AppointmentStore;
  readonly service: AppointmentsService;
  /** The effective flag answer for this organization, for telemetry. */
  readonly freeBusyEnabled: boolean;
  readonly timeZoneConfig: OrganizationTimeZoneConfig;
}

export interface AppointmentsDeps {
  readonly store: AppointmentStore;
  forOrganization(organizationId: string): Promise<OrganizationAppointments>;
}

/** The JSON shape stored in the organization's `calendar_oauth` secret. */
interface GoogleOAuthCredential {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
}

interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asJsonObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads `GOOGLE_FREEBUSY_TIMEOUT_MS`, falling back to the default. A
 * malformed value falls back rather than throwing — the same discipline as
 * `resolveMaxMediaBytes`: a mistyped timeout must not take the worker down.
 */
export function resolveFreeBusyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.GOOGLE_FREEBUSY_TIMEOUT_MS;
  if (!raw) return DEFAULT_FREEBUSY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FREEBUSY_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Reads `GOOGLE_OAUTH_EXPIRY_SKEW_SECONDS`, falling back to the default. */
export function resolveTokenSkewSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.GOOGLE_OAUTH_EXPIRY_SKEW_SECONDS;
  if (!raw) return DEFAULT_TOKEN_SKEW_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TOKEN_SKEW_SECONDS;
  return Math.floor(parsed);
}

/**
 * The flag reader the appointments package expects, backed by the
 * `is_feature_enabled` RPC. An RPC error resolves to null (unset) so the
 * gate fails closed — mirroring `DraftWorker.checkFeatureFlag`.
 *
 * NOTE: no file in this factory names the underlying table. The RPC is the
 * sanctioned reader and the only thing this code calls.
 */
function rpcFeatureFlagReader(client: SupabaseClient): FeatureFlagReader {
  return {
    async readFlag(organizationId: string, flagKey: string) {
      const { data, error } = await client.rpc('is_feature_enabled', {
        p_organization_id: organizationId,
        p_flag_key: flagKey,
      });
      if (error || typeof data !== 'boolean') {
        return null;
      }
      return { isEnabled: data };
    },
  };
}

/**
 * Per-organization Google token source. Every method resolves null on any
 * problem and never throws: the provider maps null to NOT_CONFIGURED, which
 * is the honest answer for "we cannot authenticate as this organization".
 */
class GoogleOrgTokenSource {
  constructor(
    private readonly client: SupabaseClient,
    private readonly organizationId: string,
    private readonly options: {
      readonly keys: () => KeyRing;
      readonly fetchFn: FreeBusyFetch;
      readonly now: () => number;
      readonly skewSeconds: number;
      readonly writeKeyId: string | null;
    }
  ) {}

  /** A stored access token, refreshed first if it is expired or expiring. */
  async getAccessToken(): Promise<string | null> {
    const loaded = await this.loadCredential();
    if (loaded === null) return null;

    const { credential } = loaded;
    const expiresAtMs =
      credential.expiresAt === null ? Number.NaN : Date.parse(credential.expiresAt);
    const fresh =
      Number.isFinite(expiresAtMs) &&
      expiresAtMs - this.options.now() > this.options.skewSeconds * 1000;

    if (fresh) return credential.accessToken;
    return this.refreshAccessToken(loaded);
  }

  /**
   * Exchange the refresh token for a new access token. Called by the
   * provider after a 401, and by `getAccessToken` when the stored token is
   * expired. Resolves null when any input is missing or Google refuses.
   */
  async refreshAccessToken(
    loaded?: { credential: GoogleOAuthCredential } | null
  ): Promise<string | null> {
    const resolved = loaded ?? (await this.loadCredential());
    if (resolved === null) return null;
    const { credential } = resolved;
    if (credential.refreshToken === null) return null;

    const oauthClient = await this.loadOAuthClient();
    if (oauthClient === null) return null;

    let response: Awaited<ReturnType<FreeBusyFetch>>;
    try {
      response = await this.options.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: oauthClient.clientId,
          client_secret: oauthClient.clientSecret,
        }).toString(),
      });
    } catch {
      return null;
    }

    if (response.status !== 200) return null;

    let body: Record<string, unknown> | null;
    try {
      body = asJsonObject(await response.json());
    } catch {
      return null;
    }
    if (body === null) return null;

    const accessToken = nonEmptyString(body['access_token']);
    if (accessToken === null) return null;
    const expiresInSeconds =
      typeof body['expires_in'] === 'number' && body['expires_in'] > 0
        ? body['expires_in']
        : 3600;
    const newExpiresAt = new Date(
      this.options.now() + expiresInSeconds * 1000
    ).toISOString();
    const refreshed: GoogleOAuthCredential = {
      accessToken,
      // Google may rotate the refresh token; keep the old one when it does not.
      refreshToken: nonEmptyString(body['refresh_token']) ?? credential.refreshToken,
      expiresAt: newExpiresAt,
    };

    // Best-effort write-back: a failed write must not fail this request.
    await this.persistCredential(refreshed).catch(() => undefined);
    return accessToken;
  }

  /**
   * Load + decrypt + parse + scope-check the organization's credential.
   * Null for: no row, undecryptable, malformed JSON, missing token, or a
   * credential not granted under the free/busy scope (ADR-015 D8: refuse
   * before calling, not after a 403).
   */
  private async loadCredential(): Promise<{
    credential: GoogleOAuthCredential;
  } | null> {
    let value: Awaited<ReturnType<typeof readOrganizationSecret>>;
    try {
      value = await readOrganizationSecret(
        this.client,
        this.organizationId,
        GOOGLE_OAUTH_PROVIDER,
        GOOGLE_CALENDAR_SECRET_NAME,
        this.options.keys()
      );
    } catch {
      return null;
    }

    if (!value.scopes.includes(GOOGLE_FREEBUSY_SCOPE)) return null;

    const body = parseJsonObject(value.plaintext);
    if (body === null) return null;
    const accessToken = nonEmptyString(body['access_token']);
    if (accessToken === null) return null;

    return {
      credential: {
        accessToken,
        refreshToken: nonEmptyString(body['refresh_token']),
        expiresAt:
          nonEmptyString(body['expires_at']) ?? value.expiresAt ?? null,
      },
    };
  }

  /** TuGPT's OAuth client credential, from the platform vault. */
  private async loadOAuthClient(): Promise<GoogleOAuthClient | null> {
    let plaintext: string;
    try {
      plaintext = await readPlatformSecret(
        this.client,
        GOOGLE_OAUTH_PROVIDER,
        GOOGLE_OAUTH_CLIENT_SECRET_NAME,
        this.options.keys()
      );
    } catch {
      return null;
    }
    const body = parseJsonObject(plaintext);
    if (body === null) return null;
    const clientId = nonEmptyString(body['client_id']);
    const clientSecret = nonEmptyString(body['client_secret']);
    if (clientId === null || clientSecret === null) return null;
    return { clientId, clientSecret };
  }

  private async persistCredential(
    credential: GoogleOAuthCredential
  ): Promise<void> {
    const writeKeyId = this.options.writeKeyId;
    if (writeKeyId === null) return;
    await writeOrganizationSecret(
      this.client,
      this.organizationId,
      GOOGLE_OAUTH_PROVIDER,
      GOOGLE_CALENDAR_SECRET_NAME,
      JSON.stringify({
        access_token: credential.accessToken,
        refresh_token: credential.refreshToken,
        expires_at: credential.expiresAt,
      }),
      writeKeyId,
      this.options.keys(),
      { scopes: [GOOGLE_FREEBUSY_SCOPE], expiresAt: credential.expiresAt }
    );
  }
}

export function buildAppointmentsDeps(
  client: SupabaseClient,
  options: AppointmentsDepsOptions = {}
): AppointmentsDeps {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  // The appointments package describes the client structurally; the real
  // client's PostgREST builder satisfies that surface. The cast is the seam,
  // the same way apps/worker/src/index.ts treats its admin client.
  const store = new SupabaseAppointmentStore({
    client: client as unknown as SupabaseClientLike,
    now,
  });
  const flagReader = rpcFeatureFlagReader(client);
  const platformDefaultTimeZone =
    options.platformDefaultTimeZone ?? env.PLATFORM_DEFAULT_TIME_ZONE ?? 'UTC';
  const timeoutMs = resolveFreeBusyTimeoutMs(env);
  const fetchFn: FreeBusyFetch =
    options.fetchFn ?? ((url, init) => fetch(url, init));
  const keys = (): KeyRing => options.keyRing ?? keyRingFromEnv(env);
  const writeKeyId =
    options.writeKeyId ?? env.TUGPT_SECRET_WRITE_KEY_ID ?? null;

  return {
    store,
    async forOrganization(organizationId: string) {
      const tokenSource = new GoogleOrgTokenSource(client, organizationId, {
        keys,
        fetchFn,
        now,
        skewSeconds: resolveTokenSkewSeconds(env),
        writeKeyId,
      });

      const enabled = await isGoogleFreeBusyEnabledForOrg(
        flagReader,
        organizationId
      );
      const provider = new GoogleFreeBusyProvider({
        enabled,
        getAccessToken: () => tokenSource.getAccessToken(),
        refreshAccessToken: () => tokenSource.refreshAccessToken(),
        fetchFn,
        timeoutMs,
        now,
      });

      const organizationTimeZone =
        await store.getOrganizationTimeZone(organizationId);
      const timeZoneConfig: OrganizationTimeZoneConfig = {
        organizationTimeZone,
        platformDefaultTimeZone,
      };

      const service = new AppointmentsService({
        store,
        availability: new AvailabilityService(provider),
        timeZoneConfig,
      });

      return { store, service, freeBusyEnabled: enabled, timeZoneConfig };
    },
  };
}
