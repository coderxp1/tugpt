// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsView } from '../AgentsView';
import { fakeApi } from './fake-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const models = [{ key: 'scout', label: 'TuGPT Scout', description: '', private: true, toolCalling: false }];

describe('Agent builder', () => {
  it('can be filled in while the Agents API is missing, but cannot save and says why', async () => {
    const api = fakeApi({});
    render(<AgentsView models={models} />);
    await screen.findByText('Custom agents: not available in this workspace yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent builder' }));
    const dialog = screen.getByRole('dialog', { name: 'New agent' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Shipping helper' } });
    expect((within(dialog).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Agents cannot be saved here yet.')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not infer write compatibility from an empty actual Agents API list', async () => {
    const api = fakeApi({ 'GET /api/v1/agents': () => ({ body: { agents: [] } }) });
    render(<AgentsView models={models} />);
    await screen.findByText('No custom agents are shown here. You can preview the builder, but saving is not connected yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent builder' }));
    const dialog = screen.getByRole('dialog', { name: 'New agent' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Shipping helper' } });
    fireEvent.change(within(dialog).getByLabelText(/^Instructions/), { target: { value: 'Answer shipping questions.' } });
    expect((within(dialog).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Its write adapter is not yet compatible/)).toBeTruthy();
    fireEvent.submit(dialog.querySelector('form')!);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('keeps an incompatible API response from crashing the Workspace or enabling saves', async () => {
    fakeApi({ 'GET /api/v1/agents': () => ({ body: { agents: [{ id: 'a1', name: 'New API agent', conversationStarters: [] }] } }) });
    render(<AgentsView models={models} />);
    await screen.findByText('Custom agents: not available in this workspace yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent builder' }));
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
  });

});

// Shape from Agent 4 Q-6 cb0c8e4: additive response fields must not unlock writes/runs.
describe('compatible C-1 responses do not enable unverified features', () => {
  it.each([true, false])('keeps saving/editing/deletion/execution off (ownedByMe=%s)', async (ownedByMe) => {
    const api = fakeApi({ 'GET /api/v1/agents': () => ({ body: { agents: [{
      id: 'a1', name: 'Shipping helper', description: 'Approved shipping advice',
      instructions: ownedByMe ? 'Use approved shipping policies.' : '', modelKey: null,
      starters: ['What are the rates?'], collectionIds: [], visibility: 'organization',
      ownedByMe, canEdit: ownedByMe, canDelete: ownedByMe, version: 3, tools: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] } }) });
    render(<AgentsView models={models} />);
    const heading = await screen.findByRole('heading', { name: 'Shipping helper' });
    const card = heading.closest('li')!;
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByRole('link')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Start a chat' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent builder' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'New helper' } });
    fireEvent.change(within(dialog).getByLabelText(/^Instructions/), { target: { value: 'Use policy.' } });
    expect((within(dialog).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(dialog.querySelector('form')!);
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(api.calls.some((c) => c.path.endsWith('/run') || c.path.endsWith('/messages'))).toBe(false);
  });
});
