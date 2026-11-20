// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n/provider';
import { MembersList } from './MembersList';
import { RolePermissions } from './RolePermissions';
import { LanguagePreference } from './LanguagePreference';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const members = [
  { userId: 'u1', name: 'Anna Owner', email: 'anna@hartmann.example', role: 'owner', joinedAt: '2026-01-02T00:00:00Z' },
  { userId: 'u2', name: 'Clara Member', email: 'clara@hartmann.example', role: 'agent', joinedAt: '2026-02-03T00:00:00Z' },
];
afterEach(cleanup);

describe('MembersList', () => {
  it('gives owners no fake role/remove controls, only a plain explanation', () => {
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('member-changes-note').textContent).toMatch(/Not possible in TuGPT yet/);
    const anna = screen.getByText('Anna Owner').closest('tr')!;
    expect(within(anna).getByText('You')).toBeTruthy();
    expect(within(anna).getByText('Owner')).toBeTruthy();
    // The same role names as the sidebar and Overview.
    expect(within(screen.getByText('Clara Member').closest('tr')!).getByText('Member')).toBeTruthy();
    expect(screen.getByTestId('member-count').textContent).toBe('2 people');
  });
  it('shows members the list without the management note', () => {
    render(<MembersList members={members} viewerId="u2" viewerRole="agent" organizationName="Hartmann" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByTestId('member-changes-note')).toBeNull();
  });
  it('reports a failed load instead of an empty team', () => {
    render(<MembersList members={null} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  });
  it('renders in Spanish with Spanish role names and dates', () => {
    render(<I18nProvider locale="es"><MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" /></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Miembros' })).toBeTruthy();
    expect(screen.getByText('Propietario')).toBeTruthy();
    expect(screen.getByText('Miembro')).toBeTruthy();
    expect(screen.getByText('Usted')).toBeTruthy();
    for (const en of ['Members', 'Owner', 'Member', 'Joined', 'You', '2 people', 'Not possible in TuGPT yet']) expect(screen.queryByText(en, { exact: false, ignore: 'strong' })).toBeNull();
  });
});

describe('RolePermissions', () => {
  it('marks the viewer\u2019s own column and states only enforced rules', () => {
    render(<RolePermissions role="admin" />);
    expect(screen.getByText('Your role: Administrator')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Administrator' }).getAttribute('aria-current')).toBe('true');
    const ownerRow = screen.getByRole('rowheader', { name: 'Invite someone as Owner' }).closest('tr')!;
    expect([...ownerRow.querySelectorAll('td')].map((td) => td.getAttribute('data-cell'))).toEqual(['yes', 'no', 'no']);
    const roles = screen.getByRole('rowheader', { name: 'Change roles or remove members' }).closest('tr')!;
    expect(within(roles).getAllByText('Nobody yet')).toHaveLength(3);
    // Every stacked cell carries its mobile label.
    for (const td of document.querySelectorAll('td')) expect(td.getAttribute('data-label')).toBeTruthy();
  });
  it('maps manager/member/viewer to the shared column', () => {
    render(<RolePermissions role="viewer" />);
    expect(screen.getByRole('columnheader', { name: 'Manager, Member, Viewer' }).getAttribute('aria-current')).toBe('true');
  });
});

describe('LanguagePreference', () => {
  it('stores the choice in a cookie and refreshes; nothing is sent to the server', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const written: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => written.join('; '), set: (v: string) => { written.push(v); } });
    render(<LanguagePreference />);
    const apply = screen.getByRole('button', { name: 'Apply language' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Dashboard language'), { target: { value: 'es' } });
    fireEvent.click(apply);
    expect(written).toEqual(['tugpt_locale=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure']);
    expect(refresh).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    Object.defineProperty(document, 'cookie', desc);
  });
});
