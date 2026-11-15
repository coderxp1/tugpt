// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageStudio, type StudioImage } from './ImageStudio';

const ID = '0b8f6f4e-2a43-4c1b-9d55-3f1f2a6b7c8d';
const img = (over: Partial<StudioImage> = {}): StudioImage => ({ id: ID, prompt: 'A red bicycle', width: 1024, height: 1024, seed: 7, model: 'Tongyi-MAI/Z-Image-Turbo', status: 'queued', progress: 0, errorCode: null, seconds: null, createdAt: '2026-11-15T10:00:00Z', finishedAt: null, fileUrl: null, ...over });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ImageStudio', () => {
  it('shows an honest unavailable state and disables generation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ service: { configured: true, available: false, model: null }, images: [] })));
    render(<ImageStudio />);
    expect(await screen.findByText('Temporarily unavailable')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Generate image' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No images yet')).toBeTruthy();
  });

  it('generates, shows progress, then the finished image', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/v1/create/images' && !init?.method) return json({ service: { configured: true, available: true, model: 'Tongyi-MAI/Z-Image-Turbo' }, images: [] });
      if (url === '/api/v1/create/images' && init?.method === 'POST') return json({ image: img() }, 202);
      polls += 1;
      return json({ image: polls < 2 ? img({ status: 'processing', progress: 60 }) : img({ status: 'completed', progress: 100, seconds: 1.9, fileUrl: `/api/v1/create/images/${ID}/file` }) });
    }));
    render(<ImageStudio />);
    const box = await screen.findByLabelText('Describe the image');
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'A red bicycle' } });
    fireEvent.click(screen.getByLabelText(/Landscape/));
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await screen.findByRole('progressbar');
    const sent = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({ prompt: 'A red bicycle', size: 'landscape' });
    expect((sent.init!.headers as Record<string, string>)['x-tugpt-csrf']).toBe('1');
    const image = await screen.findByAltText('A red bicycle', {}, { timeout: 5000 });
    expect(image.getAttribute('src')).toBe(`/api/v1/create/images/${ID}/file`);
    expect(screen.getByRole('link', { name: 'Download PNG' }).getAttribute('href')).toBe(`/api/v1/create/images/${ID}/file?download=1`);
    const full = screen.getByRole('link', { name: 'Open full size (opens in a new tab)' });
    expect(full.getAttribute('href')).toBe(`/api/v1/create/images/${ID}/file`);
    expect(full.getAttribute('rel')).toContain('noopener');
  });

  it('shows the server message when generation is refused', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => init?.method === 'POST'
      ? json({ error: 'ORGANIZATION_BUSY', message: 'Another image for your organization is still being generated. Try again when it finishes.' }, 429)
      : json({ service: { configured: true, available: true, model: 'm' }, images: [] })));
    render(<ImageStudio />);
    const box = await screen.findByLabelText('Describe the image');
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect((await screen.findByRole('alert')).textContent).toMatch(/still being generated/);
  });

  it('offers a retry when history cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    render(<ImageStudio />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
