// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProviderActions } from './ProviderActions';
import { DisconnectDialog } from './DisconnectDialog';
import { OAuthBanner } from './OAuthBanner';
import { McpToolReview } from './McpToolReview';
import { McpPanel } from './McpPanel';
import { BACKEND_GAPS, type RouteAvailability } from '@/lib/connect-ui/contract';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const all = (s: 'available' | 'missing'): RouteAvailability => ({ googleStart: s, microsoftStart: s, mcpRegister: s, mcpSnapshot: s, mcpApprove: s, mcpActivate: s, mcpDeactivate: s });

describe('ProviderActions', () => {
  it('gives owners/admins a real link to the start route', () => {
    render(<ProviderActions provider="google" state="requires_connection" canManage start="available" />);
    expect(screen.getByRole('link', { name: 'Connect Google' }).getAttribute('href')).toBe('/api/v1/connect/google/start');
  });
  it('shows members no connect action', () => {
    render(<ProviderActions provider="microsoft" state="requires_connection" canManage={false} start="available" />);
    expect(screen.queryByRole('link', { name: /Connect/ })).toBeNull();
    expect(screen.getByText(/Only an organization owner or admin/)).toBeTruthy();
  });
  it('disables Connect with the exact missing route when the build lacks it', () => {
    render(<ProviderActions provider="microsoft" state="requires_connection" canManage start="missing" />);
    expect((screen.getByRole('button', { name: 'Connect Microsoft 365' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('/api/v1/connect/microsoft/start')).toBeTruthy();
  });
  it('asks for confirmation before disconnect, and explains the backend gap', () => {
    render(<ProviderActions provider="google" state="connected" canManage start="available" />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect Google?' });
    expect(dialog.textContent).toContain('B-5');
    expect((screen.getByRole('button', { name: 'Disconnect Google' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Disconnect…');
  });
});

describe('DisconnectDialog with a backend', () => {
  it('runs the disconnect only on confirm and reports failures', async () => {
    const onConfirm = vi.fn().mockResolvedValueOnce('Could not disconnect.').mockResolvedValueOnce(null);
    const onDone = vi.fn();
    render(<DisconnectDialog providerName="Google" onConfirm={onConfirm} onClose={vi.fn()} onDone={onDone} gap={BACKEND_GAPS.B5} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not disconnect.');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
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

describe('McpToolReview', () => {
  it('locks approval when the tools cannot be read (B-2)', () => {
    render(<McpToolReview tools={null} toolCount={3} />);
    expect(screen.getByRole('note').textContent).toContain('B-2');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
  it('requires a level for every tool and an explicit review before approving', async () => {
    const onApprove = vi.fn().mockResolvedValue(null);
    render(<McpToolReview toolCount={2} onApprove={onApprove} tools={[{ name: 'search', description: 'Search articles' }, { name: 'refund', description: 'Refund an order' }]} />);
    const approve = screen.getByRole('button', { name: 'Approve these tools' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Permission level for search'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('Permission level for refund'), { target: { value: 'financial' } });
    expect(screen.getByText(/B-7/)).toBeTruthy();
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({ search: 'read', refund: 'financial' }));
  });
});

describe('McpPanel', () => {
  it('disables registration with the missing route named, and members cannot register', () => {
    const { unmount } = render(<McpPanel canManage routes={all('missing')} />);
    expect((screen.getByRole('button', { name: 'Add server' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('POST /api/v1/connect/mcp/endpoints')).toBeTruthy();
    unmount();
    render(<McpPanel canManage={false} routes={all('available')} />);
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull();
  });
  it('registers from the real response, shows discovered count and an activation denial', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/endpoints')) return new Response(JSON.stringify({ endpoint: { id: 'e1', url: 'https://mcp.example.com', displayName: 'Docs', status: 'pending' } }), { status: 201 });
      if (url.endsWith('/snapshot')) return new Response(JSON.stringify({ snapshotId: 's1', toolCount: 4 }), { status: 201 });
      return new Response(JSON.stringify({ error: { code: 'ACTIVATION_DENIED', message: 'no approved snapshot' } }), { status: 409 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<McpPanel canManage routes={all('available')} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'http://mcp.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'https://mcp.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(await screen.findByRole('heading', { name: 'Docs' })).toBeTruthy();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'x-tugpt-csrf': '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    expect(await screen.findByText(/found 4 tools/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no approved snapshot');
  });
});
