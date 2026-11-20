import type {
  TypedSupabaseClient,
  OrganizationRole,
  OrganizationLocale,
  Profile,
} from '@tugpt/database';
import { normalizeOrganizationLocale } from '@tugpt/database';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface TenantContext {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  /**
   * The language this organization's dashboard renders in (ADR-017).
   *
   * It rides on the tenant context rather than being fetched separately
   * because it is resolved from the same row, in the same round trip, by the
   * same membership check. A second query would be a second chance to
   * disagree about which organization is active.
   */
  locale: OrganizationLocale;
}

export class AuthService {
  constructor(private supabase: TypedSupabaseClient) {}

  /**
   * Google OAuth Sign-in
   */
  async signInWithGoogle(redirectTo: string) {
    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });

    if (error) throw error;
    return data;
  }

  /**
   * Email/Password Sign Up
   */
  async signUpWithEmail(email: string, password: string, fullName?: string) {
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
      },
    });

    if (error) throw error;
    return data;
  }

  /**
   * Email/Password Sign In
   */
  async signInWithEmail(email: string, password: string) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    return data;
  }

  /**
   * Request Password Reset Email
   */
  async resetPassword(email: string, redirectTo: string) {
    const { data, error } = await this.supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) throw error;
    return data;
  }

  /**
   * Update Password (authenticated session)
   */
  async updatePassword(newPassword: string) {
    const { data, error } = await this.supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) throw error;
    return data;
  }

  /**
   * Refresh Current Session
   */
  async refreshSession() {
    const { data, error } = await this.supabase.auth.refreshSession();
    if (error) throw error;
    return data;
  }

  /**
   * Sign Out
   */
  async signOut() {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw error;
  }

  /**
   * Get Current User Profile
   */
  async getCurrentUser(): Promise<AuthUser | null> {
    const { data: { user }, error } = await this.supabase.auth.getUser();
    if (error || !user) return null;

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    const profileData = profile as unknown as Profile | null;

    return {
      id: user.id,
      email: user.email || '',
      fullName: profileData?.full_name || user.user_metadata?.full_name || null,
      avatarUrl: profileData?.avatar_url || user.user_metadata?.avatar_url || null,
    };
  }

  /**
   * Get User Organizations & Roles
   */
  async getUserOrganizations(userId: string): Promise<TenantContext[]> {
    const { data, error } = await this.supabase
      .from('organization_members')
      .select('organization_id, role, created_at, organizations!inner(id, name, locale, deleted_at)')
      .eq('user_id', userId);

    if (error || !data) return [];

    type QueryRow = {
      organization_id: string;
      role: OrganizationRole;
      created_at?: string | null;
      organizations: {
        id: string;
        name: string;
        // Read as `unknown` on purpose. The column is constrained to ('es','en')
        // and typed as a closed union, but this is the boundary where a value
        // the database chose becomes a value the UI has to render, and a
        // rendering path is the wrong place to discover the union was wrong.
        locale?: unknown;
        deleted_at: string | null;
      } | null;
    };

    const rows = data as unknown as QueryRow[];

    // Deterministic order: the default active tenant (orgs[0]) must not depend
    // on PostgREST/heap row order. Oldest membership first, then organization id
    // as a stable tie-breaker. Sorted here rather than via .order() so the
    // contract holds regardless of the query builder.
    const joinedAt = (m: QueryRow) => {
      const t = typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN;
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    };

    return rows
      .filter((m) => m.organizations && !m.organizations.deleted_at)
      .sort((a, b) => {
        const ta = joinedAt(a);
        const tb = joinedAt(b);
        if (ta !== tb) return ta < tb ? -1 : 1;
        const ia = a.organizations!.id;
        const ib = b.organizations!.id;
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      })
      .map((m) => ({
        organizationId: m.organizations!.id,
        organizationName: m.organizations!.name,
        role: m.role,
        locale: normalizeOrganizationLocale(m.organizations!.locale),
      }));
  }

  /**
   * Resolve and validate server-side active tenant context for user.
   * If requestedTenantId is supplied, verifies user is a valid active member of that tenant.
   * If not supplied, defaults to the user's oldest active membership
   * (membership created_at ascending, organization id as tie-breaker).
   * Returns null if user has no access to requested tenant.
   */
  async resolveTenantContext(
    userId: string,
    requestedTenantId?: string | null
  ): Promise<TenantContext | null> {
    const orgs = await this.getUserOrganizations(userId);
    if (orgs.length === 0) return null;

    if (requestedTenantId) {
      const match = orgs.find((o) => o.organizationId === requestedTenantId);
      return match || null;
    }

    return orgs[0];
  }
}

