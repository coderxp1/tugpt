// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrganizationSwitcher } from './OrganizationSwitcher';
const fetcher = vi.fn();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('does not discover or select organizations before an explicit gesture', () => {
  render(<OrganizationSwitcher label="Switch organization" />); expect(fetcher).not.toHaveBeenCalled();
});
it('loads current choices, marks the current one, then uses the protected JSON selection contract', async () => {
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ organizations: [{ organizationId: 'org-a', organizationName: 'Synthetic A', role: 'owner' }, { organizationId: 'org-b', organizationName: 'Synthetic B', role: 'agent' }] }) }).mockResolvedValueOnce({ ok: false });
  render(<OrganizationSwitcher label="Show my organizations" currentId="org-a" />); fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByText('Current')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Switch to Synthetic A' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Synthetic B' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]).toEqual(['/api/v1/organizations/active', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' }, body: '{"organizationId":"org-b"}' }]);
  expect((await screen.findByRole('alert')).textContent).toMatch(/still in the same organization/);
});
it('does not fabricate choices after a discovery failure', async () => {
  fetcher.mockRejectedValue(new Error('offline')); render(<OrganizationSwitcher label="Switch organization" />); fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(screen.queryByRole('list', { name: 'Your organizations' })).toBeNull();
});
