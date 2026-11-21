// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import type { Thread } from '@/components/chat/types';

const nav = vi.hoisted(() => ({ path: '/workspace' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams() }));
import { WorkspaceFrame } from './WorkspaceFrame';
import { ThreadsProvider, useThreads } from './ThreadsProvider';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'a0000000-0000-4000-8000-000000000002';
const C = 'a0000000-0000-4000-8000-000000000003';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const threads: Thread[] = [
  { id: A, title: 'Carrier review plan', modelKey: 'scout', updatedAt: new Date().toISOString() },
  { id: B, title: 'Q4 pricing notes', modelKey: 'scout', updatedAt: hoursAgo(24 * 3) },
  { id: C, title: 'Camión route audit', modelKey: 'scout', updatedAt: hoursAgo(24 * 40) },
];
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { nav.path = '/workspace'; fetchMock = vi.fn(() => ok({ threads })); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const control: { setBusy: (b: boolean) => void } = { setBusy: () => {} };
function Busy() { const { setBusy } = useThreads(); useEffect(() => { control.setBusy = setBusy; }, [setBusy]); return null; }
function renderFrame(initial: Thread[] | null = threads) {
  return render(
    <ThreadsProvider initialThreads={initial}>
      <Busy />
      <WorkspaceFrame fullName="Clara Vidal" email="clara@example.test"><p>content</p></WorkspaceFrame>
    </ThreadsProvider>,
  );
}
const sidebar = () => screen.getByRole('complementary', { name: 'Workspace sidebar' });
const threadCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/v1/chat/threads').length;

describe('WorkspaceFrame: recent chats', () => {
  it('renders server-provided chats as links to /workspace/c/<id>, without a loading state or a fetch', () => {
    renderFrame();
    const link = within(sidebar()).getByRole('link', { name: 'Carrier review plan' });
    expect(link.getAttribute('href')).toBe(`/workspace/c/${A}`);
    expect(screen.queryByLabelText('Loading your chats')).toBeNull();
    expect(threadCalls()).toBe(0);
  });

  it('marks the open chat as the current page', () => {
    nav.path = `/workspace/c/${B}`;
    renderFrame();
    expect(screen.getByRole('link', { name: 'Q4 pricing notes' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Carrier review plan' }).getAttribute('aria-current')).toBeNull();
  });

  it('shows a skeleton, then the chats, when there is no server snapshot', async () => {
    renderFrame(null);
    expect(screen.getByLabelText('Loading your chats')).toBeTruthy();
    await screen.findByRole('link', { name: 'Carrier review plan' });
    expect(threadCalls()).toBe(1);
  });

  it('offers a retry when the chats cannot be loaded, and recovers', async () => {
    // The frame also asks for folders and approvals; fail only the first chat-list request.
    let failed = false;
    fetchMock.mockImplementation((u: unknown) => {
      if (String(u) === '/api/v1/chat/threads' && !failed) { failed = true; return Promise.resolve(new Response('{}', { status: 503 })); }
      return ok({ threads });
    });
    renderFrame(null);
    expect((await screen.findByRole('alert')).textContent).toContain('Your chats could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: 'Carrier review plan' });
    expect(threadCalls()).toBe(2);
  });

  it('shows a helpful empty state', () => {
    renderFrame([]);
    expect(screen.getByText(/No chats yet/)).toBeTruthy();
  });

  it('holds other chats and New chat while an answer streams, and says why', () => {
    nav.path = `/workspace/c/${A}`;
    renderFrame();
    act(() => control.setBusy(true));
    const other = screen.getByRole('link', { name: 'Q4 pricing notes' });
    expect(other.getAttribute('aria-disabled')).toBe('true');
    expect(within(sidebar()).getByRole('link', { name: /New chat/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Wait for the answer to finish/)).toBeTruthy();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    other.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    act(() => control.setBusy(false));
    expect(screen.getByRole('link', { name: 'Q4 pricing notes' }).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('WorkspaceFrame: navigation', () => {
  it('has New chat and Chat pointing at /workspace, Chat marked current', () => {
    renderFrame();
    expect(within(sidebar()).getByRole('link', { name: /New chat/ }).getAttribute('href')).toBe('/workspace');
    const chat = within(screen.getByRole('navigation', { name: 'Workspace navigation' })).getByRole('link', { name: 'Chat' });
    expect(chat.getAttribute('href')).toBe('/workspace');
    expect(chat.getAttribute('aria-current')).toBe('page');
  });

  it('always offers the way back to the Dashboard (sidebar and top bar)', () => {
    renderFrame();
    const toDash = screen.getAllByRole('link', { name: /Dashboard/ }).map((a) => a.getAttribute('href'));
    expect(toDash.filter((h) => h === '/dashboard').length).toBe(2);
  });

  it('links every working area to its page and marks the current one', () => {
    nav.path = '/workspace/library';
    renderFrame();
    const navEl = screen.getByRole('navigation', { name: 'Workspace navigation' });
    const hrefs = within(navEl).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(hrefs).toEqual([['Chat', '/workspace'], ['Agents', '/workspace/agents'], ['Library', '/workspace/library'], ['Images', '/workspace/images']]);
    expect(within(navEl).getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    expect(within(navEl).getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps administration out of the Workspace navigation', () => {
    renderFrame();
    const navEl = screen.getByRole('navigation', { name: 'Workspace navigation' });
    for (const a of within(navEl).getAllByRole('link')) expect(a.getAttribute('href')).toMatch(/^\/workspace/);
  });

  it('lists upcoming areas as not available, never as links to placeholder pages', () => {
    renderFrame();
    const later = screen.getByText('Coming to Workspace').closest('details')!;
    expect(within(later).queryAllByRole('link')).toEqual([]);
    expect(within(later).getAllByText('Not available yet').length).toBe(5);
    for (const el of later.querySelectorAll('[aria-disabled="true"]')) expect(el.tagName).not.toBe('A');
  });

  it('shows the signed-in person, with account settings and sign-out in the account menu, not an organization', async () => {
    renderFrame();
    expect(sidebar().textContent).toContain('Clara Vidal');
    expect(sidebar().textContent).not.toMatch(/organization|GmbH/i);
    const person = within(sidebar()).getByRole('button', { name: /Clara Vidal/ });
    expect(person.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(person);
    const menu = await screen.findByRole('menu', { name: 'Account' });
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' }).getAttribute('href')).toBe('/auth/logout');
    expect(within(menu).getByRole('menuitem', { name: 'Account settings' }).getAttribute('href')).toBe('/dashboard/settings');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(person);
  });
});

describe('WorkspaceFrame: search and grouping', () => {
  it('groups recent chats by day', () => {
    renderFrame();
    const headings = within(sidebar()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Today', 'Previous 7 days', 'Older']);
  });

  it('filters chats as you type, accent-insensitive, and says when nothing matches', () => {
    renderFrame();
    const box = within(sidebar()).getByRole('searchbox', { name: 'Search chats' });
    fireEvent.change(box, { target: { value: 'camion' } });
    expect(within(sidebar()).getByRole('link', { name: 'Camión route audit' })).toBeTruthy();
    expect(within(sidebar()).queryByRole('link', { name: 'Carrier review plan' })).toBeNull();
    expect(within(sidebar()).getByRole('heading', { name: 'Search results' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(sidebar().textContent).toContain('Nothing matches “zzz”.');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(within(sidebar()).getByRole('link', { name: 'Carrier review plan' })).toBeTruthy();
  });

  it('Ctrl+K moves focus to the search', async () => {
    renderFrame();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(within(sidebar()).getByRole('searchbox', { name: 'Search chats' })));
  });
});

describe('WorkspaceFrame: drawer (below 1024px)', () => {
  it('opens from the menu button, moves focus in, and closes on Escape with focus restored', async () => {
    renderFrame();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-controls')).toBe('workspace-sidebar');
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(sidebar().contains(document.activeElement)).toBe(true));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    expect(document.body.style.overflow).toBe('');
  });

  it('wraps Tab from the last control to the first', () => {
    renderFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const last = within(sidebar()).getByRole('button', { name: /Clara Vidal/ });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(sidebar()).getByRole('link', { name: 'TuGPT Workspace, new chat' }));
  });

  it('closes when a chat is opened from it', () => {
    renderFrame();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('link', { name: 'Q4 pricing notes' }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });
});
