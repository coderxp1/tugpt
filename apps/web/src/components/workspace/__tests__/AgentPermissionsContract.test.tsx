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
it.each(['owner', 'admin', 'manager', 'agent'])('owner resource is editable by writer role %s and PATCH contains only editable fields', async (role) => {
  const api = setup(role, { ...agent, visibility: 'private' });
  fireEvent.click(await screen.findByRole('button', { name: 'Options for agent Research' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
  expect(Object.keys(api.calls.find((c) => c.method === 'PATCH')!.body as object).sort()).toEqual(['collectionIds', 'description', 'instructions', 'modelKey', 'name', 'starters', 'visibility']);
});
it.each(['viewer', 'member', 'unknown', ''])('%s cannot create or edit even if the resource permission is true', async (role) => {
  const api = setup(role); await screen.findByText('Research');
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Options for agent Research' })).toBeNull();
  expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
});
it.each(['owner', 'admin'])('%s can moderate deletion but cannot edit a nonowned organization resource', async (role) => {
  const api = setup(role, { ...agent, ownedByMe: false, canEdit: false });
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
it.each(['owner', 'admin', 'manager', 'agent'])('%s creates privately through 201 with starters and inline collectionIds', async (role) => {
  const api = setup(role); await screen.findByText('Research');
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'New helper' } });
  fireEvent.change(within(dialog).getByLabelText(/^Instructions/), { target: { value: 'Be helpful.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
  await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
  expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: 'New helper', starters: [], collectionIds: [], visibility: 'private' });
});

it.each(['owner', 'admin', 'manager', 'agent'])('%s cannot edit or link knowledge for another owner even with an inconsistent edit flag', async (role) => {
  const api = setup(role, { ...agent, ownedByMe: false, canEdit: true, canDelete: false });
  await screen.findByText('Research');
  expect(screen.queryByRole('button', { name: 'Options for agent Research' })).toBeNull();
  expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
});
it.each(['manager', 'agent'])('%s cannot moderate another user agent', async (role) => {
  setup(role, { ...agent, ownedByMe: false, canEdit: false, canDelete: false });
  await screen.findByText('Research');
  expect(screen.queryByRole('button', { name: 'Options for agent Research' })).toBeNull();
});
it.each(['owner', 'admin', 'manager', 'agent'])('%s receives only its allowed visibility choice', async (role) => {
  setup(role); await screen.findByText('Research');
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
  const radios = within(screen.getByRole('dialog')).getAllByRole('radio') as HTMLInputElement[];
  expect(radios[0].disabled).toBe(false);
  expect(radios[1].disabled).toBe(role === 'manager' || role === 'agent');
});

it.each(['manager', 'agent'])('F-4: %s sees deletion but no edit/knowledge controls for its organization agent', async (role) => {
  setup(role, { ...agent, ownedByMe: true, canEdit: false, canDelete: true, instructions: '' });
  fireEvent.click(await screen.findByRole('button', { name: 'Options for agent Research' }));
  const menu = screen.getByRole('menu');
  expect(within(menu).queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
  expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
});


it('does not describe an enabled, empty catalogue as a disconnected preview', async () => {
  fakeApi({ 'GET /api/v1/agents': () => ({ body: { agents: [] } }) });
  render(<AgentsView role="owner" />);
  await screen.findByText('No custom agents are shown here.');
  expect(screen.queryByText(/Custom-agent actions are disabled/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(false);
});
it('blocks saving an unavailable saved capability without exposing its internal name', async () => {
 const api=setup('agent',{...agent,visibility:'private',modelKey:'internal-provider-secret-name'});
 fireEvent.click(await screen.findByRole('button',{name:'Options for agent Research'}));fireEvent.click(screen.getByRole('menuitem',{name:'Edit'}));
 const d=screen.getByRole('dialog');expect((within(d).getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled).toBe(true);
 expect(d.textContent).not.toContain('internal-provider-secret-name');fireEvent.submit(d.querySelector('form')!);expect(api.calls.some(c=>c.method==='PATCH')).toBe(false);
});
it('does not duplicate agent saves on repeated form submission', async () => {
 const api=setup('agent',{...agent,visibility:'private'});fireEvent.click(await screen.findByRole('button',{name:'Options for agent Research'}));fireEvent.click(screen.getByRole('menuitem',{name:'Edit'}));
 const form=screen.getByRole('dialog').querySelector('form')!;fireEvent.submit(form);fireEvent.submit(form);
 await waitFor(()=>expect(api.calls.filter(c=>c.method==='PATCH')).toHaveLength(1));
});
