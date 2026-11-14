// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SessionRenewal } from './SessionRenewal';
const state = vi.hoisted(() => ({ pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
const fetcher = vi.fn();
beforeEach(() => { state.pathname = '/dashboard'; fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows the accepted local expiry recovery notice on401', async () => {
  fetcher.mockResolvedValue({ status: 401 }); render(<SessionRenewal />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://tugpt.pro/login.html?dashboard=1');
  expect(fetcher).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' });
});
it('does not equate network failure or503 with confirmed expiry', async () => {
  fetcher.mockResolvedValue({ status: 503 }); render(<SessionRenewal />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled()); expect(screen.queryByRole('alert')).toBeNull();
});
it('does not poll or display the notice on authentication pages', () => {
  state.pathname = '/auth/login'; render(<SessionRenewal />); expect(fetcher).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
});
