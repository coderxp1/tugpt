// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeamInvitations, effectiveStatus, invitableRoles, inviteLink } from './TeamInvitations';

const future = new Date(Date.now() + 7 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();
const INV = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'pending@example.com', role: 'agent', status: 'pending', expires_at: future, created_at: past },
  { id: '22222222-2222-4222-8222-222222222222', email: 'old@example.com', role: 'viewer', status: 'pending', expires_at: past, created_at: past },
  { id: '33333333-3333-4333-8333-333333333333', email: 'done@example.com', role: 'manager', status: 'accepted', expires_at: future, created_at: past },
];
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('helpers', () => {
  it('builds a fragment link so the token is never sent to a server', () => {
    expect(inviteLink('https://app.example', 'a b')).toBe('https://app.example/invite#a%20b');
  });
  it('only owners may offer the owner role', () => {
    expect(invitableRoles('owner')).toContain('owner');
    expect(invitableRoles('admin')).not.toContain('owner');
  });
  it('shows lapsed pending invitations as expired', () => {
    expect(effectiveStatus({ status: 'pending', expires_at: past })).toBe('expired');
    expect(effectiveStatus({ status: 'pending', expires_at: future })).toBe('pending');
    expect(effectiveStatus({ status: 'revoked', expires_at: future })).toBe('revoked');
  });
});

describe('TeamInvitations', () => {
  it('members without invite rights see guidance and no form, and nothing is fetched', () => {
    render(<TeamInvitations role="agent" organizationName="Acme" />);
    expect(screen.getByText(/Owners and administrators of Acme can invite colleagues/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create invitation' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists invitations with readable role and status labels', async () => {
    fetchMock.mockResolvedValueOnce(json({ invitations: INV }));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    expect(await screen.findByText('pending@example.com')).toBeTruthy();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Member')).toBeTruthy();
    expect(table.getByText('Expired')).toBeTruthy();
    expect(table.getByText('Accepted')).toBeTruthy();
    // Only the live pending invitation can be revoked.
    expect(screen.getAllByRole('button', { name: /Revoke invitation for/ })).toHaveLength(1);
  });

  it('shows an empty state', async () => {
    fetchMock.mockResolvedValueOnce(json({ invitations: [] }));
    render(<TeamInvitations role="admin" organizationName="Acme" />);
    expect(await screen.findByText(/No invitations yet/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
  });

  it('shows a load error with a retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)).mockResolvedValueOnce(json({ invitations: [] }));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No invitations yet/)).toBeTruthy();
  });

  it('rejects an invalid address without calling the API', async () => {
    fetchMock.mockResolvedValueOnce(json({ invitations: [] }));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    await screen.findByText(/No invitations yet/);
    await userEvent.type(screen.getByLabelText('E-mail address'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid e-mail address.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates an invitation with CSRF header and shows the one-time link', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ invitations: [] }))
      .mockResolvedValueOnce(json({ invitation: { invitation_id: INV[0].id, token: 'tok-123', email: 'new@example.com', role: 'manager', expires_at: future } }, 201))
      .mockResolvedValueOnce(json({ invitations: [INV[0]] }));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    await screen.findByText(/No invitations yet/);
    await userEvent.type(screen.getByLabelText('E-mail address'), ' new@example.com ');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'manager');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    const link = (await screen.findByLabelText('Invitation link')) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite#tok-123`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/v1/invitations');
    expect(init.method).toBe('POST');
    expect(init.headers['x-tugpt-csrf']).toBe('1');
    expect(JSON.parse(init.body)).toEqual({ email: 'new@example.com', role: 'manager' });
    expect(screen.getByText(/shown only once/)).toBeTruthy();
  });

  it('shows the server sentence for a duplicate invitation', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ invitations: [] }))
      .mockResolvedValueOnce(json({ error: { code: 'INVITATION_ALREADY_PENDING', message: 'This address already has a pending invitation. Revoke it before sending another.' } }, 409));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    await screen.findByText(/No invitations yet/);
    await userEvent.type(screen.getByLabelText('E-mail address'), 'dup@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has a pending invitation');
  });

  it('revokes only after confirmation', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ invitations: [INV[0]] }))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ invitations: [{ ...INV[0], status: 'revoked' }] }));
    render(<TeamInvitations role="owner" organizationName="Acme" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke invitation for pending@example.com' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`/api/v1/invitations/${INV[0].id}/revoke`);
    expect(init.body).toBe('{}');
    expect(await screen.findByText(/was revoked. The link no longer works/)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Revoked')).toBeTruthy());
  });
});
