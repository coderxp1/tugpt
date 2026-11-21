// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTranslator } from '@/i18n';
import { resolveProducts } from '@/lib/hub/products';
import { UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { describeFeatures, featureMap, type FeatureFacts } from '@/lib/hub/features';
import { ProductHub } from './ProductHub';

vi.mock('@/lib/supabase/server', () => ({ createFeatureServerClient: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ refresh }) }));
vi.mock('next/link', () => ({ default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a> }));
const lang = vi.hoisted(() => ({ locale: 'en' as 'en' | 'es' }));
vi.mock('@/i18n/provider', async () => { const { createTranslator } = await import('@/i18n'); return { useT: () => createTranslator(lang.locale) }; });

/** Hartmann in the kit: Workspace up, MCP manageable with no active server, drafts flag off, providers not offered. */
const KIT: FeatureFacts = { draftsEnabled: false, google: 'off', microsoft: 'off', mcpManage: true, mcpActive: false, mcpChat: false, imagesConfigured: false, hasChatModel: true,
  workspaceDb: 'ok', libraryDb: 'ok', approvalsDb: 'ok', customAgents: false, canManage: true };
const signals: HubSignals = { ...UNAVAILABLE_SIGNALS };
function renderHub(f: FeatureFacts = KIT, opts: { org?: string | null; name?: string | null; locale?: 'en' | 'es' } = {}) {
  lang.locale = opts.locale ?? 'en';
  const statuses = describeFeatures(f, createTranslator(lang.locale));
  const org = opts.org === undefined ? 'Hartmann Logistik GmbH' : opts.org;
  return render(<ProductHub organizationName={org} fullName={opts.name === undefined ? 'Anna Berger' : opts.name} email="anna@example.test" role="owner" roleKey="owner" t={createTranslator(lang.locale)}
    products={resolveProducts(signals)} features={featureMap(statuses)} statuses={statuses} />);
}
const section = (c: HTMLElement, id: string) => c.querySelector(`[data-section="${id}"]`) as HTMLElement | null;
const feats = (el: HTMLElement | null) => [...(el?.querySelectorAll('[data-feature]') ?? [])].map((n) => n.getAttribute('data-feature'));
afterEach(() => { cleanup(); vi.clearAllMocks(); lang.locale = 'en'; });

describe('Dashboard control center', () => {
  it('greets the person, names the organization and offers a re-check', () => {
    renderHub();
    expect(screen.getByRole('heading', { level: 1, name: 'Hello, Anna' })).toBeTruthy();
    expect(screen.getByTestId('cc-org').textContent).toBe('Hartmann Logistik GmbH');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('makes the real Workspace the front door, linking only the Workspace sections that are ready', () => {
    renderHub();
    const ws = screen.getByTestId('cc-workspace');
    expect(within(ws).getByRole('link', { name: /Open Workspace/ }).getAttribute('href')).toBe('/workspace');
    const jump = within(ws).getByRole('list', { name: 'Workspace sections' });
    expect(within(jump).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/workspace/library', '/workspace/approvals']);
  });

  it('explains instead of linking when the Workspace cannot be used', () => {
    renderHub({ ...KIT, hasChatModel: false });
    const ws = screen.getByTestId('cc-workspace');
    expect(within(ws).queryByRole('link')).toBeNull();
    expect(ws.textContent).toMatch(/Not enabled/);
  });

  it('sorts every feature into exactly one honest section', () => {
    const { container } = renderHub();
    expect(feats(section(container, 'ready'))).toEqual(['chat', 'library', 'approvals', 'team', 'analytics']);
    expect(feats(section(container, 'setup'))).toEqual(['mcp']);
    expect(feats(section(container, 'disabled'))).toEqual(['images', 'inbox', 'drafts', 'knowledge']);
    expect(feats(section(container, 'review'))).toEqual(['custom_agents', 'mcp_chat', 'media']);
    expect(section(container, 'unknown')).toBeNull();
    expect(feats(section(container, 'later'))).toEqual(['google', 'microsoft']);
  });

  it('gives ready and setup features a real action and the setup journey goes to Apps & tools', () => {
    const { container } = renderHub();
    const ready = section(container, 'ready')!;
    expect(within(ready).getByRole('link', { name: /Open Workspace/ }).getAttribute('href')).toBe('/workspace');
    expect(within(ready).getByRole('link', { name: /Invite people/ }).getAttribute('href')).toBe('/dashboard/settings#team');
    expect(within(section(container, 'setup')!).getByRole('link', { name: /Add a server/ }).getAttribute('href')).toBe('/dashboard/connect#mcp-title');
    // Switched-off, held and not-yet features have no "open" or setup action, only an explanation.
    for (const id of ['disabled', 'review', 'later']) for (const a of within(section(container, id)!).queryAllByRole('link')) expect(a.textContent, id).toMatch(/^See details/);
  });

  it('says who can enable a feature, and gives members no setup button', () => {
    const { container } = renderHub({ ...KIT, canManage: false, microsoft: 'ready' });
    const setup = section(container, 'setup')!;
    expect(feats(setup)).toEqual(['microsoft', 'mcp']);
    expect(within(setup).queryAllByRole('link')).toHaveLength(0);
    expect(setup.textContent).toMatch(/owner or administrator/i);
    expect(section(container, 'disabled')!.textContent).toMatch(/Ask an owner or admin/);
  });

  it('shows "Couldn\'t check" for unreadable gates and never "Ready"', () => {
    const { container } = renderHub({ ...KIT, draftsEnabled: null, mcpActive: null, libraryDb: 'unknown' });
    expect(feats(section(container, 'unknown'))).toEqual(['library', 'mcp', 'inbox', 'drafts', 'knowledge']);
    expect(feats(section(container, 'ready'))).not.toContain('library');
  });

  it('covers all fourteen official Blueprint areas, each with a real status or a not-yet name', () => {
    const { container } = renderHub();
    const shown = new Set(feats(container));
    const names = within(section(container, 'later')!).getAllByRole('listitem').map((li) => li.textContent);
    const area: Record<string, string> = {
      'Core Workspace': 'chat', 'Messaging Center': 'inbox', 'MCP Layer': 'mcp', 'Custom AI Agents': 'custom_agents', 'Knowledge & Integrations': 'knowledge', 'Administration & Governance': 'team',
      'CRM Hub': 'CRM integration', 'Research & Search': 'Web research with sources', 'Workflow Automation': 'Workflow automation', 'Developer Platform': 'Developer API',
      'Privacy & Deployment': 'Choice of hosting region', 'Live Voice': 'Voice assistants', 'Video Generation': 'Video generation', 'WhatsApp': 'WhatsApp',
    };
    expect(Object.keys(area)).toHaveLength(14);
    for (const [a, v] of Object.entries(area)) expect(shown.has(v) || names.some((n) => n?.startsWith(v)), a).toBe(true);
  });

  it('makes no promotional or internal claims', () => {
    const { container } = renderHub();
    expect(container.textContent).not.toMatch(/Blueprint|feature flag|webhook|Staging|APIs exist|regardless of|coming soon|unlimited|all your tools|seamless|TUGPT_|\/api\//i);
    expect(container.textContent).not.toMatch(/\d+ (open|need)/);
  });

  it('renders in Spanish', () => {
    const { container } = renderHub(KIT, { locale: 'es' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hola, Anna');
    expect(section(container, 'ready')!.textContent).toMatch(/Listo para usar/);
    expect(screen.getByTestId('cc-workspace').textContent).toMatch(/Abrir el Workspace/);
  });

  it('handles a person without a name or organization', () => {
    renderHub(KIT, { org: null, name: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeTruthy();
    expect(screen.getByText(/no active organization/)).toBeTruthy();
  });
});
