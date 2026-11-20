// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PublicModel, Thread } from './types';

// UI tests isolate the shared upload coordinator; its transport/recovery has dedicated tests.
vi.mock('@/lib/workspace/file-upload', () => ({ uploadSafely: async (file: File, type: string, _scope: string, _signal: AbortSignal, _progress: unknown, api: { uploadFile: (blob: Blob, name: string) => Promise<{ ok: boolean; value?: { file?: { id?: string } } }> }) => {
 const r = await api.uploadFile(new Blob([file], { type }), file.name);
 return r.ok && r.value?.file?.id ? { kind: 'stored', file: r.value.file } : { kind: 'uncertain' };
} }));
const nav = vi.hoisted(() => ({ path: '/workspace', search: '' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(nav.search) }));
import { ChatView } from './ChatView';
import { ThreadsProvider } from '@/components/workspace/ThreadsProvider';

const models: PublicModel[] = [{ key: 'scout', label: 'TuGPT Scout', description: 'Private model', private: true, toolCalling: false }];
const thread = { id: 'a0000000-0000-4000-8000-000000000001', title: 'Carrier review plan', modelKey: 'scout', updatedAt: '2026-11-15T09:00:00Z' };
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

function renderChat(props: { models: PublicModel[]; canApprove?: boolean; firstName?: string | null }, threads: Thread[] = []) {
  return render(<ThreadsProvider initialThreads={threads}><ChatView uploadScope="test-owner" {...props} /></ThreadsProvider>);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  nav.path = '/workspace'; nav.search = ''; sessionStorage.clear();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  fetchMock = vi.fn((url: string) => (String(url).endsWith('/capabilities') ? ok({ capabilities: [] }) : ok({ threads: [thread] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ChatView in the Workspace', () => {
  it('shows a new chat at /workspace with the title as the page heading', () => {
    renderChat({ models });
    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening)$/ })).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('greets the person by first name only', () => {
    renderChat({ models, firstName: 'Clara' });
    expect(screen.getByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening), Clara$/ })).toBeTruthy();
  });

  it('opens the chat named by /workspace/c/<id> and titles the page with it', async () => {
    nav.path = `/workspace/c/${thread.id}`;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u === `/api/v1/chat/threads/${thread.id}`) return ok({ thread, messages: [{ id: 'm1', role: 'user', content: 'Earlier question', status: 'complete', mentions: [], capabilityKey: null }] });
      return ok({ threads: [thread] });
    });
    renderChat({ models }, [thread]);
    expect(screen.getByRole('heading', { level: 1, name: 'Carrier review plan' })).toBeTruthy();
    await screen.findByText('Earlier question');
  });

  it('a chat that cannot be opened says so', async () => {
    nav.path = '/workspace/c/b0000000-0000-4000-8000-000000000009';
    fetchMock.mockImplementation((url: string) => (String(url).endsWith('/capabilities') ? ok({ capabilities: [] }) : Promise.resolve(new Response('{}', { status: 404 }))));
    renderChat({ models });
    expect((await screen.findByRole('alert')).textContent).toContain('This chat could not be opened.');
  });

  it('starting a chat moves the address to /workspace/c/<id> without a navigation, while the answer streams', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { end = () => c.close(); } });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u === '/api/v1/chat/threads' && init?.method === 'POST') return ok({ thread: { ...thread, title: 'New chat' } });
      if (u.endsWith('/messages')) return Promise.resolve(new Response(body, { status: 200 }));
      return ok({ threads: [] });
    });
    renderChat({ models });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Plan the carrier review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Stop' });
    expect(replace).toHaveBeenCalledWith(null, '', `/workspace/c/${thread.id}`);
    end();
    await screen.findByRole('button', { name: 'Send' });
  });
});

describe('ChatView integrations', () => {
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
    renderChat({ models });
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
    renderChat({ models: verified });
    await new Promise((r) => setTimeout(r, 0));
    const list = await openPicker();
    expect(list.querySelector('[role="option"]')?.getAttribute('aria-disabled')).toBe('false');
    fireEvent.mouseDown(list.querySelector('[role="option"]')!);
    expect(screen.getByLabelText('Attached apps').textContent).toContain('Google');
  });

  it('turns a 409 into a clear message with a link to Connect, and keeps the draft', async () => {
    fetchMock = withCaps([], () => Promise.resolve(new Response(JSON.stringify({ error: 'An attached integration is not connected' }), { status: 409 })));
    vi.stubGlobal('fetch', fetchMock);
    renderChat({ models: verified });
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
    renderChat({ models: verified });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'When am I free?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Stop' });
    push('{"type":"tool_start","tool":"calendar_find_availability"}\n{"type":"tool_result","tool":"calendar_find_availability","ok":false,"code":"REAUTHORIZATION_REQUIRED"}\n');
    const line = await screen.findByText(/Reconnect the account/);
    expect(line.textContent).not.toContain('REAUTHORIZATION_REQUIRED');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/dashboard/connect');
  });

  function streamed() {
    let push!: (s: string) => void; let end!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); push = (x) => c.enqueue(e.encode(x)); end = () => c.close(); } });
    return { body, push: (x: string) => push(x), end: () => end() };
  }

  it('names the account in tool steps and maps a turn error to words', async () => {
    const st = streamed();
    fetchMock = withCaps([], () => Promise.resolve(new Response(st.body, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderChat({ models: verified });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'When am I free?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Stop' });
    st.push('{"type":"tool_start","tool":"calendar_find_availability","provider":"Microsoft 365"}\n');
    expect(await screen.findByText(/Checking calendar availability in Microsoft 365/)).toBeTruthy();
    st.push('garbage line\n{"type":"error","code":"MODEL_BAD_RESPONSE"}\n'); st.end();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not read/);
  });

  it('never presents a cut-off stream as a finished answer', async () => {
    const st = streamed();
    fetchMock = withCaps([], () => Promise.resolve(new Response(st.body, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderChat({ models: verified });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Stop' });
    st.push('{"type":"delta","text":"Half an ans'); st.end();
    expect((await screen.findByRole('alert')).textContent).toMatch(/cut off/);
  });
});


describe('ChatView approval cards', () => {
  const toolModels: PublicModel[] = [{ ...models[0], toolCalling: true }];
  const TID = 'c0000000-0000-4000-8000-000000000001';
  const msg = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content, status: 'complete', mentions: [], capabilityKey: null });
  const approval = {
    callId: 'call_9', threadId: TID, endpointId: 'e0000000-0000-4000-8000-00000000000a', endpointName: 'Acme Docs (test)', endpointHost: 'mcp.acme.test',
    capability: 'external.create_ticket', toolName: 'create_ticket', toolDescription: 'Create a ticket', permissionClass: 'write',
    arguments: { title: 'VPN', api_token: 'tok_SECRET' }, argumentsSha256: 'b'.repeat(64),
  };
  function stream(lines: object[]) {
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  async function sendWith(lines: object[], canApprove = true) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u === `/api/v1/chat/threads/${TID}`) return ok({ thread: { ...thread, id: TID }, messages: [] });
      if (u.endsWith('/messages')) return Promise.resolve(stream(lines));
      return ok({ threads: [{ ...thread, id: TID }] });
    });
    nav.path = `/workspace/c/${TID}`;
    const view = renderChat({ models: toolModels, canApprove }, [{ ...thread, id: TID }]);
    await screen.findByRole('log');
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'open a ticket' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    return view;
  }

  it('renders the card after the answer it belongs to, without the secret value', async () => {
    const view = await sendWith([
      { type: 'user', message: msg('u1', 'user', 'open a ticket') },
      { type: 'tool_start', tool: 'create_ticket', callId: 'call_9', provider: 'Acme Docs (test)' },
      { type: 'tool_result', tool: 'create_ticket', callId: 'call_9', ok: false, code: 'APPROVAL_REQUIRED', provider: 'Acme Docs (test)' },
      { type: 'approval_required', approval },
      { type: 'delta', text: 'This is waiting for your approval.' },
      { type: 'done', message: msg('a1', 'assistant', 'This is waiting for your approval.') },
    ]);
    const heading = await screen.findByRole('heading', { name: 'Approve this action?' });
    const answer = screen.getByText('This is waiting for your approval.');
    expect(answer.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('tok_SECRET');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('drops a malformed approval payload instead of showing an approvable card', async () => {
    await sendWith([
      { type: 'user', message: msg('u1', 'user', 'x') },
      { type: 'approval_required', approval: { ...approval, permissionClass: 'read' } },
      { type: 'approval_required', approval: { ...approval, capability: 'external.delete_project' } },
      { type: 'done', message: msg('a1', 'assistant', 'ok') },
    ]);
    await screen.findByText('ok');
    expect(screen.queryByRole('heading', { name: 'Approve this action?' })).toBeNull();
  });

  it('still shows the card when the stream is cut off, together with the interruption error', async () => {
    await sendWith([
      { type: 'user', message: msg('u1', 'user', 'x') },
      { type: 'approval_required', approval },
      { type: 'delta', text: 'partial' },
    ]);
    await screen.findByRole('heading', { name: 'Approve this action?' });
    expect((await screen.findByRole('alert')).textContent?.length).toBeGreaterThan(0);
  });

  it('an approved call refused by the server keeps the approval and raises no page alert', async () => {
    await sendWith([
      { type: 'user', message: msg('u1', 'user', 'x') },
      { type: 'approval_required', approval },
      { type: 'done', message: msg('a1', 'assistant', 'ok') },
    ]);
    await screen.findByRole('heading', { name: 'Approve this action?' });
    const base = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/v1/connect/mcp/approvals') return ok({ approved: true, id: 'id-1', expiresAt: new Date(Date.now() + 900000).toISOString() });
      if (u.startsWith('/api/v1/chat/approvals/status')) return ok({ approved: true });
      if (u.endsWith('/approved-call')) return Promise.resolve(new Response(JSON.stringify({ error: 'This integration is not available in chat yet' }), { status: 409, headers: { 'content-type': 'application/json' } }));
      return base(url, init);
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await screen.findByText(/Not run: This integration is not available in chat yet\. The approval was not used/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke approval' })).toBeTruthy();
  });

  it('members see the card without an Approve button', async () => {
    await sendWith([
      { type: 'user', message: msg('u1', 'user', 'x') },
      { type: 'approval_required', approval },
      { type: 'done', message: msg('a1', 'assistant', 'ok') },
    ], false);
    await screen.findByRole('heading', { name: 'Approve this action?' });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });
});

describe('Workspace composer', () => {
  const two: PublicModel[] = [
    { key: 'scout', experience: 'standard', label: 'TuGPT Scout', description: 'Private model', private: true, toolCalling: true },
    { key: 'langdock:gpt', experience: 'advanced', label: 'GPT Hosted', description: 'Hosted model', private: false, toolCalling: false },
  ];

  it('switches model from the model menu, by keyboard, and sends with the chosen model', async () => {
    let sent: Record<string, unknown> | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u === '/api/v1/chat/threads' && init?.method === 'POST') { sent = JSON.parse(String(init.body)); return ok({ thread }); }
      if (u.endsWith('/messages')) return Promise.resolve(new Response('{"type":"done","message":{"id":"m9","role":"assistant","content":"ok","status":"complete","mentions":[],"capabilityKey":null}}\n', { status: 200 }));
      return ok({ threads: [] });
    });
    renderChat({ models: two });
    const button = screen.getByRole('button', { name: 'Assistant capability: Standard' });
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    fireEvent.click(button);
    const list = await screen.findByRole('listbox', { name: 'Choose an assistant capability' });
    expect(list.querySelectorAll('[role="option"]').length).toBe(2);
    expect(list.querySelector('[aria-selected="true"]')?.textContent).toContain('Standard');
    expect(list.textContent).not.toContain('Private');
    expect(list.textContent).not.toMatch(/GPT|Hosted|Scout/);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(screen.queryByRole('listbox', { name: 'Choose an assistant capability' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assistant capability: Advanced' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('ok');
    expect(sent).toEqual({ modelKey: 'langdock:gpt' });
  });

  it('closes the model menu on Escape and returns focus to its button', async () => {
    renderChat({ models: two });
    const button = screen.getByRole('button', { name: 'Assistant capability: Standard' });
    fireEvent.click(button);
    await screen.findByRole('listbox', { name: 'Choose an assistant capability' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Choose an assistant capability' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('the @ button opens the app picker at the caret', async () => {
    fetchMock.mockImplementation((url: string) => (String(url).endsWith('/capabilities')
      ? ok({ capabilities: [{ capabilityKey: 'calendar.find_availability', providerKey: 'google', providerName: 'Google', description: 'Find free time', permissionClass: 'read', state: 'connected', toolAvailable: true }] })
      : ok({ threads: [] })));
    renderChat({ models: two });
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'When am I free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use an app (@)' }));
    const list = await screen.findByRole('listbox');
    expect(list.textContent).toContain('Google');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('When am I free @');
  });

  it('attaches a text file, sends its text inside the message, and shows it as a chip', async () => {
    let body: { content?: string } = {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u === '/api/v1/chat/threads' && init?.method === 'POST') return ok({ thread });
      if (u.endsWith('/messages')) {
        body = JSON.parse(String(init?.body));
        const user = { id: 'u1', role: 'user', content: body.content, status: 'complete', mentions: [], capabilityKey: null };
        return Promise.resolve(new Response(`${JSON.stringify({ type: 'user', message: user })}\n{"type":"done","message":{"id":"a1","role":"assistant","content":"Summary ready","status":"complete","mentions":[],"capabilityKey":null}}\n`, { status: 200 }));
      }
      return ok({ threads: [] });
    });
    const { container } = renderChat({ models: two });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['line one\nline two'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });
    const chips = await screen.findByRole('list', { name: 'Attached files' });
    expect(chips.textContent).toContain('notes.md');
    expect(screen.getByText(/characters/).textContent).toMatch(/\/ 8,000 characters/);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Summarize this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Summary ready');
    expect(body.content).toBe('Summarize this\n\n[Attached file: notes.md]\nline one\nline two\n[End of attached file]');
    const sent = screen.getByRole('list', { name: 'Attached files' });
    expect(sent.textContent).toBe('notes.md');
    expect(screen.queryByText(/line two/)).toBeNull();
  });

  it('keeps unconfirmed uploads visible with an explicit check and never automatically retries', async () => {
    const { container } = renderChat({ models: two });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' })] } });
    await screen.findByText(/Upload unconfirmed/);
    expect(screen.getByRole('button', { name: 'Check / retry' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Uploaded documents' }).textContent).toContain('contract.pdf');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/files')).length).toBe(1);
  });

  it('refuses a file type the Files API does not take', async () => {
    const { container } = renderChat({ models: two });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([77, 90])], 'setup.exe', { type: 'application/x-msdownload' })] } });
    expect((await screen.findByText(/setup.exe: this file type is not supported/)).getAttribute('role')).toBe('status');
  });

  it('uploads a document, holds Send while it uploads, and links it to the chat the first message creates', async () => {
    let release: (() => void) | null = null;
    const calls: { url: string; init?: RequestInit }[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url); calls.push({ url: u, init });
      if (u.endsWith('/capabilities')) return ok({ capabilities: [] });
      if (u.startsWith('/api/v1/files?')) {
        return new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ file: { id: 'f0000000-0000-4000-8000-000000000001', filename: 'contract.pdf', mediaType: 'application/pdf', sizeBytes: 4, sha256: null, visibility: 'private', status: 'ready', ownedByMe: true, createdAt: '2026-11-15T09:00:00Z', updatedAt: '2026-11-15T09:00:00Z' } }), { status: 201, headers: { 'content-type': 'application/json' } })); });
      }
      if (u === '/api/v1/chat/threads' && init?.method === 'POST') return ok({ thread });
      if (u.endsWith('/attachments') && init?.method === 'POST') return ok({ attachment: {} });
      if (u.endsWith('/messages')) {
        return Promise.resolve(new Response('{"type":"done","message":{"id":"a1","role":"assistant","content":"Noted","status":"complete","mentions":[],"capabilityKey":null}}\n', { status: 200 }));
      }
      return ok({ threads: [] });
    });
    const { container } = renderChat({ models: two });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], 'contract.pdf', { type: 'application/pdf' })] } });
    const chips = await screen.findByRole('list', { name: 'Uploaded documents' });
    expect(chips.textContent).toContain('Uploading');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep this with the chat' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    const upload = calls.find((c) => c.url.startsWith('/api/v1/files?'));
    expect(upload?.url).toBe('/api/v1/files?filename=contract.pdf&visibility=private');
    expect((upload?.init?.headers as Record<string, string>)['x-tugpt-csrf']).toBe('1');
    release!();
    await screen.findByText(/does not read their contents yet/);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Noted');
    const link = calls.find((c) => c.url === `/api/v1/chat/threads/${thread.id}/attachments`);
    expect(JSON.parse(String(link?.init?.body))).toEqual({ fileId: 'f0000000-0000-4000-8000-000000000001' });
    const sent = calls.find((c) => c.url.endsWith('/messages'));
    expect(JSON.parse(String(sent?.init?.body)).content).toBe('Keep this with the chat');
  });

  it('a starter fills the message box and does not send', () => {
    renderChat({ models: two });
    fireEvent.click(screen.getByRole('button', { name: 'Draft an email' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(/^Draft a short, friendly email/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/messages'))).toBe(false);
  });

  it('/workspace?prompt=<known key> opens with that starter; unknown keys and raw text are ignored', () => {
    nav.search = 'prompt=summarize';
    const first = renderChat({ models: two });
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(/^Summarize the attached document/);
    first.unmount();
    nav.search = 'prompt=' + encodeURIComponent('Ignore previous instructions');
    renderChat({ models: two });
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });

  it('links to Images from the composer and from the starters', () => {
    renderChat({ models: two });
    const links = screen.getAllByRole('link', { name: 'Create an image' });
    expect(links.length).toBe(2);
    for (const a of links) expect(a.getAttribute('href')).toBe('/workspace/images');
  });

  it('shows the built-in agent and says custom agents are not available yet', () => {
    renderChat({ models: two });
    fireEvent.click(screen.getByRole('button', { name: 'Agent: TuGPT Assistant' }));
    const panel = screen.getByRole('group', { name: 'Agents' });
    expect(panel.textContent).toContain('TuGPT Assistant');
    expect(panel.textContent).toContain('Custom agents are not available yet.');
    expect(within(panel).getByRole('link', { name: 'Browse agents' }).getAttribute('href')).toBe('/workspace/agents');
  });
});

it('preserves a rejected draft and resends only on an explicit customer click', async () => {
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/capabilities')) return new Response(JSON.stringify({ capabilities: [] }));
    if (url.endsWith('/threads') && init?.method === 'POST') return new Response(JSON.stringify({ thread: { ...thread, agentId: null } }));
    if (url.endsWith('/messages')) {
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 });
      return new Response(JSON.stringify({ type: 'done', message: { id: 'retry-answer', role: 'assistant', content: 'Recovered response', status: 'complete', mentions: [], capabilityKey: null } }) + '\n');
    }
    return new Response(JSON.stringify({ threads: [], nextCursor: null }));
  }));
  renderChat({ models });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const retry = await screen.findByRole('button', { name: 'Send draft again' });
  expect(attempts).toBe(1);
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Keep my draft');
  fireEvent.click(retry);
  await screen.findByText('Recovered response');
  expect(attempts).toBe(2);
});

it.each(['network', 'http500', 'cutoff'])('reconciles %s without reposting an uncertain message', async (failure) => {
  let posts = 0;
  const saved = { id: 'saved-answer', role: 'assistant', content: 'Saved answer recovered', status: 'complete', mentions: [], capabilityKey: null };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/capabilities')) return new Response(JSON.stringify({ capabilities: [] }));
    if (url.endsWith('/threads') && init?.method === 'POST') return new Response(JSON.stringify({ thread: { ...thread, agentId: null } }));
    if (url.endsWith('/messages')) {
      posts++;
      if (failure === 'network') throw new Error('Connection lost');
      if (failure === 'http500') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ type: 'delta', text: 'Unconfirmed words' }) + '\n');
    }
    if (url.endsWith(thread.id)) return new Response(JSON.stringify({ thread: { ...thread, agentId: null }, messages: [saved] }));
    return new Response(JSON.stringify({ threads: [], nextCursor: null }));
  }));
  renderChat({ models });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Do not duplicate' } });
  const send = screen.getByRole('button', { name: 'Send' });
  fireEvent.click(send); fireEvent.click(send);
  const check = await screen.findByRole('button', { name: 'Check saved messages' });
  expect(posts).toBe(1);
  expect(screen.queryByRole('button', { name: 'Send draft again' })).toBeNull();
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  if (failure === 'cutoff') expect(screen.getByText('Unconfirmed words')).toBeTruthy();
  fireEvent.click(check);
  await screen.findByText('Saved answer recovered');
  expect(posts).toBe(1);
});

it('does not silently replace an unavailable saved model', async () => {
 nav.path = '/workspace/c/' + thread.id;
 vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
   url.endsWith('/capabilities') ? { capabilities: [] } : url.endsWith(thread.id)
     ? { thread: { ...thread, agentId: null, modelKey: 'retired-model' }, messages: [] } : { threads: [thread], nextCursor: null }
 ))));
 renderChat({ models }, [thread]);
 await screen.findByText('The saved assistant capability is unavailable. Choose an available capability before sending.');
 fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Choose deliberately' } });
 expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button', { name: /^Assistant capability:/ }));
 fireEvent.mouseDown(await screen.findByRole('option', { name: /TuGPT Assistant/ }));
 expect(screen.queryByText('The saved assistant capability is unavailable. Choose an available capability before sending.')).toBeNull();
 expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
});

it('restores recovery after remount and only clears a correlated complete answer', async () => {
 const {saveChatRecovery}=await import('@/lib/workspace/chat-recovery');
 saveChatRecovery('test-owner',{threadId:thread.id,original:'Restore me',partial:'Partial persisted',userMessageId:'u-recovery'});
 nav.path='/workspace/c/'+thread.id;let complete=false;let posts=0;
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts++;return ok(url.endsWith('/capabilities')?{capabilities:[]}:url.endsWith(thread.id)?{thread:{...thread,agentId:null},messages:complete?[{id:'u-recovery',role:'user',content:'Restore me',status:'complete',mentions:[]},{id:'a-recovery',role:'assistant',content:'Verified saved answer',status:'complete',mentions:[]}]:[]}:{threads:[thread]});});
 const first=renderChat({models},[thread]);await screen.findByText('Partial persisted');first.unmount();
 renderChat({models},[thread]);await screen.findByText('Partial persisted');fireEvent.click(screen.getByRole('button',{name:'Check saved messages'}));await screen.findByText(/completed answer for this exact request has not been confirmed/);
 expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
 complete=true;fireEvent.click(screen.getByRole('button',{name:'Check saved messages'}));await screen.findByText('Verified saved answer');expect(posts).toBe(0);
});
