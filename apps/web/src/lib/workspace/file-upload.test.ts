// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceClient, WorkspaceFile } from '@/lib/workspace-data/contracts';
import { uploadSafely } from './file-upload';
const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const saved = { id: 'one', filename: file.name, sizeBytes: file.size, mediaType: file.type, sha256, visibility: 'private', ownedByMe: true, status: 'ready' } as WorkspaceFile;
const values = new Map<string, string>();
const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } } as Storage;
function setup(files: WorkspaceFile[] = [], status = 201, network = false) {
 const send = vi.fn(); const headers: Record<string, string> = {};
 class XHR {
  upload = { onprogress: null as null | ((e: unknown) => void) }; status = status; responseText = JSON.stringify({ file: saved }); onload?: () => void; onerror?: () => void;
  open = vi.fn(); setRequestHeader(k: string, v: string) { headers[k] = v; }
  send() { send(); this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 }); if (network) this.onerror?.(); else this.onload?.(); }
  abort() {}
 }
 vi.stubGlobal('XMLHttpRequest', XHR); vi.stubGlobal('navigator', { locks: { request: (_k: string, _o: unknown, fn: (lock: unknown) => unknown) => fn({}) } });
 const api = { listFiles: vi.fn(async () => ({ ok: true, value: { files, nextCursor: null } })) } as unknown as WorkspaceClient;
 return { api, send, headers };
}
afterEach(() => { values.clear(); vi.unstubAllGlobals(); });
const run = (api: WorkspaceClient, progress = vi.fn()) => uploadSafely(file, file.type, 'org:user', new AbortController().signal, progress, api, storage);
it('reports progress and preserves mutation CSRF header', async () => {
 const { api, send, headers } = setup(); const progress = vi.fn(); expect((await run(api, progress)).kind).toBe('stored'); expect(send).toHaveBeenCalledTimes(1); expect(progress).toHaveBeenCalledWith(100); expect(headers['x-tugpt-csrf']).toBe('1'); expect(values.size).toBe(0);
});
it('reuses an exact owned private match without a POST', async () => { const {api,send}=setup([saved]);expect((await run(api)).kind).toBe('existing');expect(send).not.toHaveBeenCalled(); });
it('retains ambiguous markers and never resends an unmatched uncertain upload', async () => { const {api,send}=setup([],201,true);expect((await run(api)).kind).toBe('uncertain');expect((await run(api)).kind).toBe('uncertain');expect(send).toHaveBeenCalledTimes(1); });
it('reconciles an ambiguous upload when the saved file appears', async () => { const {api}=setup([],201,true);await run(api);const next=setup([saved]);expect((await run(next.api)).kind).toBe('existing');expect(next.send).not.toHaveBeenCalled();expect(values.size).toBe(0); });
it('permits an explicit retry only after definitive rejection', async () => { const {api,send}=setup([],413);expect((await run(api)).kind).toBe('failed');expect(values.size).toBe(0);await run(api);expect(send).toHaveBeenCalledTimes(2); });
it('fails closed if the owned-file list cannot be checked', async () => { const {api,send}=setup();vi.mocked(api.listFiles).mockResolvedValue({ok:false,status:503,error:'NETWORK_ERROR'});expect((await run(api)).kind).toBe('unavailable');expect(send).not.toHaveBeenCalled(); });
it('follows pagination before considering a new upload', async () => { const {api,send}=setup();vi.mocked(api.listFiles).mockResolvedValueOnce({ok:true,value:{files:[],nextCursor:'next'}}).mockResolvedValueOnce({ok:true,value:{files:[saved],nextCursor:null}});expect((await run(api)).kind).toBe('existing');expect(send).not.toHaveBeenCalled(); });
it('does not trust another owner or visibility as a duplicate', async () => { const {api,send}=setup([{...saved,ownedByMe:false}]);expect((await run(api)).kind).toBe('stored');expect(send).toHaveBeenCalledTimes(1); });
it('does not send after cancellation during preflight', async () => { const {api,send}=setup();const controller=new AbortController();controller.abort();expect((await uploadSafely(file,file.type,'org:user',controller.signal,vi.fn(),api,storage)).kind).toBe('uncertain');expect(send).not.toHaveBeenCalled(); });
