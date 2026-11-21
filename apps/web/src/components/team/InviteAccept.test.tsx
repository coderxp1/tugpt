// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InviteAccept, PENDING_INVITE_KEY, takeInviteToken } from './InviteAccept';

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); sessionStorage.clear(); window.history.replaceState(null, '', '/invite'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('takeInviteToken', () => {
  it('moves the token out of the URL into this tab only', () => {
    window.history.replaceState(null, '', '/invite#abc%2Fdef');
    expect(takeInviteToken(window)).toBe('abc/def');
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBe('abc/def');
  });
  it('resumes from this tab after a sign-in round trip', () => {
    sessionStorage.setItem(PENDING_INVITE_KEY, 'kept');
    expect(takeInviteToken(window)).toBe('kept');
  });
  it('ignores oversized tokens', () => {
    window.history.replaceState(null, '', `/invite#${'x'.repeat(600)}`);
    expect(takeInviteToken(window)).toBeNull();
  });
});

describe('InviteAccept', () => {
  it('explains a missing invitation', async () => {
    render(<InviteAccept />);
    expect(await screen.findByRole('heading', { name: 'No invitation found' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins only on an explicit click and clears the stored token', async () => {
    window.history.replaceState(null, '', '/invite#tok-1');
    fetchMock.mockResolvedValueOnce(json({ membership: { organization_id: 'org-1', role: 'agent', membership_created: true } }));
    render(<InviteAccept />);
    const join = await screen.findByRole('button', { name: 'Join organization' });
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(join);
    expect(await screen.findByText('You joined the organization as Member.')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/invitations/accept');
    expect(init.headers['x-tugpt-csrf']).toBe('1');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok-1' });
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
  });

  it('guides the user when a fresh email confirmation is required and keeps the token', async () => {
    window.history.replaceState(null, '', '/invite#tok-2');
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'VERIFIED_EMAIL_REQUIRED', message: 'Fresh verified email evidence is required.' } }, 403));
    render(<InviteAccept />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join organization' }));
    expect((await screen.findByRole('alert')).textContent).toContain('fresh email confirmation');
    expect(screen.getByRole('link', { name: 'Sign out and sign in again' })).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBe('tok-2');
  });

  it('drops an expired invitation and offers no retry', async () => {
    window.history.replaceState(null, '', '/invite#tok-3');
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'INVITATION_EXPIRED', message: 'This invitation has expired. Ask for a new one.' } }, 410));
    render(<InviteAccept />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join organization' }));
    expect((await screen.findByRole('alert')).textContent).toContain('has expired');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
  });
});
