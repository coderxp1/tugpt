// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LibraryView } from './LibraryView';
import { AgentsView } from './AgentsView';

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const notDeployed = () => Promise.resolve(new Response('<!DOCTYPE html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }));
/** Knowledge answers with `response`; the Library collections API is not deployed (Next's HTML 404). */
function stub(response: () => Promise<Response>) {
  const f = vi.fn((url: string) => (String(url).startsWith('/api/v1/knowledge') ? response() : notDeployed()));
  vi.stubGlobal('fetch', f);
  return f;
}
const knowledgeCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/knowledge')).length;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const entries = [
  { id: 'k1', question: '¿Cuál es el horario de atención?', answer: 'De 9 a 18 h.', enabled: true },
  { id: 'k2', question: 'Return policy', answer: '30 days with receipt.', enabled: false },
];

describe('LibraryView', () => {
  it('reads knowledge from the existing API, searches it, and marks disabled entries', async () => {
    const f = stub(() => json(200, { entries }));
    render(<LibraryView canManage={false} />);
    expect(screen.getByLabelText('Loading knowledge').getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByText('Return policy')).toBeTruthy();
    expect(f).toHaveBeenCalledWith('/api/v1/knowledge', { cache: 'no-store' });
    expect(screen.getByText('Off')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'horario' } });
    expect(screen.queryByText('Return policy')).toBeNull();
    expect(screen.getByText('¿Cuál es el horario de atención?')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches “zzz”.')).toBeTruthy();
  });

  it('members get no management link; owners and admins do', async () => {
    stub(() => json(200, { entries: [] }));
    const m = render(<LibraryView canManage={false} />);
    expect(await screen.findByText('An owner or admin can add entries in the Dashboard.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Manage in Dashboard' })).toBeNull();
    m.unmount();
    render(<LibraryView canManage />);
    expect(await screen.findByText('Add your first entries in the Dashboard.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage in Dashboard' }).getAttribute('href')).toBe('/dashboard/knowledge');
  });

  it('says knowledge is unavailable when the feature is off', async () => {
    stub(() => json(403, { error: { code: 'FEATURE_UNAVAILABLE', message: 'Not enabled for this organization.' } }));
    render(<LibraryView canManage={false} />);
    expect(await screen.findByText('Knowledge is not available for this organization.')).toBeTruthy();
    expect(screen.getByText('Not enabled for this organization.')).toBeTruthy();
  });

  it('reports a failure and retries', async () => {
    let n = 0;
    const f = stub(() => (n++ === 0 ? json(500, { error: { code: 'INTERNAL' } }) : json(200, { entries })));
    render(<LibraryView canManage={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Knowledge could not be loaded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Return policy')).toBeTruthy();
    expect(knowledgeCalls(f)).toBe(2);
  });

  it('lists starters as links that carry only the starter key', async () => {
    stub(() => json(200, { entries: [] }));
    render(<LibraryView canManage={false} />);
    const links = screen.getAllByRole('link', { name: /^Use in new chat/ });
    expect(links.length).toBe(6);
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^\/workspace\?prompt=[a-z]+$/);
    await waitFor(() => expect(screen.queryByLabelText('Loading knowledge')).toBeNull());
  });
});

describe('AgentsView', () => {
  it('shows the built-in assistant, lists no custom agents that cannot run, and says why', async () => {
    stub(notDeployed);
    render(<AgentsView />);
    expect(screen.getByRole('heading', { level: 1, name: 'Agents for your work' })).toBeTruthy();
    const cards = screen.getAllByRole('heading', { level: 3 });
    expect(cards.map((h) => h.textContent)).toEqual(['TuGPT Assistant']);
    expect(screen.getByRole('link', { name: 'Start a chat' }).getAttribute('href')).toBe('/workspace');
    expect(await screen.findByText('Custom agents: not available in this workspace yet.')).toBeTruthy();
  });
});
