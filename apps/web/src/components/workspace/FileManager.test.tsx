// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FileManager } from './FileManager';
import { setWorkspaceApi } from '@/lib/workspace/service';
const file = { id: 'f1', filename: 'policy.txt', mediaType: 'text/plain', sizeBytes: 30, visibility: 'private', status: 'ready', ownedByMe: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setWorkspaceApi(null); });
function setup(role: string, own = true) {
 const calls: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
   calls.push(`${init?.method ?? 'GET'} ${url}`);
   return new Response(JSON.stringify(init?.method === 'DELETE' ? { deleted: true } : { files: [{ ...file, ownedByMe: own }], nextCursor: null }));
 }));
 render(<FileManager role={role} />); return calls;
}
it.each(['owner','admin','manager','agent'])('offers private owner actions to %s', async role => {
 setup(role); await screen.findByText('policy.txt');
 expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
 expect(screen.getByLabelText('Upload private file')).toBeTruthy();
});
it('keeps viewer controls read-only', async () => {
 setup('viewer'); await screen.findByText('policy.txt');
 expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
 expect(screen.queryByLabelText('Upload private file')).toBeNull();
 expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
});
it('does not offer mutations on another user private file', async () => {
 setup('admin', false); await screen.findByText('policy.txt');
 expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
 expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});
it('requires explicit deletion confirmation', async () => {
 const calls=setup('agent'); await screen.findByText('policy.txt');
 fireEvent.click(screen.getByRole('button',{name:'Delete'}));
 const d=screen.getByRole('alertdialog'); expect(calls.some(c=>c.startsWith('DELETE'))).toBe(false);
 fireEvent.click(within(d).getByRole('button',{name:'Delete'}));
 await screen.findByText('File deleted.'); expect(calls.filter(c=>c.startsWith('DELETE'))).toHaveLength(1);
});
