// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceFile } from '@/lib/workspace-data/contracts';
import { FilePreview, previewKind } from './FilePreview';
const file = { id: 'f1', filename: 'policy.txt', mediaType: 'text/plain', sizeBytes: 30 } as WorkspaceFile;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['image/png','image/jpeg','image/webp','image/gif'])('allows bounded raster %s', mediaType => {
 expect(previewKind({ mediaType, sizeBytes: 100 })).toBe('image');
 expect(previewKind({ mediaType, sizeBytes: 9 * 1024 * 1024 })).toBeNull();
});
it.each(['image/svg+xml','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])('does not embed %s', mediaType => {
 expect(previewKind({ mediaType, sizeBytes: 100 })).toBeNull();
});
it('escapes text rather than executing markup', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>alert(1)</script>')));
 const { container } = render(<FilePreview file={file} url="/api/v1/files/f1/content" />);
 await screen.findByText('<script>alert(1)</script>'); expect(container.querySelector('script')).toBeNull();
});
it('retries only the authenticated read after failure', async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('Recovered preview'));
 vi.stubGlobal('fetch', fetcher);
 render(<FilePreview file={file} url="/api/v1/files/f1/content" />);
 fireEvent.click(await screen.findByRole('button', { name: 'Retry preview' }));
 await screen.findByText('Recovered preview'); expect(fetcher).toHaveBeenCalledTimes(2);
 for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
});
it('rejects oversized content without trusting file metadata', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))));
 render(<FilePreview file={file} url="/api/v1/files/f1/content" />);
 await screen.findByRole('alert'); expect(screen.queryByRole('img')).toBeNull();
});
it('revokes object URLs and aborts when closed', async () => {
 const create = vi.fn(() => 'blob:preview'); const revoke = vi.fn();
 vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
 const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))); vi.stubGlobal('fetch', fetcher);
 const { unmount } = render(<FilePreview file={{ ...file, mediaType: 'image/png' }} url="/api/v1/files/f1/content" />);
 await screen.findByRole('img'); unmount(); expect(revoke).toHaveBeenCalledWith('blob:preview');
});
