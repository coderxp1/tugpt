// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import LogoutPage from './page';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
beforeEach(() => { mocks.fetch.mockReset(); mocks.replace.mockReset(); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('signs out only this Dashboard session after explicit confirmation', async () => {
  mocks.fetch.mockResolvedValue({ ok: true }); render(<LogoutPage />);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.getByText(/website session will remain signed in/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth/login?signed_out=1'));
  expect(mocks.fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', headers: { 'x-tugpt-csrf': '1', 'Content-Type': 'application/json' }, body: '{}', redirect: 'error' });
});
it('does not falsely report sign-out when revocation fails, and offers retry', async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true }); render(<LogoutPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be confirmed'));
  expect(mocks.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth/login?signed_out=1'));
});
it('handles a network exception without silently redirecting', async () => {
  mocks.fetch.mockRejectedValue(new Error('offline')); render(<LogoutPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be confirmed'));
  expect(mocks.replace).not.toHaveBeenCalled();
});
