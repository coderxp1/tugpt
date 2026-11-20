// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const nav = vi.hoisted(() => ({ path: '/workspace', search: 'agent=agent-a', enabled: true }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock('@/lib/workspace/agents', async (load) => ({ ...await load<object>(), get agentsApiAvailable() { return nav.enabled; } }));
import { ChatView } from './ChatView';
import { ThreadsProvider } from '@/components/workspace/ThreadsProvider';
const tid = 'c0000000-0000-4000-8000-000000000001';
const thread = { id: tid, title: 'Research', modelKey: 'scout', updatedAt: '2026-01-01' };
const message = { id: 'm', role: 'assistant', content: 'Answer from sources.', status: 'complete', mentions: [], capabilityKey: null };
const agent = { id: 'agent-a', name: 'Research agent', version: 1 };
const citation = { n: 1, documentId: 'd', collectionId: 'c', fileId: 'f', title: 'Canonical source', ordinal: 0, snippet: '<script>not executable</script>' };
const approval = { callId: 'call_9', threadId: tid, endpointId: 'e0000000-0000-4000-8000-00000000000a', endpointName: 'Docs', endpointHost: 'mcp.test', capability: 'external.create_ticket', toolName: 'create_ticket', toolDescription: 'Create a ticket', permissionClass: 'write', arguments: { title: 'VPN' }, argumentsSha256: 'b'.repeat(64) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let calls: { url: string; method: string; body: Record<string, unknown> | null }[];
function setup(events: object[], denied = false, restored: { agentId?: string | null; messages?: object[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url === '/api/v1/agents/agent-a') return denied ? json({ error: 'NOT_FOUND' }, 404) : json({ agent });
    if (url.endsWith('/capabilities')) return json({ capabilities: [] });
    if (url === '/api/v1/chat/threads' && init?.method === 'POST') return json({ thread: { ...thread, agentId: agent.id } }, 201);
    if (url === `/api/v1/chat/threads/${tid}`) return json({ thread: { ...thread, ...restored }, messages: restored.messages ?? [] });
    if (url.endsWith('/messages')) return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return json({ threads: [], nextCursor: null });
  }));
  return render(<ThreadsProvider initialThreads={[]}><ChatView models={[{ key: 'scout', label: 'Scout', description: '', private: true, toolCalling: true }]} canApprove /></ThreadsProvider>);
}
beforeEach(() => { calls = []; nav.path = '/workspace'; nav.search = 'agent=agent-a'; nav.enabled = true; Element.prototype.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function send() {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Research this' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}
it('creates with agentId, consumes metadata and preserves approval/done', async () => {
  setup([{ type: 'agent', agent, thread, unavailableTools: ['tool'] }, { type: 'citations', citations: [citation], knowledgeUnavailable: true }, { type: 'approval_required', approval }, { type: 'done', message }, { type: 'agent', agent: { ...agent, name: 'After terminal' } }]);
  await send();
  await screen.findByText('Answer from sources.');
  expect(screen.getByText('Canonical source')).toBeTruthy();
  expect(screen.getByText('<script>not executable</script>')).toBeTruthy();
  expect(screen.getByText('Knowledge retrieval was unavailable for this answer.')).toBeTruthy();
  expect(screen.getByText('Some agent tools are unavailable for your account.')).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Approve this action?' })).toBeTruthy();
  expect(screen.queryByText('After terminal')).toBeNull();
  expect(calls.find((c) => c.url === '/api/v1/chat/threads' && c.method === 'POST')?.body).toEqual({ modelKey: 'scout', agentId: agent.id });
  expect(Object.keys(calls.find((c) => c.url.endsWith('/messages'))!.body!).sort()).toEqual(['content', 'mentions', 'modelKey', 'timeZone']);
});
it('does not send for an inaccessible agent or silently fall back', async () => {
  setup([], true);
  await screen.findByText('This agent is unavailable. Choose another agent before sending.', { selector: 'p' });
  fireEvent.submit(screen.getByLabelText('Message').closest('form')!);
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});
it('does not resolve or run a custom agent while the release gate is closed', async () => {
  nav.enabled = false; setup([]);
  await screen.findByText('Custom-agent execution is not enabled yet.');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.submit(screen.getByLabelText('Message').closest('form')!);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((c) => c.url.startsWith('/api/v1/agents') || c.method === 'POST')).toBe(false);
});
it('never guesses the saved agent from the URL when GET omits its binding', async () => {
  nav.path = `/workspace/c/${tid}`; setup([{ type: 'done', message }]);
  await screen.findByRole('button', { name: /Agent determined by saved chat/ });
  await send(); await screen.findByText('Answer from sources.');
  expect(calls.some((c) => c.url.startsWith('/api/v1/agents'))).toBe(false);
  expect(calls.some((c) => c.url === '/api/v1/chat/threads' && c.method === 'POST')).toBe(false);
});
it('reports terminal error with a string message without treating it as a chat message', async () => {
  setup([{ type: 'error', code: 'TURN_FAILED', message: 'Unavailable' }]);
  await send();
  expect((await screen.findByRole('alert')).textContent).toContain('The answer could not be completed.');
});
it('reports stream cutoff without fabricating a finished response', async () => {
  setup([{ type: 'agent', agent, thread }, { type: 'delta', text: 'Partial' }]);
  await send();
  expect((await screen.findByRole('alert')).textContent).toContain('cut off');
  expect(screen.queryByText('Answer from sources.')).toBeNull();
});

it('restores authorized saved agent identity and citations with the release gate still closed', async () => {
  nav.enabled = false; nav.path = `/workspace/c/${tid}`;
  setup([], false, { agentId: agent.id, messages: [{ ...message, citations: [citation], knowledgeUnavailable: true }] });
  await screen.findByRole('button', { name: /Research agent/ });
  expect(screen.getByText('Canonical source')).toBeTruthy();
  expect(screen.getByText('Knowledge retrieval was unavailable for this answer.')).toBeTruthy();
  expect(screen.getByText('Custom-agent execution is not enabled yet.')).toBeTruthy();
});
it.each([null])('restores explicit null binding as ordinary chat, not a URL-selected agent', async (agentId) => {
  nav.path = `/workspace/c/${tid}`; setup([], false, { agentId, messages: [message] });
  await screen.findByText('Answer from sources.');
  expect(screen.getByRole('button', { name: /^Agent: TuGPT Assistant/ })).toBeTruthy();
  expect(calls.some((c) => c.url.startsWith('/api/v1/agents'))).toBe(false);
});
it('fails closed for lost agent access instead of falsely showing the built-in agent', async () => {
  nav.path = `/workspace/c/${tid}`; setup([], true, { agentId: agent.id, messages: [message] });
  await screen.findByRole('button', { name: /This agent is unavailable/ });
  expect(screen.queryByRole('button', { name: /^Agent: TuGPT Assistant/ })).toBeNull();
});
it('drops malformed restored citations while preserving valid sources and flag', async () => {
  nav.path = `/workspace/c/${tid}`; setup([], false, { agentId: null, messages: [{ ...message, citations: [{}, citation], knowledgeUnavailable: true }] });
  await screen.findByText('Canonical source');
  expect(screen.getAllByText('Canonical source')).toHaveLength(1);
});

it('never displays the built-in identity while resolving a requested custom agent', async () => {
  setup([]);
  expect(screen.getByText('Agent: Loading agent…')).toBeTruthy();
  expect(screen.queryByText('Agent: TuGPT Assistant')).toBeNull();
  expect(await screen.findByText('Agent: Research agent')).toBeTruthy();
});
