// @vitest-environment jsdom
/**
 * The account screen, as a person verifying their identity sees it.
 *
 * The lib tests prove the normalization rules. These prove the surface: that
 * the canonical id is readable, that a linked provider cannot be linked twice,
 * that linking is an explicit click with the right provider and return path,
 * and that a refusal is shown rather than swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkedAccounts } from './LinkedAccounts';
import { normalizeIdentities } from '@/lib/auth/identities';
import { es } from '@/i18n/es';

const linkIdentity = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/browser', () => ({
  getBrowserClient: () => ({ auth: { linkIdentity } }),
}));

const USER_ID = '11111111-2222-3333-4444-555555555555';
const RETURN_TO = '/dashboard/settings/accounts';

const identitiesOf = (raw: Parameters<typeof normalizeIdentities>[0]) =>
  normalizeIdentities(raw);

const github = () => ({
  identity_id: 'id-github-1',
  provider: 'github',
  identity_data: { email: 'owner@example.com' },
  last_sign_in_at: '2026-11-11T09:00:00.000Z',
});

const google = () => ({
  identity_id: 'id-google-1',
  provider: 'google',
  identity_data: { email: 'owner@example.com' },
  last_sign_in_at: '2026-11-11T09:05:00.000Z',
});

const renderScreen = (raw: Parameters<typeof normalizeIdentities>[0]) =>
  render(
    <LinkedAccounts
      locale="es"
      canonicalUserId={USER_ID}
      email="owner@example.com"
      identities={identitiesOf(raw)}
      returnTo={RETURN_TO}
    />
  );

beforeEach(() => {
  linkIdentity.mockReset();
  linkIdentity.mockResolvedValue({ data: {}, error: null });
});

afterEach(cleanup);

describe('what the account screen shows', () => {
  it('T1: shows the canonical user id verbatim', () => {
    renderScreen([github()]);
    expect(screen.getByText(USER_ID)).toBeTruthy();
  });

  it('T2: names each linked provider and marks it linked', () => {
    renderScreen([github(), google()]);

    expect(screen.getByText(es['accounts.provider.github'])).toBeTruthy();
    expect(screen.getByText(es['accounts.provider.google'])).toBeTruthy();
    expect(screen.getAllByText(es['accounts.linked'])).toHaveLength(2);
  });

  it('T3: renders two identities that share an email as two rows', () => {
    // Same email, two providers, two rows — the screen must never imply a link
    // the auth schema does not contain.
    const { container } = renderScreen([github(), google()]);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('T4: says so when nothing is linked yet', () => {
    renderScreen([]);
    expect(screen.getByText(es['accounts.noneLinked'])).toBeTruthy();
  });

  it('T5: states that accounts are never merged by email', () => {
    renderScreen([github()]);
    expect(screen.getByText(es['accounts.noAutoMerge'])).toBeTruthy();
  });
});

describe('what it offers to link', () => {
  it('T6: offers Google when only GitHub is linked', () => {
    renderScreen([github()]);

    expect(
      screen.getByRole('button', {
        name: es['accounts.link'].replace('{provider}', es['accounts.provider.google']),
      })
    ).toBeTruthy();
  });

  it('T7: does not offer a provider that is already linked', () => {
    renderScreen([github(), google()]);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(es['accounts.linkHeading'])).toBeNull();
  });

  it('T8: offers both providers to an account with neither', () => {
    renderScreen([]);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

describe('linking', () => {
  it('T9: calls linkIdentity with the chosen provider and this page as the return path', async () => {
    const user = userEvent.setup();
    renderScreen([github()]);

    await user.click(
      screen.getByRole('button', {
        name: es['accounts.link'].replace('{provider}', es['accounts.provider.google']),
      })
    );

    await waitFor(() => expect(linkIdentity).toHaveBeenCalledTimes(1));
    const call = linkIdentity.mock.calls[0][0] as {
      provider: string;
      options: { redirectTo: string };
    };

    expect(call.provider).toBe('google');
    expect(call.options.redirectTo).toContain('/auth/callback');
    expect(call.options.redirectTo).toContain(encodeURIComponent(RETURN_TO));
  });

  it('T10: shows a refusal instead of pretending the link happened', async () => {
    const user = userEvent.setup();
    linkIdentity.mockResolvedValueOnce({ data: {}, error: { message: 'provider down' } });
    renderScreen([github()]);

    await user.click(
      screen.getByRole('button', {
        name: es['accounts.link'].replace('{provider}', es['accounts.provider.google']),
      })
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(es['accounts.linkFailed'])).toBeTruthy();
  });

  it('T11: shows a refusal when the call throws', async () => {
    const user = userEvent.setup();
    linkIdentity.mockRejectedValueOnce(new Error('offline'));
    renderScreen([github()]);

    await user.click(
      screen.getByRole('button', {
        name: es['accounts.link'].replace('{provider}', es['accounts.provider.google']),
      })
    );

    expect(await screen.findByText(es['accounts.linkFailed'])).toBeTruthy();
  });

  it('T12: does not offer unlink yet', async () => {
    // A half-built unlink is how a person locks themselves out of the only
    // identity their account has.
    renderScreen([github(), google()]);
    expect(screen.queryByRole('button', { name: /desvincular|unlink/i })).toBeNull();
  });
});
