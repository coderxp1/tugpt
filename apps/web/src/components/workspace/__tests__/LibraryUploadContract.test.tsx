// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Collection, LibraryDocument } from '@/lib/workspace-data/contracts';
import { Collections } from '../Collections';
import { fakeApi, iso } from './fake-api';

// UI contract tests isolate the upload coordinator, which has its own recovery/transport tests.
vi.mock('@/lib/workspace/file-upload', () => ({ uploadSafely: async (file: File, type: string, _scope: string, _signal: AbortSignal, _progress: unknown, api: { uploadFile: (blob: Blob, name: string, visibility: string) => Promise<{ ok: boolean; value?: { file: unknown } }> }, _storage: Storage, visibility: string) => {
  const r = await api.uploadFile(new Blob([file], { type }), file.name, visibility);
  return r.ok && r.value?.file ? { kind: 'stored', file: r.value.file } : { kind: 'uncertain' };
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const col: Collection = { id: 'c1', name: 'Policies', description: null, visibility: 'private', ownedByMe: true, createdAt: iso(), updatedAt: iso() };
const document = (status: LibraryDocument['status'] = 'pending'): LibraryDocument => ({
  id: 'd1', collectionId: 'c1', fileId: 'f1', title: 'canonical.txt', status,
  errorCode: status === 'failed' ? 'FILE_MISSING' : null, chunkCount: status === 'ready' ? 2 : 0,
  indexedAt: status === 'ready' ? iso() : null, createdAt: iso(), processingAttempts: 0, nextAttemptAt: null,
});
async function open() {
  const { container } = render(<Collections uploadScope="test-owner" role="agent" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Policies$/ }));
  // Loading must settle before a mutation can update the collection state.
  await screen.findByRole('heading', { name: 'Policies' });
  return container.querySelector('input[type="file"]')!;
}
const select = (input: Element, filename = 'upload.txt') => fireEvent.change(input, { target: { files: [new File(['same bytes'], filename, { type: 'text/plain' })] } });

describe('Library upload response contract (mock HTTP, not backend deduplication acceptance)', () => {
  it('accepts 202 pending, keeps it unsearchable, then reconciles Ready on refresh without another write', async () => {
    let documents: LibraryDocument[] = [];
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f1' } } }),
      'POST /api/v1/library/collections/:id/documents': () => {
        documents = [document()]; return { status: 202, body: { document: documents[0], created: true } };
      },
    });
    const input = await open();
    await screen.findByText('This collection has no documents yet.');
    select(input);
    expect(await screen.findByText('Queued')).toBeTruthy();
    expect(screen.getByText('File stored. Waiting for indexing; not searchable yet.')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText('“canonical.txt” added.')).toBeTruthy();
    documents = [document('ready')];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('2 passages')).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(api.calls.find((c) => c.path.endsWith('/documents'))?.body).toEqual({ fileId: 'f1', title: 'upload.txt' });
  });

  it.each(['pending', 'ready', 'failed'] as const)('uses the canonical document on 200 created:false (%s), replacing rather than duplicating its ID', async (status) => {
    const canonical = document(status);
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [{ ...canonical, title: 'previous-title.txt' }] } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'new-file-id' } } }),
      'POST /api/v1/library/collections/:id/documents': () => ({ status: 200, body: { document: canonical, created: false } }),
    });
    const input = await open();
    await screen.findByText('previous-title.txt');
    select(input, 'renamed-upload.txt');
    expect(await screen.findByText('“canonical.txt” is already in this collection. The existing document was reused.')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('canonical.txt')).toBeTruthy();
    expect(within(table).queryByText('previous-title.txt')).toBeNull();
    expect(within(table).queryByText('renamed-upload.txt')).toBeNull();
    expect(within(table).getByText(status === 'pending' ? 'Queued' : status === 'ready' ? 'Ready' : 'Failed')).toBeTruthy();
    expect(screen.queryByText('“renamed-upload.txt” added.')).toBeNull();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(api.calls.find((c) => c.path.endsWith('/documents'))?.body).toEqual({ fileId: 'new-file-id', title: 'renamed-upload.txt' });
  });

  it('recovers a committed document after a lost response using Refresh, without automatic replay', async () => {
    let documents: LibraryDocument[] = [];
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f1' } } }),
      'POST /api/v1/library/collections/:id/documents': () => {
        documents = [document()];
        throw new TypeError('Simulated response lost after server commit');
      },
    });
    const input = await open();
    await screen.findByText('This collection has no documents yet.');
    select(input);
    expect(await screen.findByText(/File stored, but adding it to this collection was not confirmed/)).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText('“canonical.txt” added.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Queued')).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/library/collections/c1')).toHaveLength(2);
  });

  it.each([202, 200])('polls a pending document after HTTP %s, then stops at Ready', async (status) => {
    let documents: LibraryDocument[] = [];
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f1' } } }),
      'POST /api/v1/library/collections/:id/documents': () => {
        documents = [document()]; return { status, body: { document: documents[0], created: status === 202 } };
      },
    });
    const input = await open();
    await screen.findByText('This collection has no documents yet.');
    vi.useFakeTimers();
    await act(async () => { select(input); });
    expect(screen.getByText('Queued')).toBeTruthy();
    documents = [document('ready')];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('Ready')).toBeTruthy();
    const reads = () => api.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/library/collections/c1').length;
    expect(reads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(reads()).toBe(2);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('does not interpret created:false without a document as a successful registration', async () => {
    fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [] } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f1' } } }),
      'POST /api/v1/library/collections/:id/documents': () => ({ status: 200, body: { created: false } }),
    });
    const input = await open();
    await screen.findByText('This collection has no documents yet.');
    select(input);
    expect(await screen.findByText(/File stored, but adding it to this collection was not confirmed/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
