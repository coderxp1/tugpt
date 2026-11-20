// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MembersList, MEMBER_ACTIONS_NOTE } from './MembersList';

const members = [
  { userId: 'u1', name: 'Anna Owner', email: 'anna@hartmann.example', role: 'owner', joinedAt: '2026-01-02T00:00:00Z' },
  { userId: 'u2', name: 'Clara Member', email: 'clara@hartmann.example', role: 'agent', joinedAt: '2026-02-03T00:00:00Z' },
];
afterEach(cleanup);

describe('MembersList', () => {
  it('shows role change and removal to owners, but disabled and explained, never on their own row', () => {
    render(<MembersList members={members} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    const clara = screen.getByText('Clara Member').closest('tr')!;
    const select = within(clara).getByRole('combobox', { name: 'Role for Clara Member' }) as HTMLSelectElement;
    const remove = within(clara).getByRole('button', { name: /Remove Clara Member/ }) as HTMLButtonElement;
    expect(select.disabled).toBe(true); expect(remove.disabled).toBe(true);
    expect(select.value).toBe('agent');
    expect(remove.getAttribute('aria-describedby')).toBe('member-actions-note');
    expect(document.getElementById('member-actions-note')?.textContent).toMatch(/nothing is changed/);
    const anna = screen.getByText('Anna Owner').closest('tr')!;
    expect(within(anna).queryByRole('button')).toBeNull();
    expect(within(anna).getByText('You')).toBeTruthy();
    expect(MEMBER_ACTIONS_NOTE).toMatch(/not available yet/);
  });
  it('shows members no management controls', () => {
    render(<MembersList members={members} viewerId="u2" viewerRole="agent" organizationName="Hartmann" />);
    expect(screen.queryByRole('columnheader', { name: 'Manage' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // No controls, so no note about switched-off controls either.
    expect(document.getElementById('member-actions-note')).toBeNull();
  });
  it('reports a failed load instead of an empty team', () => {
    render(<MembersList members={null} viewerId="u1" viewerRole="owner" organizationName="Hartmann" />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  });
});
