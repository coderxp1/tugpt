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
it.each([['image','photo.png'],['pdf','manual.pdf'],['office','budget.xlsx'],['text','policy.txt']])('filters real API metadata by %s without claiming indexing',async(kind,name)=>{
 const files=[file,{...file,id:'f2',filename:'photo.png',mediaType:'image/png'},{...file,id:'f3',filename:'manual.pdf',mediaType:'application/pdf'},{...file,id:'f4',filename:'budget.xlsx',mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}];
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({files,nextCursor:null}))));render(<FileManager role="agent"/>);await screen.findByText('policy.txt');fireEvent.change(screen.getByLabelText('File type on this page'),{target:{value:kind}});expect(screen.getByText(name)).toBeTruthy();for(const f of files.filter(f=>f.filename!==name))expect(screen.queryByText(f.filename)).toBeNull();expect(screen.queryByText('Indexed')).toBeNull();
});
