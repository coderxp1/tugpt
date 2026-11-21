// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n/provider';
import { MembersList, ANNOUNCE_DELAY_MS } from './MembersList';

const members = [
  { userId: 'u1', name: 'Anna Owner', email: 'anna.owner@hartmann.example', role: 'owner', joinedAt: '2026-01-02T00:00:00Z' },
  { userId: 'u2', name: 'José Núñez', email: 'jose@hartmann.example', role: 'admin', joinedAt: '2026-02-03T00:00:00Z' },
  { userId: 'u3', name: 'Clara Member', email: 'clara@hartmann.example', role: 'agent', joinedAt: '2026-02-04T00:00:00Z' },
  { userId: 'u4', name: 'Ben Owner', email: 'ben@nordwind.example', role: 'agent', joinedAt: '2026-02-05T00:00:00Z' },
];
afterEach(() => { cleanup(); vi.useRealTimers(); });

const rows = () => [...document.querySelectorAll('tbody tr')].map((r) => r.querySelector('strong')!.textContent);
const box = () => screen.getByRole('searchbox', { name: 'Search members' }) as HTMLInputElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
const status = () => screen.getByTestId('member-search-status');
const settle = () => act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS + 10); });

describe('MembersList search', () => {
  it('is a labelled search box with a hint, linked to the table, and announces nothing before a search', () => {
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    const input = box();
    expect(input.type).toBe('search');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toMatch(/name, email and role/);
    const region = document.getElementById(input.getAttribute('aria-controls')!)!;
    expect(region.querySelector('table')).not.toBeNull();
    expect(screen.getByRole('search', { name: 'Search the member list' })).toBeTruthy();
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe('');
    expect(rows()).toEqual(['Anna Owner', 'José Núñez', 'Clara Member', 'Ben Owner']);
  });

  it('filters as you type and announces the count only after typing pauses', () => {
    vi.useFakeTimers();
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    type('o');
    type('ow');
    type('owner');
    expect(rows()).toEqual(['Anna Owner', 'Ben Owner']);
    expect(status().textContent).toBe('');
    settle();
    expect(status().textContent).toBe('Showing 2 of 4 people.');
    // The header keeps the real total.
    expect(screen.getByTestId('member-count').textContent).toBe('4 people');
  });

  it('ignores case and accents and searches email and role', () => {
    vi.useFakeTimers();
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    type('JOSE nunez'); expect(rows()).toEqual(['José Núñez']);
    settle(); expect(status().textContent).toBe('Showing 1 of 4 people.');
    type('@nordwind'); expect(rows()).toEqual(['Ben Owner']);
    type('administrator'); expect(rows()).toEqual(['José Núñez']);
    type('member'); expect(rows()).toEqual(['Clara Member', 'Ben Owner']);
    type('owner hartmann'); expect(rows()).toEqual(['Anna Owner']);
  });

  it('says clearly when nobody matches, and Clear search restores the list and focus', () => {
    vi.useFakeTimers();
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    type('  zzqx  ');
    settle();
    expect(document.querySelector('table')).toBeNull();
    const empty = screen.getByTestId('member-search-empty');
    // aria-controls must still point at an element that exists when the table is gone (axe aria-valid-attr-value)
    expect(document.getElementById(box().getAttribute('aria-controls')!)!.contains(empty)).toBe(true);
    expect(empty.textContent).toMatch('No one matches “zzqx”.');
    expect(empty.textContent).toMatch(/Check the spelling/);
    expect(empty.textContent).toMatch(/listed under Invitations/);
    expect(status().textContent).toBe('No one matches “zzqx”.');
    // still announced, but not shown twice: the notice above already says it visibly
    expect(status().className).toMatch(/sr/);
    fireEvent.click(within(empty).getByRole('button', { name: 'Clear search' }));
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    expect(rows()).toHaveLength(4);
    expect(status().textContent).toBe('');
  });

  it('does not mention Invitations to members, who cannot see that list', () => {
    render(<MembersList members={members} viewerId="u3" viewerRole="agent" organizationName="Hartmann" />);
    type('zzqx');
    expect(screen.getByTestId('member-search-empty').textContent).not.toMatch(/Invitations/);
  });

  it('Escape clears an active search but leaves an empty box alone', () => {
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    type('clara');
    expect(rows()).toEqual(['Clara Member']);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { box().dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(box().value).toBe('');
    expect(rows()).toHaveLength(4);
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { box().dispatchEvent(esc2); });
    expect(esc2.defaultPrevented).toBe(false);
  });

  it('uses the singular wording for a one-person organization', () => {
    vi.useFakeTimers();
    render(<MembersList members={[members[3]]} viewerId="u4" viewerRole="owner" organizationName="Nordwind" />);
    type('ben'); settle();
    expect(status().textContent).toBe('Showing the only person.');
  });

  it('sends no requests while searching', () => {
    const f = vi.spyOn(globalThis, 'fetch');
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    type('anna'); type('zzqx'); type('');
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it('has no search box when the list failed to load or is empty', () => {
    render(<MembersList members={null} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    cleanup();
    render(<MembersList members={[]} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('works in Spanish: Spanish labels, Spanish role names, Spanish announcements', () => {
    vi.useFakeTimers();
    render(<I18nProvider locale="es"><MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" /></I18nProvider>);
    const input = screen.getByRole('searchbox', { name: 'Buscar miembros' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Nombre, correo o rol');
    fireEvent.change(input, { target: { value: 'PROPIETARIO' } });
    expect(rows()).toEqual(['Anna Owner']);
    settle(); expect(status().textContent).toBe('Se muestra 1 de 4 personas.');
    fireEvent.change(input, { target: { value: 'miembro' } });
    settle(); expect(status().textContent).toBe('Se muestran 2 de 4 personas.');
    fireEvent.change(input, { target: { value: 'administrator' } });
    settle();
    expect(status().textContent).toBe('Nadie coincide con «administrator».');
    expect(screen.getByRole('button', { name: 'Borrar la búsqueda' })).toBeTruthy();
    expect(screen.getByTestId('member-search-empty').textContent).toMatch(/Invitaciones/);
  });
});
