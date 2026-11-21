/** Shared helpers for /api/v1/create/images/*. */
import { NextResponse } from 'next/server';
import { ChatStoreError } from '@/lib/chat/store';
import { PRIVATE_HEADERS } from '@/lib/chat/request';
import { ImageServiceError, type GpuJob, type ImageServiceErrorCode } from './image-service';
import type { ImageGeneration, StatusPatch } from './store';

export function createError(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: PRIVATE_HEADERS });
}

const SERVICE_ERRORS: Readonly<Partial<Record<ImageServiceErrorCode, readonly [number, string]>>> = {
  NOT_CONFIGURED: [503, 'Image generation is not available on this workspace yet.'],
  UNAVAILABLE: [503, 'The image service is not reachable right now. Please try again in a minute.'],
  MODEL_NOT_READY: [503, 'The image model is still starting. Please try again in a minute.'],
  ORGANIZATION_BUSY: [429, 'Another image for your organization is still being generated. Try again when it finishes.'],
  QUEUE_FULL: [429, 'The image service is busy. Please try again shortly.'],
  STORAGE_LIMIT: [507, 'Image storage is full. An administrator needs to free up space.'],
  INVALID_REQUEST: [400, 'That request could not be processed. Check the prompt and size.'],
  NOT_FOUND: [404, 'That image no longer exists.'],
  RESULT_NOT_READY: [409, 'The image is not finished yet.'],
  RESULT_EXPIRED: [410, 'This image has expired and is no longer stored.'],
  CONFLICT: [409, 'That request conflicts with an existing image.'],
};

/** Map any failure to a safe response. Internal detail (status codes, tokens, URLs) never leaves the server. */
export function failure(e: unknown): NextResponse {
  if (e instanceof ImageServiceError) {
    const [status, message] = SERVICE_ERRORS[e.code] ?? [502, 'The image service returned an unexpected response.'];
    return createError(status, e.code, message);
  }
  if (e instanceof ChatStoreError) {
    if (e.code === 'FORBIDDEN') return createError(403, 'FORBIDDEN', 'Access denied.');
    if (e.code === 'NOT_FOUND') return createError(404, 'NOT_FOUND', 'Not found.');
  }
  return createError(503, 'UNAVAILABLE', 'Image history is not available right now.');
}

export function patchFromJob(job: GpuJob): StatusPatch {
  return { status: job.status, progress: job.status === 'completed' ? 100 : job.progress, errorCode: job.error, seconds: job.seconds };
}

export function changed(row: ImageGeneration, p: StatusPatch): boolean {
  return row.status !== p.status || row.progress !== p.progress || row.errorCode !== p.errorCode;
}

/** The browser shape: no organization or owner ids. */
export function publicImage(g: ImageGeneration) {
  return {
    // No model name (CONF-1): stored server-side only.
    id: g.id, prompt: g.prompt, width: g.width, height: g.height, seed: g.seed,
    status: g.status, progress: g.progress, errorCode: g.errorCode, seconds: g.seconds,
    createdAt: g.createdAt, finishedAt: g.finishedAt,
    fileUrl: g.status === 'completed' ? `/api/v1/create/images/${g.id}/file` : null,
  };
}
export type PublicImage = ReturnType<typeof publicImage>;

// Printable text plus newline/tab; no other control characters.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export function validPrompt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = v.trim();
  const length = [...p].length;
  return length >= 1 && length <= 1000 && !CONTROL.test(p) ? p : null;
}
