// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatWorkspace, type PublicModel } from './ChatWorkspace';

const models: PublicModel[] = [{ key: 'scout', label: 'TuGPT Scout', description: 'Private model', private: true, toolCalling: false }];
const thread = { id: 't1', title: 'Carrier review plan', modelKey: 'scout', updatedAt: '2026-11-15T09:00:00Z' };
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  fetchMock = vi.fn((url: string) => (String(url).endsWith('/capabilities') ? ok({ capabilities: [] }) : ok({ threads: [thread] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const threadCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/v1/chat/threads').length;

describe('ChatWorkspace thread list', () => {
  it('renders server-provided chats on first paint without a loading state or a second fetch', () => {
    render(<ChatWorkspace models={models} initialThreads={[thread]} />);
    expect(screen.getByRole('button', { name: 'Carrier review plan' })).toBeTruthy();
    expect(screen.queryByLabelText('Loading your chats')).toBeNull();
    expect(threadCalls()).toBe(0);
  });

  it('shows a skeleton, then the chats, when there is no server snapshot', async () => {
    render(<ChatWorkspace models={models} />);
    expect(screen.getByLabelText('Loading your chats')).toBeTruthy();
    await screen.findByRole('button', { name: 'Carrier review plan' });
    expect(threadCalls()).toBe(1);
  });

  it('offers a retry when the chats cannot be loaded, and recovers', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 503 })));
    render(<ChatWorkspace models={models} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your chats could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Carrier review plan' });
    expect(threadCalls()).toBe(2);
  });

  it('has an accessible toggle for the chat history (collapsed by default on small screens)', () => {
    render(<ChatWorkspace models={models} initialThreads={[thread]} />);
    const toggle = screen.getByRole('button', { name: 'Your chats (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('chat-history');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide chats' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a helpful empty state', () => {
    render(<ChatWorkspace models={models} initialThreads={[]} />);
    expect(screen.getByText(/No chats yet/)).toBeTruthy();
  });
});

describe('ChatWorkspace integrations', () => {
  const cap = (over: Record<string, unknown>) => ({ capabilityKey: 'calendar.find_availability', providerKey: 'google', providerName: 'Google', description: 'Find free time', permissionClass: 'read', state: 'connected', toolAvailable: true, ...over });
  const verified: PublicModel[] = [{ ...models[0], toolCalling: true }];
  const withCaps = (caps: unknown[], messages?: () => Promise<Response>) => vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/capabilities')) return ok({ capabilities: caps });
    if (u === '/api/v1/chat/threads' && init?.method === 'POST') return ok({ thread });
    if (u.endsWith('/messages') && messages) return messages();
    return ok({ threads: [] });
  });
  async function openPicker() {
    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@' } });
    return screen.findByRole('listbox');
  }

  it('explains why an app cannot be picked: no chat tool, model not verified', async () => {
    fetchMock = withCaps([cap({ providerKey: 'microsoft', providerName: 'Microsoft 365', toolAvailable: false }), cap({})]);
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWorkspace models={models} initialThreads={[]} />);
    await screen.findByLabelText('Message');
    await new Promise((r) => setTimeout(r, 0));
    const list = await openPicker();
    const opts = list.querySelectorAll('[role="option"]');
    expect(opts[0].textContent).toContain('Not available in chat yet');
    expect(opts[0].getAttribute('aria-disabled')).toBe('true');
    expect(opts[1].textContent).toContain('can\u2019t use apps yet');
    expect(list.textContent).toContain('tool-calling verification');
  });

  it('lets a verified model pick a connected app with a tool', async () => {
    fetchMock = withCaps([cap({})]); vi.stubGlobal('fetch', fetchMock);
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    await new Promise((r) => setTimeout(r, 0));
    const list = await openPicker();
    expect(list.querySelector('[role="option"]')?.getAttribute('aria-disabled')).toBe('false');
    fireEvent.mouseDown(list.querySelector('[role="option"]')!);
    expect(screen.getByLabelText('Attached apps').textContent).toContain('Google');
  });

  it('turns a 409 into a clear message with a link to Connect, and keeps the draft', async () => {
    fetchMock = withCaps([], () => Promise.resolve(new Response(JSON.stringify({ error: 'An attached integration is not connected' }), { status: 409 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'When am I free?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not connected');
    expect(alert.querySelector('a')?.getAttribute('href')).toBe('/dashboard/connect');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('When am I free?');
  });

  it('describes a failed tool call in words, not codes', async () => {
    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); push = (s) => c.enqueue(e.encode(s)); } });
    fetchMock = withCaps([], () => Promise.resolve(new Response(body, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'When am I free?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Stop' });
    push('{"type":"tool_start","tool":"calendar_find_availability"}\n{"type":"tool_result","tool":"calendar_find_availability","ok":false,"code":"REAUTHORIZATION_REQUIRED"}\n');
    const line = await screen.findByText(/Reconnect the account/);
    expect(line.textContent).not.toContain('REAUTHORIZATION_REQUIRED');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/dashboard/connect');
  });
});
