/**
 * Members of the caller's active organization, read through the caller's own
 * RLS-bound client ("Members can view organization member lists" and the
 * co-member profile policy). Read only: authenticated has no UPDATE/DELETE
 * grant on organization_members, so the Dashboard offers no role change or
 * removal until a backend operation for it exists.
 */
import { createAuthenticatedServerClient } from '@/lib/supabase/server';

export interface Member {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly joinedAt: string;
}

export async function loadMembers(organizationId: string): Promise<Member[] | null> {
  try {
    const db = await createAuthenticatedServerClient();
    const { data: rows, error } = await db.from('organization_members')
      .select('user_id, role, created_at').eq('organization_id', organizationId).order('created_at', { ascending: true });
    if (error || !rows) return null;
    const ids = rows.map((r) => r.user_id);
    const people = new Map<string, { full_name: string | null; email: string | null }>();
    if (ids.length) {
      const { data: profs, error: pe } = await db.from('profiles').select('id, full_name, email').in('id', ids);
      if (pe) return null;
      for (const p of profs ?? []) people.set(p.id, { full_name: p.full_name ?? null, email: p.email ?? null });
    }
    return rows.map((r) => ({
      userId: r.user_id, role: r.role, joinedAt: r.created_at,
      name: people.get(r.user_id)?.full_name ?? null, email: people.get(r.user_id)?.email ?? null,
    }));
  } catch { return null; }
}
