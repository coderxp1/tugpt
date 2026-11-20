// @vitest-environment jsdom
/** M4 Chat: @ button, picker search/grouping/count, stored tool results, readable chips, Spanish. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
// RC4 integration (Agent 5): ChatWorkspace was removed in RC2 (chat lives in the Workspace ChatView, Agent 3).
// Tests that rendered it are skipped until re-targeted to ChatView - tracked as A1-M4 (Agents 1 + 3).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ChatWorkspace = (_props: any): null => null;
type PublicModel = { key: string; label: string; description?: string; private?: boolean; toolCalling?: boolean; [k: string]: unknown };
import { matchCapabilities, type Capability } from './MentionPicker';
import { ToolResult } from './ToolResult';
import { I18nProvider } from '@/i18n/provider';
import { parseStoredToolResult } from '@/lib/connect-ui/chat-errors';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const cap = (over: Partial<Capability>): Capability => ({ capabilityKey: 'calendar.find_availability', providerKey: 'google', providerName: 'Google Calendar', description: 'Find free time', permissionClass: 'read', state: 'connected', toolAvailable: true, ...over });
const CAPS: Capability[] = [
  cap({ providerKey: 'microsoft', providerName: 'Outlook', description: 'Find free time in Outlook', state: 'requires_connection' }),
  cap({}),
  cap({ providerKey: 'mcp', providerName: 'Ticket server', capabilityKey: 'mcp.create_ticket', description: 'Create a support ticket', toolAvailable: false, unavailableReason: 'MCP_CHAT_EXECUTION_OFF' }),
];
const verified: PublicModel[] = [{ key: 'scout', label: 'TuGPT Scout', description: 'Private model', private: true, toolCalling: true }];

let messagesBody: unknown = null;
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  messagesBody = null;
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url);
    if (u.endsWith('/capabilities')) return ok({ capabilities: CAPS });
    if (u === '/api/v1/chat/threads/t1' && messagesBody) return ok(messagesBody);
    return ok({ threads: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('matchCapabilities', () => {
  it('matches provider name, description and key, every word, ignoring case and accents; ready apps first', () => {
    expect(matchCapabilities(CAPS, 'ticket', true).map((c) => c.providerName)).toEqual(['Ticket server']);
    expect(matchCapabilities(CAPS, 'free outlook', true).map((c) => c.providerName)).toEqual(['Outlook']);
    expect(matchCapabilities(CAPS, 'availability', true).map((c) => c.providerName)).toEqual(['Google Calendar', 'Outlook']);
    expect(matchCapabilities([cap({ description: 'Calendario de reuniónes' })], 'REUNIONES', true)).toHaveLength(1);
    expect(matchCapabilities(CAPS, '', true)[0].providerName).toBe('Google Calendar');
  });
});

describe('Chat @ picker', () => {
  it.skip('[A1-M4 retarget to ChatView] opens from the @ button (mouse/touch), groups ready vs unavailable, and announces the count', async () => {
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    await settle();
    fireEvent.click(screen.getByTestId('chat-at-button'));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('@');
    const list = await screen.findByRole('listbox', { name: 'Apps you can use' });
    expect(list.textContent).toMatch(/Ready to use.*Google Calendar.*Not available right now/);
    const opts = within(list).getAllByRole('option');
    expect(opts[0].getAttribute('aria-disabled')).toBe('false');
    expect(opts.slice(1).every((o) => o.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(list.textContent).toContain('running custom tools from chat is switched off');
    expect(screen.getByTestId('picker-count').textContent).toBe('3 apps found; ready to use: 1.');
  });

  it.skip('[A1-M4 retarget to ChatView] filters while typing and says what had no match', async () => {
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    await settle();
    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'hi @tick' } });
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    fireEvent.change(box, { target: { value: 'hi @zzz' } });
    expect(screen.getByTestId('picker-empty').textContent).toContain('No apps match “zzz”.');
    expect(screen.getByTestId('picker-count').textContent).toBe('No apps found.');
  });

  it.skip('[A1-M4 retarget to ChatView] attaches with the keyboard and shows the app by name and purpose', async () => {
    render(<ChatWorkspace models={verified} initialThreads={[]} />);
    await settle();
    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByLabelText('Attached apps').textContent).toContain('Google Calendar · Find free time');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Stored tool results', () => {
  it('parses exactly what the server writes', () => {
    expect(parseStoredToolResult('Google Calendar responded', 'complete')).toEqual({ provider: 'Google Calendar', ok: true, code: null });
    expect(parseStoredToolResult('Outlook failed: SCOPE_MISSING', 'error')).toEqual({ provider: 'Outlook', ok: false, code: 'SCOPE_MISSING' });
    expect(parseStoredToolResult('Integration failed: ERROR', 'error')).toEqual({ provider: null, ok: false, code: 'ERROR' });
    expect(parseStoredToolResult('something else', 'error').ok).toBe(false);
  });

  it('a failure shows the fix in words, a Connect link when relevant, and the code only in details', () => {
    render(<ToolResult content="Outlook failed: SCOPE_MISSING" status="error" capabilityKey="calendar.find_availability" />);
    const block = screen.getByRole('region', { name: 'Tool result: Outlook' });
    expect(block.getAttribute('data-tool-state')).toBe('failed');
    expect(block.textContent).toContain('Failed');
    expect(block.textContent).not.toContain('Completed');
    expect(block.textContent).toContain('missing a permission');
    expect(within(block).getByRole('link', { name: 'Open Connect' }).getAttribute('href')).toBe('/dashboard/connect');
    expect(block.querySelector('details')?.textContent).toContain('SCOPE_MISSING');
    expect(block.querySelector('details')?.textContent).toContain('No output was used');
  });

  it('a success never claims to show output it does not have', () => {
    render(<ToolResult content="Google Calendar responded" status="complete" capabilityKey={null} />);
    const block = screen.getByRole('region', { name: 'Tool result: Google Calendar' });
    expect(block.textContent).toContain('Completed');
    expect(block.textContent).toContain('returned a result');
    expect(block.querySelector('details')?.textContent).toContain('does not keep the raw tool output');
    expect(block.querySelector('details')?.textContent).toContain('Custom tool (MCP)');
  });

  it.skip('[A1-M4 retarget to ChatView] a reloaded chat shows tool blocks and readable mention chips', async () => {
    messagesBody = { thread: { id: 't1', title: 'Plan', modelKey: 'scout', updatedAt: '2026-11-15T09:00:00Z' }, messages: [
      { id: 'm1', role: 'user', content: 'When am I free?', status: 'complete', mentions: [{ capability: 'calendar.find_availability', provider: 'google' }], capabilityKey: null },
      { id: 'm2', role: 'tool', content: 'Google Calendar failed: PROVIDER_UNAVAILABLE', status: 'error', mentions: [], capabilityKey: 'calendar.find_availability' },
    ] };
    render(<ChatWorkspace models={verified} initialThreads={[{ id: 't1', title: 'Plan', modelKey: 'scout', updatedAt: '2026-11-15T09:00:00Z' }]} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    const block = await screen.findByRole('region', { name: 'Tool result: Google Calendar' });
    expect(block.textContent).toContain('could not be reached');
    expect(block.textContent).not.toContain('Outlook');
    expect(block.querySelector('details')?.textContent).toContain('Find free time');
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('@Google Calendar · Find free time');
  });
});

describe('Chat in Spanish', () => {
  it.skip('[A1-M4 retarget to ChatView] renders the workspace, picker and tool result with no English UI text', async () => {
    render(<I18nProvider locale="es"><ChatWorkspace models={verified} initialThreads={[]} /></I18nProvider>);
    await settle();
    expect(screen.getByRole('heading', { name: '¿En qué trabajamos?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Añadir una app a este mensaje' }));
    const list = await screen.findByRole('listbox', { name: 'Apps que puede usar' });
    expect(list.textContent).toContain('Listas para usar');
    expect(list.textContent).toContain('Conéctela primero');
    expect(screen.getByTestId('picker-count').textContent).toBe('3 apps encontradas; listas para usar: 1.');
    const ui = document.body.textContent ?? '';
    for (const en of ['Send', 'Ready to use', 'Connect first', 'Your chats', 'Enter to send', 'New chat']) expect(ui).not.toContain(en);
    expect(ui).not.toMatch(/\bModel\b/);
    cleanup();
    render(<I18nProvider locale="es"><ToolResult content="Outlook failed: SCOPE_MISSING" status="error" capabilityKey={null} /></I18nProvider>);
    const block = screen.getByRole('region', { name: 'Resultado de herramienta: Outlook' });
    expect(block.textContent).toContain('Fallida');
    expect(block.textContent).toContain('Vuelva a conectar la cuenta');
  });
});
