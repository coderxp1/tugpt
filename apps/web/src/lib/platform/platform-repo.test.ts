/**
 * Platform repository (B3) against a labelled fake of the admin client's
 * query-builder surface. Database behaviour (RLS, triggers, CHECKs) is
 * covered by pgTAP (platform_registry / platform_snapshot_approval).
 */
import { describe, expect, it } from 'vitest';
import { createPlatformRepository, PlatformRepoError } from './platform-repo';

type Row = Record<string, unknown>;

class Builder implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: [string, unknown][] = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private countExact = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count === 'exact') this.countExact = true;
    return this;
  }
  insert(payload: Row | Row[]) { this.op = 'insert'; this.payload = payload; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  order(col: string, opts: { ascending: boolean }) { this.ordering = { col, ascending: opts.ascending }; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private matching(): Row[] {
    let rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.ordering) {
      const { col, ascending } = this.ordering;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private execute(): { data: unknown; error: null; count?: number } {
    const table = (this.db.tables[this.table] ??= []);
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted = rows.map((r) => ({ id: `id-${++this.db.seq}`, created_at: '2026-11-25T00:00:00Z', ...r }));
      table.push(...inserted);
      return { data: inserted, error: null };
    }
    if (this.op === 'update') {
      for (const r of this.matching()) Object.assign(r, this.payload as Row);
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      const doomed = new Set(this.matching());
      this.db.tables[this.table] = table.filter((r) => !doomed.has(r));
      return { data: null, error: null };
    }
    if (this.countExact) return { data: null, error: null, count: this.matching().length };
    return { data: this.matching(), error: null };
  }

  then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  async maybeSingle() {
    const rows = this.matching();
    return { data: rows[0] ?? null, error: null };
  }
  async single() {
    const { data } = this.execute();
    const rows = data as Row[];
    return { data: rows[0], error: null };
  }
}

class FakeDb {
  tables: Record<string, Row[]> = { platform_connections: [], platform_tool_endpoints: [], platform_tool_snapshots: [], platform_tools: [] };
  seq = 0;
  from(table: string) { return new Builder(this, table); }
}

const TOOLS = [
  { name: 'generate_video', description: 'gen', inputSchema: { type: 'object' } },
  { name: 'list_avatars', description: 'list', inputSchema: { type: 'object' } },
];

describe('platform repository (B3)', () => {
  it('registers an endpoint with a pending OAuth platform connection', async () => {
    const db = new FakeDb();
    const repo = createPlatformRepository(db as never);
    const ep = await repo.registerEndpoint({ providerKey: 'heygen', url: 'https://mcp.heygen.test/mcp', displayName: 'HeyGen' });
    expect(ep.status).toBe('pending');
    expect(ep.connection).toMatchObject({ providerKey: 'heygen', credentialKind: 'oauth_token_set', status: 'requires_authorization' });
    expect(ep.latestSnapshot).toBeNull();
    expect(db.tables.platform_connections).toHaveLength(1);
  });

  it('snapshots version upward and count tools in the summary', async () => {
    const db = new FakeDb();
    const repo = createPlatformRepository(db as never);
    const ep = await repo.registerEndpoint({ providerKey: 'heygen', url: 'https://mcp.heygen.test/mcp', displayName: 'HeyGen' });
    const s1 = await repo.createSnapshot(ep.id, TOOLS, 'a'.repeat(64));
    expect(s1).toMatchObject({ version: 1, toolCount: 2, approved: false });
    const s2 = await repo.createSnapshot(ep.id, TOOLS, 'b'.repeat(64));
    expect(s2.version).toBe(2);
    const listed = await repo.listEndpoints();
    expect(listed[0].latestSnapshot).toMatchObject({ version: 2, toolCount: 2 });
  });

  it('approval classifies first, then approves; a second approval is a conflict', async () => {
    const db = new FakeDb();
    const repo = createPlatformRepository(db as never);
    const ep = await repo.registerEndpoint({ providerKey: 'heygen', url: 'https://mcp.heygen.test/mcp', displayName: 'HeyGen' });
    const s1 = await repo.createSnapshot(ep.id, TOOLS, 'a'.repeat(64));
    await expect(repo.approveSnapshot(s1.id, [{ name: 'nope', permissionClass: 'read' }])).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    await repo.approveSnapshot(s1.id, [{ name: 'generate_video', permissionClass: 'financial' }]);
    const tools = await repo.listSnapshotTools(s1.id);
    expect(tools.find((t) => t.name === 'generate_video')?.permissionClass).toBe('financial');
    expect(tools.find((t) => t.name === 'list_avatars')?.permissionClass).toBe('write');
    await expect(repo.approveSnapshot(s1.id, [])).rejects.toBeInstanceOf(PlatformRepoError);
  });

  it('activation requires an approved newest snapshot', async () => {
    const db = new FakeDb();
    const repo = createPlatformRepository(db as never);
    const ep = await repo.registerEndpoint({ providerKey: 'heygen', url: 'https://mcp.heygen.test/mcp', displayName: 'HeyGen' });
    await expect(repo.setEndpointStatus(ep.id, 'active')).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_APPROVED' });
    const s1 = await repo.createSnapshot(ep.id, TOOLS, 'a'.repeat(64));
    await repo.approveSnapshot(s1.id, []);
    await expect(repo.setEndpointStatus(ep.id, 'active')).resolves.toBe('active');
    await expect(repo.setEndpointStatus(ep.id, 'disabled')).resolves.toBe('disabled');
  });

  it('deleting an endpoint removes its orphaned connection', async () => {
    const db = new FakeDb();
    const repo = createPlatformRepository(db as never);
    const ep = await repo.registerEndpoint({ providerKey: 'heygen', url: 'https://mcp.heygen.test/mcp', displayName: 'HeyGen' });
    await expect(repo.deleteEndpoint(ep.id)).resolves.toBe(true);
    expect(db.tables.platform_tool_endpoints).toHaveLength(0);
    expect(db.tables.platform_connections).toHaveLength(0);
    await expect(repo.deleteEndpoint(ep.id)).resolves.toBe(false);
  });
});
