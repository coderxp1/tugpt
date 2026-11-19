// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/workspace', useSearchParams: () => new URLSearchParams() }));
import { ThreadsProvider } from '../ThreadsProvider';
import { WorkspaceFrame } from '../WorkspaceFrame';
import { fakeApi } from './fake-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderFrame(canDecide: boolean) {
  return render(<ThreadsProvider initialThreads={[]}><WorkspaceFrame email="anna@example.test" canDecide={canDecide}><p>content</p></WorkspaceFrame></ThreadsProvider>);
}
const nav = () => screen.getByRole('navigation', { name: 'Workspace navigation' });

describe('WorkspaceFrame: approvals', () => {
  it('admins get an Approvals link with the number waiting, once the API answers', async () => {
    const api = fakeApi({ 'GET /api/v1/approvals': () => ({ body: { approvals: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }], nextCursor: null } }) });
    renderFrame(true);
    const link = await within(nav()).findByRole('link', { name: /Approvals/ });
    expect(link.getAttribute('href')).toBe('/workspace/approvals');
    expect(link.textContent).toContain('2 waiting for approval');
    expect(api.calls.find((c) => c.path === '/api/v1/approvals')?.search).toBe('?scope=org&status=pending&limit=50');
  });

  it('no Approvals link when the approvals API is not deployed', async () => {
    const api = fakeApi({});
    renderFrame(true);
    await vi.waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/approvals')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(nav()).queryByRole('link', { name: /Approvals/ })).toBeNull();
  });

  it('members poll their own requests', async () => {
    const api = fakeApi({ 'GET /api/v1/approvals': () => ({ body: { approvals: [], nextCursor: null } }) });
    renderFrame(false);
    await within(nav()).findByRole('link', { name: /Approvals/ });
    expect(api.calls.find((c) => c.path === '/api/v1/approvals')?.search).toBe('?scope=mine&limit=50');
  });
});
