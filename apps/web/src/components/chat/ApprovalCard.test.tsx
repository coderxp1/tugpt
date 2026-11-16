// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import type { PendingApproval } from '@/lib/chat/approval';

const approval: PendingApproval = {
  callId: 'call_1', threadId: 'c0000000-0000-4000-8000-000000000001', endpointId: 'e0000000-0000-4000-8000-00000000000a',
  endpointName: 'Acme Docs (test)', endpointHost: 'mcp.acme.test', capability: 'external.create_ticket', toolName: 'create_ticket',
  toolDescription: 'Create a support ticket', permissionClass: 'write',
  arguments: { title: 'VPN broken', api_token: 'tok_live_SECRET', nested: { password: 'p@ss' } },
  argumentsSha256: 'a'.repeat(64),
};

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
type Route = (url: string, init?: RequestInit) => Promise<Response>;
function fetcher(routes: { approve?: Route; status?: Route; revoke?: Route }) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/chat/approvals/status')) return (routes.status ?? (() => json(200, { approved: true })))(url, init);
    if (url === '/api/v1/connect/mcp/approvals/revoke') return (routes.revoke ?? (() => json(200, { revoked: true })))(url, init);
    if (url === '/api/v1/connect/mcp/approvals') return (routes.approve ?? (() => json(200, { approved: true, id: 'id-1', expiresAt: new Date(Date.now() + 900000).toISOString() })))(url, init);
    return json(404, {});
  });
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

const status = () => screen.getByRole('status').textContent ?? '';
const confirmAndApprove = () => {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
};

describe('ApprovalCard', () => {
  it('explains the action, shows endpoint, host and tool, and hides secret values from the DOM', () => {
    const { container } = render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={fetcher({})} />);
    expect(screen.getByRole('heading', { name: 'Approve this action?' })).toBeTruthy();
    expect(container.textContent).toContain('Changes data');
    expect(container.textContent).toContain('Acme Docs (test)');
    expect(container.textContent).toContain('(mcp.acme.test)');
    expect(container.textContent).toContain('VPN broken');
    expect(screen.getAllByText('Hidden')).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(/tok_live_SECRET|p@ss/);
    expect(status()).toContain('Nothing has run');
  });

  it('requires the explicit confirmation before Approve is enabled', () => {
    const f = fetcher({});
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={f} />);
    const btn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(f).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(btn.disabled).toBe(false);
  });

  it.each([
    ['500 from the approval route', { approve: () => json(500, { error: { code: 'INTERNAL', message: 'x' } }) }, 'not working right now'],
    ['403 from the approval route', { approve: () => json(403, { error: { code: 'FORBIDDEN', message: 'x' } }) }, 'not allowed to approve'],
    ['200 with approved:false', { approve: () => json(200, { approved: false }) }, 'unexpected answer'],
    ['network failure', { approve: () => Promise.reject(new TypeError('offline')) }, 'could not be sent'],
    ['approval not found in the database afterwards', { status: () => json(200, { approved: false }) }, 'could not be confirmed'],
    ['status check fails', { status: () => json(503, { error: 'x' }) }, 'could not be confirmed'],
  ])('a failed approval is never permission: %s', async (_n, routes, text) => {
    const onRun = vi.fn();
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={onRun} fetchFn={fetcher(routes)} />);
    confirmAndApprove();
    await waitFor(() => expect(status()).toContain(text));
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
    // Retry and reject stay available.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('approve -> verified -> run once -> done; sends the chosen TTL', async () => {
    const f = fetcher({});
    const onRun = vi.fn(async () => ({ ok: true }));
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={onRun} fetchFn={f} />);
    fireEvent.click(screen.getByRole('radio', { name: '15 minutes' }));
    confirmAndApprove();
    await screen.findByRole('button', { name: 'Run now' });
    expect(status()).toMatch(/Approved for one run\. Expires in 1[45]:\d\d/);
    const approveCall = f.mock.calls.find(([u]) => u === '/api/v1/connect/mcp/approvals')!;
    expect(JSON.parse(String((approveCall[1] as RequestInit).body)).ttlSeconds).toBe(900);
    expect(f.mock.calls.some(([u]) => String(u).startsWith('/api/v1/chat/approvals/status'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(status()).toContain('Done. The call ran once'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(approval);
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('a run refused by the database is reported as not run', async () => {
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={async () => ({ ok: false, code: 'APPROVAL_REQUIRED' })} fetchFn={fetcher({})} />);
    confirmAndApprove();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(status()).toContain('Not run: the database did not accept the approval'));
  });

  it('a run refused before execution keeps the approval and says why', async () => {
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={async () => ({ ok: false, code: 'REQUEST_REFUSED', message: 'This integration is not available in chat yet' })} fetchFn={fetcher({})} />);
    confirmAndApprove();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await screen.findByText(/Not run: This integration is not available in chat yet\. The approval was not used and stays valid until it expires or you revoke it\./);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke approval' })).toBeTruthy();
  });

  it('Run waits while another answer is streaming', async () => {
    render(<ApprovalCard approval={approval} canApprove busy onRun={vi.fn()} fetchFn={fetcher({})} />);
    confirmAndApprove();
    const run = await screen.findByRole('button', { name: 'Run now' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });

  it('revoke closes the card; nothing runs', async () => {
    const f = fetcher({});
    const onRun = vi.fn();
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={onRun} fetchFn={f} />);
    confirmAndApprove();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke approval' }));
    await waitFor(() => expect(status()).toContain('Approval revoked. Nothing was run.'));
    const revoke = f.mock.calls.find(([u]) => u === '/api/v1/connect/mcp/approvals/revoke')!;
    expect(JSON.parse(String((revoke[1] as RequestInit).body))).toEqual({ approvalId: 'id-1' });
    expect(onRun).not.toHaveBeenCalled();
  });

  it('a failed revoke says the approval is still valid and keeps Run/Revoke', async () => {
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={fetcher({ revoke: () => json(500, { error: { code: 'INTERNAL', message: 'x' } }) })} />);
    confirmAndApprove();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke approval' }));
    await screen.findByText(/could not be revoked/);
    expect(screen.getByText(/stays valid until it expires or is used/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy();
  });

  it('{revoked:false} is reported as nothing left to revoke', async () => {
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={fetcher({ revoke: () => json(200, { revoked: false }) })} />);
    confirmAndApprove();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke approval' }));
    await screen.findByText(/no unused approval left to revoke/);
  });

  it('expires on the client when the TTL passes; Run disappears', async () => {
    let now = 1_000_000;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={fetcher({ approve: () => json(200, { approved: true, id: 'id-1', expiresAt: new Date(1_300_000).toISOString() }) })} now={() => now} />);
    confirmAndApprove();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy());
    now += 301_000;
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(status()).toContain('expired before it was used');
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('reject closes the card without any request', () => {
    const f = fetcher({});
    render(<ApprovalCard approval={approval} canApprove busy={false} onRun={vi.fn()} fetchFn={f} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(status()).toBe('Rejected. Nothing was run.');
    expect(f).not.toHaveBeenCalled();
  });

  it('members cannot approve: no Approve button, an honest explanation, and Check again only reads status', async () => {
    const f = fetcher({ status: () => json(200, { approved: false }) });
    const { container } = render(<ApprovalCard approval={approval} canApprove={false} busy={false} onRun={vi.fn()} fetchFn={f} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(container.textContent).toContain('Only an owner or admin of this organization can approve');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText('No approval for this exact call exists yet.');
    expect(f.mock.calls.every(([u]) => String(u).startsWith('/api/v1/chat/approvals/status'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('marks irreversible actions distinctly', () => {
    const { container } = render(<ApprovalCard approval={{ ...approval, permissionClass: 'irreversible' }} canApprove busy={false} onRun={vi.fn()} fetchFn={fetcher({})} />);
    expect(container.textContent).toContain('Cannot be undone');
  });
});
