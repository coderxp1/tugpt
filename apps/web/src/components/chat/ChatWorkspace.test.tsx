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
