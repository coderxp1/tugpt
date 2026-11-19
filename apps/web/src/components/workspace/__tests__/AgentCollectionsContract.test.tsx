// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CustomAgent, Collection } from '@/lib/workspace-data/contracts';
vi.mock('@/lib/workspace/agents', async (load) => ({ ...await load<object>(), agentsApiAvailable: true }));
import { AgentCollectionsDialog } from '../AgentCollectionsDialog';
import { fakeApi } from './fake-api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agent: CustomAgent = { id: 'a', name: 'Research', description: null, instructions: 'Research', starters: [], collectionIds: [], modelKey: null, visibility: 'private', ownedByMe: true, canEdit: true, canDelete: true, version: 1, tools: [], createdAt: '', updatedAt: '' };
const col: Collection = { id: 'c', name: 'Knowledge', description: null, visibility: 'private', ownedByMe: true, createdAt: '', updatedAt: '' };
function setup(status: number, error?: string, linked = false, resource = agent) {
  const api = fakeApi({
    'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
    'GET /api/v1/agents/a/collections': () => ({ body: { collections: linked ? [col] : [] } }),
    'POST /api/v1/agents/a/collections': () => ({ status, body: error ? { error } : { linked: true } }),
    'DELETE /api/v1/agents/a/collections/c': () => ({ status, body: error ? { error } : { deleted: true } }),
  });
  render(<AgentCollectionsDialog agent={resource} onClose={() => {}} onChanged={() => {}} />);
  return api;
}
it.each([201, 200])('accepts link success %s without duplicate replay', async (status) => {
  const api = setup(status);
  const box = await screen.findByRole('checkbox', { name: 'Knowledge' });
  fireEvent.click(box);
  await screen.findByText('Collection linked.');
  expect((box as HTMLInputElement).checked).toBe(true);
  expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ collectionId: 'c' });
});
it('accepts unlink 200 and changes the checked state only after confirmation', async () => {
  const api = setup(200, undefined, true);
  const box = await screen.findByRole('checkbox', { name: 'Knowledge' }); fireEvent.click(box);
  await screen.findByText('Collection unlinked.');
  expect((box as HTMLInputElement).checked).toBe(false);
  expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});
it.each([[403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [400, 'LIMIT_EXCEEDED']] as const)('preserves state after %s %s', async (status, error) => {
  const api = setup(status, error, true);
  const box = await screen.findByRole('checkbox', { name: 'Knowledge' }); fireEvent.click(box);
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
  expect((box as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText('Collection unlinked.')).toBeNull();
  expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});
it('fails closed when the owner cannot edit', async () => {
  const api = setup(201, undefined, false, { ...agent, canEdit: false });
  const box = await screen.findByRole('checkbox', { name: 'Knowledge' }); fireEvent.click(box);
  expect((box as HTMLInputElement).disabled).toBe(true);
  expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
});
