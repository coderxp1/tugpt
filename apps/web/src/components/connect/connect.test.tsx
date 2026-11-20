// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProviderActions } from './ProviderActions';
import { DisconnectDialog } from './DisconnectDialog';
import { OAuthBanner } from './OAuthBanner';
import { McpToolReview } from './McpToolReview';
import { McpPanel } from './McpPanel';
import { BACKEND_GAPS, CONTRACT_ROUTES, type ContractRoute, type RouteAvailability } from '@/lib/connect-ui/contract';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const all = (s: 'available' | 'missing'): RouteAvailability =>
  Object.fromEntries((Object.keys(CONTRACT_ROUTES) as ContractRoute[]).map((k) => [k, s])) as RouteAvailability;

/** A fetch result whose final URL is readable (same-origin redirect). */
const landed = (url: string, ok = true) => ({ ok, status: ok ? 200 : 500, url, json: async () => ({}) }) as unknown as Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ProviderActions', () => {
  it('gives owners/admins a real link to the start route', () => {
    render(<ProviderActions provider="google" state="requires_connection" canManage start="available" disconnect="available" />);
    expect(screen.getByRole('link', { name: 'Connect Google' }).getAttribute('href')).toBe('/api/v1/connect/google/start');
  });
  it('shows members no connect or disconnect action', () => {
    const { unmount } = render(<ProviderActions provider="microsoft" state="requires_connection" canManage={false} start="available" disconnect="available" />);
    expect(screen.queryByRole('link', { name: /Connect/ })).toBeNull();
    expect(screen.getByText(/Only an organization owner or admin/)).toBeTruthy();
    unmount();
    render(<ProviderActions provider="microsoft" state="connected" canManage={false} start="available" disconnect="available" />);
    expect(screen.queryByRole('button', { name: 'Disconnect…' })).toBeNull();
  });
  it('disables Connect with the exact missing route when the build lacks it', () => {
    render(<ProviderActions provider="microsoft" state="requires_connection" canManage start="missing" disconnect="missing" />);
    expect((screen.getByRole('button', { name: 'Connect Microsoft 365' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('/api/v1/connect/microsoft/start')).toBeTruthy();
  });
  it('keeps Disconnect locked when the route is missing; Escape closes and restores focus', () => {
    render(<ProviderActions provider="google" state="connected" canManage start="available" disconnect="missing" />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect Google?' });
    expect(dialog.textContent).toContain('not available on this build');
    expect((screen.getByRole('button', { name: 'Disconnect Google' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Disconnect…');
  });
  it('POSTs to the real disconnect route only after confirming, then shows the revoked state from a fresh read', async () => {
    const f = vi.fn(async () => landed('https://app.example/settings/integrations?google=revoked'));
    render(<ProviderActions provider="google" state="connected" canManage start="available" disconnect="available" disconnectFetch={f as unknown as typeof fetch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    expect(f).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/connect?google=revoked'));
    expect(router.refresh).toHaveBeenCalled();
    expect(f).toHaveBeenCalledWith('/api/v1/connect/google/disconnect', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-tugpt-csrf': '1' }) }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
  it('reports a backend failure, re-reads status and does not claim success', async () => {
    const f = vi.fn(async () => landed('https://app.example/settings/integrations?microsoft=error&reason=disconnect_failed'));
    render(<ProviderActions provider="microsoft" state="connected" canManage start="available" disconnect="available" disconnectFetch={f as unknown as typeof fetch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Microsoft 365' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not be disconnected');
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it('says the outcome is unknown when the redirect cannot be read (cross-origin)', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    render(<ProviderActions provider="google" state="connected" canManage start="available" disconnect="available" disconnectFetch={f as unknown as typeof fetch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not confirm');
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('DisconnectDialog', () => {
  it('runs only on confirm, shows failures, and explains a gap when there is no route', async () => {
    const onConfirm = vi.fn().mockResolvedValueOnce('Could not disconnect.').mockResolvedValueOnce(null);
    const onDone = vi.fn();
    const { unmount } = render(<DisconnectDialog providerName="Google" onConfirm={onConfirm} onClose={vi.fn()} onDone={onDone} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not disconnect.');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    unmount();
    render(<DisconnectDialog providerName="Google" onClose={vi.fn()} gap={BACKEND_GAPS.EGRESS} />);
    expect(screen.getByRole('note').textContent).toContain('B-8');
  });
});

describe('OAuthBanner', () => {
  it('announces errors as alerts and removes the return parameters from the URL', () => {
    window.history.replaceState(null, '', '/dashboard/connect?google=error&reason=forbidden&keep=1');
    render(<OAuthBanner tone="error" title="Google could not be connected" body="Only an organization owner or admin can connect this account." />);
    expect(screen.getByRole('alert').textContent).toContain('owner or admin');
    expect(window.location.search).toBe('?keep=1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

const TOOLS = [
  { name: 'search', description: 'Search articles', permissionClass: 'write' as const },
  { name: 'refund', description: 'Refund an order', permissionClass: 'write' as const },
];

describe('McpToolReview', () => {
  it('shows stored levels read-only when approving is switched off', () => {
    render(<McpToolReview tools={TOOLS} approved={false} lockedNote={<p>Approving is switched off.</p>} />);
    expect(within(screen.getByRole('table')).getAllByText('Makes changes')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByText('Approving is switched off.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Not approved');
  });
  it('requires an explicit level for every tool (no preselected default) and a review before approving', async () => {
    const onApprove = vi.fn().mockResolvedValue(null);
    render(<McpToolReview tools={TOOLS} approved={false} onApprove={onApprove} />);
    const approve = screen.getByRole('button', { name: 'Approve these tools' }) as HTMLButtonElement;
    expect((screen.getByLabelText('Permission level for search') as HTMLSelectElement).value).toBe('');
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Permission level for search'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('Permission level for refund'), { target: { value: 'financial' } });
    expect(screen.getByText(/B-11/)).toBeTruthy();
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({ search: 'read', refund: 'financial' }));
  });
  it('shows an approved list as frozen, with no way to change it', () => {
    render(<McpToolReview tools={[{ ...TOOLS[0], permissionClass: 'read' }]} approved onApprove={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Approved');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function api(handler: Handler) {
  return vi.fn(async (url: string, init: RequestInit = {}) => handler(String(url), init));
}
const EP = { id: 'e1', url: 'https://mcp.example.com/sse', displayName: 'Docs', status: 'pending' };
const ACTIVE = { id: 'e2', url: 'https://kb.example.com/mcp', displayName: 'Knowledge base', status: 'active' };

describe('McpPanel', () => {
  it('members see a message and the list is never requested', () => {
    const f = api(() => json({ endpoints: [] }));
    render(<McpPanel canManage={false} routes={all('available')} enabled={false} fetcher={f as unknown as typeof fetch} />);
    expect(screen.getByText(/Only an organization owner or admin can see and manage/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('lists real endpoints; with customer MCP off only Turn off and Remove are possible', async () => {
    const f = api((url, init) => {
      if (url === '/api/v1/connect/mcp/endpoints' && (init.method ?? 'GET') === 'GET') return json({ endpoints: [EP, ACTIVE, { id: 3 }] });
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    render(<McpPanel canManage routes={all('available')} enabled={false} fetcher={f as unknown as typeof fetch} />);
    const docs = (await screen.findByRole('heading', { name: 'Docs' })).closest('li')!;
    const kb = screen.getByRole('heading', { name: 'Knowledge base' }).closest('li')!;
    expect(screen.getAllByRole('listitem').filter((li) => li.querySelector('h3'))).toHaveLength(2); // malformed row dropped
    expect(within(docs).getByText('Not active')).toBeTruthy();
    expect(within(kb).getByText('Active')).toBeTruthy();
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect((screen.getByRole('button', { name: 'Add server' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(docs).getByRole('button', { name: 'Discover tools' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(docs).getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(kb).getByRole('button', { name: 'Turn off' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(docs).getByRole('button', { name: 'Remove…' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole('note').map((n) => n.textContent).join(' ')).toContain('B-8');
  });

  it('removes a server only after confirmation, via DELETE, then re-reads the list', async () => {
    let listed = [EP, ACTIVE];
    const f = api((url, init) => {
      if (url === '/api/v1/connect/mcp/endpoints') return json({ endpoints: listed });
      if (url === '/api/v1/connect/mcp/endpoints/e1' && init.method === 'DELETE') { listed = [ACTIVE]; return json({ endpointId: 'e1', deleted: true }); }
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    render(<McpPanel canManage routes={all('available')} enabled={false} fetcher={f as unknown as typeof fetch} />);
    const docs = (await screen.findByRole('heading', { name: 'Docs' })).closest('li')!;
    fireEvent.click(within(docs).getByRole('button', { name: 'Remove…' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove Docs?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(f.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
    fireEvent.click(within(docs).getByRole('button', { name: 'Remove…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Docs' })).toBeNull());
    const del = f.mock.calls.find(([, i]) => i?.method === 'DELETE')!;
    expect(del[1]).toMatchObject({ headers: expect.objectContaining({ 'x-tugpt-csrf': '1' }) });
    expect(screen.getByRole('heading', { name: 'Knowledge base' })).toBeTruthy();
  });

  it('keeps the server and explains when removal fails', async () => {
    const f = api((url, init) => {
      if (init.method === 'DELETE') return json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      return json({ endpoints: [EP] });
    });
    render(<McpPanel canManage routes={all('available')} enabled={false} fetcher={f as unknown as typeof fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }));
    expect((await within(screen.getByRole('alertdialog')).findByRole('alert')).textContent).toContain('owner or admin');
    expect(screen.getByRole('heading', { name: 'Docs' })).toBeTruthy();
  });

  it('shows a load failure with a retry instead of an empty list', async () => {
    let fail = true;
    const f = api(() => (fail ? json({ error: { code: 'INTERNAL', message: '' } }, 500) : json({ endpoints: [EP] })));
    render(<McpPanel canManage routes={all('available')} enabled={false} fetcher={f as unknown as typeof fetch} />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded');
    expect(screen.queryByText('No MCP servers yet.')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Docs' })).toBeTruthy();
  });

  it('names the missing list route and locks everything when the build lacks the MCP routes', () => {
    const f = api(() => json({ endpoints: [] }));
    render(<McpPanel canManage routes={all('missing')} enabled fetcher={f as unknown as typeof fetch} />);
    expect(screen.getByText('GET /api/v1/connect/mcp/endpoints')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add server' }) as HTMLButtonElement).disabled).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('with customer MCP switched on: discover, show stored tools, approve, and surface an activation denial', async () => {
    let approved = false;
    const f = api((url, init) => {
      if (url === '/api/v1/connect/mcp/endpoints') return json({ endpoints: [EP] });
      if (url === '/api/v1/connect/mcp/endpoints/e1/snapshot') return json({ snapshotId: 's1', toolCount: 2 }, 201);
      if (url === '/api/v1/connect/mcp/snapshots/s1/tools') return json({ tools: TOOLS.map((t) => ({ ...t, inputSchema: {}, permissionClass: approved ? (t.name === 'search' ? 'read' : 'financial') : 'write' })) });
      if (url === '/api/v1/connect/mcp/snapshots/s1/approve') { approved = true; expect(JSON.parse(String(init.body))).toEqual({ permissions: { search: 'read', refund: 'financial' } }); return json({ snapshotId: 's1', permissionCount: 2 }); }
      if (url === '/api/v1/connect/mcp/endpoints/e1/activate') return json({ error: { code: 'ACTIVATION_DENIED', message: 'egress proxy not reachable' } }, 409);
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    render(<McpPanel canManage routes={all('available')} enabled fetcher={f as unknown as typeof fetch} />);
    const card = (await screen.findByRole('heading', { name: 'Docs' })).closest('li')!;
    expect((within(card).getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Discover tools' }));
    expect(await within(card).findByText('Refund an order')).toBeTruthy();
    expect(within(within(card).getByRole('table')).getAllByText('default until reviewed')).toHaveLength(2);
    fireEvent.change(within(card).getByLabelText('Permission level for search'), { target: { value: 'read' } });
    fireEvent.change(within(card).getByLabelText('Permission level for refund'), { target: { value: 'financial' } });
    fireEvent.click(within(card).getByRole('checkbox'));
    fireEvent.click(within(card).getByRole('button', { name: 'Approve these tools' }));
    expect(await within(card).findByText('Approved. This list is frozen.')).toBeTruthy();
    expect(within(within(card).getByRole('table')).getByText('Moves money')).toBeTruthy();
    expect(within(within(card).getByRole('table')).getByText('Read only')).toBeTruthy();
    const activate = within(card).getByRole('button', { name: 'Activate' }) as HTMLButtonElement;
    expect(activate.disabled).toBe(false);
    fireEvent.click(activate);
    expect((await within(card).findByRole('alert')).textContent).toContain('egress proxy not reachable');
    expect(within(card).getByText('Not active')).toBeTruthy();
  });

  it('keeps the same Idempotency-Key across retryable failures and starts a new one only after an outcome (F-M9-1)', async () => {
    const keys: string[] = [];
    const answers = [
      json({ error: { code: 'DATABASE_TIMEOUT', message: 'The database did not answer in time' } }, 503),
      json({ error: { code: 'IN_PROGRESS', message: 'still running' } }, 409),
      json({ error: { code: 'ENDPOINT_BUSY', message: 'busy' } }, 503),
      json({ snapshotId: 's1', toolCount: 1 }, 201),
      json({ error: { code: 'NOT_FOUND', message: 'MCP endpoint not found' } }, 404),
      json({ error: { code: 'DATABASE_TIMEOUT', message: 'The database did not answer in time' } }, 503),
      json({ snapshotId: 's1', toolCount: 1 }, 201),
    ];
    const f = api((url, init) => {
      if (url === '/api/v1/connect/mcp/endpoints') return json({ endpoints: [EP] });
      if (url === '/api/v1/connect/mcp/endpoints/e1/snapshot') {
        expect(init.method).toBe('POST');
        keys.push(new Headers(init.headers).get('idempotency-key') ?? '');
        return answers.shift()!;
      }
      if (url === '/api/v1/connect/mcp/snapshots/s1/tools') return json({ tools: [{ name: 'search', description: 'Search docs', inputSchema: {}, permissionClass: 'write' }] });
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    render(<McpPanel canManage routes={all('available')} enabled fetcher={f as unknown as typeof fetch} />);
    const card = (await screen.findByRole('heading', { name: 'Docs' })).closest('li')!;
    // The label becomes "Discover again" once a snapshot exists.
    const discover = () => within(card).getByRole('button', { name: /^Discover (tools|again)$/ }) as HTMLButtonElement;
    for (let n = 1; n <= 7; n++) {
      await waitFor(() => expect(discover().disabled).toBe(false));
      fireEvent.click(discover());
      await waitFor(() => expect(keys).toHaveLength(n));
    }
    await waitFor(() => expect(discover().disabled).toBe(false));
    expect(keys.every((k) => /^[A-Za-z0-9_-]{16,128}$/.test(k))).toBe(true);
    // 503 DATABASE_TIMEOUT, 409 IN_PROGRESS, 503 ENDPOINT_BUSY: the retry carries the SAME key, so it can only
    // return the original snapshot, never create a second one.
    expect(new Set(keys.slice(0, 4)).size).toBe(1);
    // After a definite outcome (201 created, 404 not found) the next click starts a new request.
    expect(keys[4]).not.toBe(keys[3]);
    expect(keys[5]).not.toBe(keys[4]);
    expect(keys[6]).toBe(keys[5]);
  });

  it('treats ALREADY_APPROVED as approved, based on the backend answer', async () => {
    const f = api((url) => {
      if (url === '/api/v1/connect/mcp/endpoints') return json({ endpoints: [EP] });
      if (url.endsWith('/snapshot')) return json({ snapshotId: 's9', toolCount: 1 }, 201);
      if (url.endsWith('/tools')) return json({ tools: [{ name: 'search', description: '', inputSchema: {}, permissionClass: 'read' }] });
      if (url.endsWith('/approve')) return json({ error: { code: 'ALREADY_APPROVED', message: '' } }, 409);
      throw new Error(url);
    });
    render(<McpPanel canManage routes={all('available')} enabled fetcher={f as unknown as typeof fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discover tools' }));
    fireEvent.change(await screen.findByLabelText('Permission level for search'), { target: { value: 'read' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve these tools' }));
    expect(await screen.findByText('Approved. This list is frozen.')).toBeTruthy();
  });
});
