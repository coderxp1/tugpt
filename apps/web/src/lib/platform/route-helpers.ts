import { NextResponse } from 'next/server';
import type { ApiError } from '@/lib/draft-api/types';
import { PlatformRepoError } from './platform-repo';

export function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export function platformErrorResponse(error: unknown) {
  if (error instanceof PlatformRepoError) {
    if (error.code === 'P0002') return errorResponse(404, 'NOT_FOUND', error.message);
    if (error.code === 'PT409' || error.code === 'SNAPSHOT_NOT_APPROVED') return errorResponse(409, error.code, error.message);
    if (error.code === 'UNKNOWN_TOOL') return errorResponse(400, 'UNKNOWN_TOOL', error.message);
    if (error.code === 'NOT_CONFIGURED') return errorResponse(503, 'NOT_CONFIGURED', error.message);
    if (error.code === '23514' || error.code === '23505') return errorResponse(400, 'INVALID_REQUEST', error.message);
  }
  return errorResponse(500, 'INTERNAL', 'Something went wrong');
}
