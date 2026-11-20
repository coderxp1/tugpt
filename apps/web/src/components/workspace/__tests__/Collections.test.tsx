// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Collection, LibraryDocument } from '@/lib/workspace-data/contracts';
import { Collections } from '../Collections';
import { fakeApi, iso } from './fake-api';

// UI contract tests isolate the upload coordinator, which has its own recovery/transport tests.
vi.mock('@/lib/workspace/file-upload', () => ({ uploadSafely: async (file: File, type: string, _scope: string, _signal: AbortSignal, _progress: unknown, api: { uploadFile: (blob: Blob, name: string, visibility: string) => Promise<{ ok: boolean; value?: { file: unknown } }> }, _storage: Storage, visibility: string) => {
  const r = await api.uploadFile(new Blob([file], { type }), file.name, visibility);
  return r.ok && r.value?.file ? { kind: 'stored', file: r.value.file } : { kind: 'uncertain' };
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const col: Collection = { id: 'c1', name: 'Shipping policies', description: 'Carriers, rates and SLAs', visibility: 'organization', ownedByMe: true, createdAt: iso(100), updatedAt: iso(10) };
const doc = (over: Partial<LibraryDocument>): LibraryDocument => ({ id: 'd1', collectionId: 'c1', fileId: 'f1', title: 'Rates 2026.docx', status: 'ready', errorCode: null, chunkCount: 12, indexedAt: iso(9), createdAt: iso(10), processingAttempts: 0, nextAttemptAt: null, ...over });

describe('Library collections', () => {
  it('says collections are unavailable when the Library API is not deployed', async () => {
    fakeApi({});
    render(<Collections uploadScope="test-owner" role="agent" />);
    expect(await screen.findByText('Collections: not available in this workspace yet.')).toBeTruthy();
  });

  it('offers to create the first collection, and creates it', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [] } }),
      'POST /api/v1/library/collections': ({ body }) => ({ status: 201, body: { collection: { ...col, ...(body as object), id: 'c9' } } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [] } }),
    });
    render(<Collections uploadScope="test-owner" role="admin" />);
    expect(await screen.findByText('No collections yet.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New collection' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'New collection' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'HR handbook' } });
    fireEvent.click(within(dialog).getByLabelText(/^Organization/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Collection “HR handbook” created.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'HR handbook', visibility: 'organization' });
  });

  it('opens a collection, shows indexing status honestly (PDF not indexed), and removes a document after confirming', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [doc({}), doc({ id: 'd2', title: 'Contract.pdf', status: 'unsupported', errorCode: 'PDF_EXTRACTION_UNAVAILABLE', chunkCount: 0, indexedAt: null })] } }),
      'DELETE /api/v1/library/collections/:id/documents/:doc': () => ({ body: { deleted: true } }),
    });
    render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Shipping policies$/ }));
    const table = await screen.findByRole('table', { name: 'Documents in Shipping policies' });
    expect(within(table).getByText('Ready')).toBeTruthy();
    expect(within(table).getByText('12 passages')).toBeTruthy();
    expect(within(table).getByText('Not indexed')).toBeTruthy();
    expect(within(table).getByText(/PDF text extraction is not available yet/)).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Options for Contract.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from collection' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('“Contract.pdf” removed.')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/library/collections/c1/documents/d2')).toBe(true);
  });

  it('uploads a document into the collection with its visibility, then adds it', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [] } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f7' } } }),
      'POST /api/v1/library/collections/:id/documents': () => ({ status: 201, body: { document: doc({ id: 'd7', fileId: 'f7', title: 'SLA.docx', status: 'pending', chunkCount: 0, indexedAt: null }) } }),
    });
    const { container } = render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Shipping policies$/ }));
    await screen.findByText('This collection has no documents yet.');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['PK'], 'SLA.docx')] } });
    expect(await screen.findByText('Queued')).toBeTruthy();
    expect(screen.getByText('File stored. Waiting for indexing; not searchable yet.')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText(/added. Indexing/)).toBeNull();
    const upload = api.calls.find((c) => c.path === '/api/v1/files');
    expect(upload?.search).toBe('?filename=SLA.docx&visibility=organization');
    expect(upload?.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(api.calls.find((c) => c.path.endsWith('/documents'))?.body).toEqual({ fileId: 'f7', title: 'SLA.docx' });
  });

  it('searches indexed text and shows the passage', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/search': () => ({ body: { hits: [{ chunkId: 'k1', documentId: 'd1', collectionId: 'c1', fileId: 'f1', title: 'Rates 2026.docx', ordinal: 3, snippet: 'Quito deliveries take two business days.', rank: 0.9 }] } }),
    });
    render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search collections' }), { target: { value: 'Quito' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Quito deliveries take two business days.')).toBeTruthy();
    expect(screen.getByText('Results for “Quito”: 1')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/library/search')?.search).toBe('?q=Quito&limit=20');
  });
  it('distinguishes stored files from an unconfirmed collection addition without retrying writes', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [] } }),
      'POST /api/v1/files': () => ({ status: 201, body: { file: { id: 'f7' } } }),
      'POST /api/v1/library/collections/:id/documents': () => ({ status: 403, body: { error: 'FORBIDDEN' } }),
    });
    const { container } = render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Shipping policies$/ }));
    await screen.findByText('This collection has no documents yet.');
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['rates'], 'rates.txt')] } });
    expect(await screen.findByText(/File stored, but adding it to this collection was not confirmed/)).toBeTruthy();
    expect(screen.queryByText('Queued')).toBeNull();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('does not add metadata after storage fails', async () => {
    const api = fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [] } }),
      'POST /api/v1/files': () => ({ status: 503, body: { error: 'STORAGE_UNAVAILABLE' } }),
    });
    const { container } = render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Shipping policies$/ }));
    await screen.findByText('This collection has no documents yet.');
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['rates'], 'rates.txt')] } });
    await screen.findByRole('button', { name: 'Remove rates.txt' });
    expect(screen.queryByText('Queued')).toBeNull();
    expect(screen.queryByText(/File stored/)).toBeNull();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('shows indexing and failed states without claiming search readiness', async () => {
    fakeApi({
      'GET /api/v1/library/collections': () => ({ body: { collections: [col] } }),
      'GET /api/v1/library/collections/:id': () => ({ body: { collection: col, documents: [doc({ status: 'indexing', chunkCount: 0, indexedAt: null }), doc({ id: 'd2', status: 'failed', errorCode: 'FILE_MISSING', chunkCount: 0, indexedAt: null })] } }),
    });
    render(<Collections uploadScope="test-owner" role="agent" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open\s*: Shipping policies$/ }));
    expect(await screen.findByText('Indexing in progress. Search will be available when ready.')).toBeTruthy();
    expect(screen.getByText('The stored file could not be found. Contact your workspace administrator before uploading again.')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
  });

});

it.each(['viewer', undefined, 'unknown'])('keeps %s read-only', async role => {
 fakeApi({'GET /api/v1/library/collections':()=>({body:{collections:[col]}}),'GET /api/v1/library/collections/:id':()=>({body:{collection:col,documents:[doc({})]}})});
 const {container}=render(<Collections role={role} uploadScope="test-owner" />);
 fireEvent.click(await screen.findByRole('button',{name:/^Open\s*: Shipping policies$/}));
 await screen.findByRole('table');expect(container.querySelector('input[type="file"]')).toBeNull();
 expect(screen.queryByRole('button',{name:'New collection'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Options for Rates 2026.docx'}));
 expect(screen.queryByRole('menuitem',{name:'Move document'})).toBeNull();
 expect(screen.queryByRole('menuitem',{name:'Remove from collection'})).toBeNull();
});
