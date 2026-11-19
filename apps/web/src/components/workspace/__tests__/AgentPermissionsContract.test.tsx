// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomAgent } from '@/lib/workspace-data/contracts';
vi.mock('@/lib/workspace/agents', async (load) => ({ ...await load<object>(), agentsApiAvailable: true }));
import { AgentsView } from '../AgentsView';
import { fakeApi } from './fake-api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agent: CustomAgent = { id: 'a', name: 'Research', description: null, instructions: 'Research carefully', starters: ['Start'], collectionIds: [], modelKey: null, visibility: 'organization', ownedByMe: true, canEdit: true, canDelete: true, version: 1, tools: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' };
function setup(role: string, value = agent) {
  const api = fakeApi({
    'GET /api/v1/agents': () => ({ body: { agents: [value] } }),
    'GET /api/v1/library/collections': () => ({ body: { collections: [] } }),
    'PATCH /api/v1/agents/a': ({ body }) => ({ body: { agent: { ...value, ...body as object } } }),
    'POST /api/v1/agents': ({ body }) => ({ status: 201, body: { agent: { ...value, ...body as object, id: 'new-agent' } } }),
    'DELETE /api/v1/agents/a': () => ({ body: { deleted: true } }),
  });
  render(<AgentsView role={role} />); return api;
}
it.each(['owner', 'admin', 'member'])('owner resource is editable by writer role %s and PATCH contains only editable fields', async (role) => {
  const api = setup(role);
  fireEvent.click(await screen.findByRole('button', { name: 'Options for agent Research' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
  expect(Object.keys(api.calls.find((c) => c.method === 'PATCH')!.body as object).sort()).toEqual(['collectionIds', 'description', 'instructions', 'modelKey', 'name', 'starters', 'visibility']);
});
it('viewer cannot create or edit even if the resource permission is true', async () => {
  const api = setup('viewer'); await screen.findByText('Research');
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Options for agent Research' })).toBeNull();
  expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
});
it('admin can delete but cannot edit a nonowned organization resource', async () => {
  const api = setup('admin', { ...agent, ownedByMe: false, canEdit: false });
  fireEvent.click(await screen.findByRole('button', { name: 'Options for agent Research' }));
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
  await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true));
});
it('does not expose mutations when server denies both resource permissions', async () => {
  setup('owner', { ...agent, canEdit: false, canDelete: false }); await screen.findByText('Research');
  expect(screen.queryByRole('button', { name: 'Options for agent Research' })).toBeNull();
});
it('creates through 201 with starters and inline collectionIds', async () => {
  const api = setup('member'); await screen.findByText('Research');
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'New helper' } });
  fireEvent.change(within(dialog).getByLabelText(/^Instructions/), { target: { value: 'Be helpful.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
  await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
  expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: 'New helper', starters: [], collectionIds: [], visibility: 'private' });
});
