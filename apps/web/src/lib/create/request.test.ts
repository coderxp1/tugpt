import { describe, expect, it } from 'vitest';
import { PUBLIC_IMAGE_ERROR_CODES, publicImageErrorCode } from './request';

describe('publicImageErrorCode (IMAGES-NEUTRAL)', () => {
  it('maps infrastructure codes to neutral ones and keeps the neutral ones', () => {
    expect(publicImageErrorCode('GPU_INFERENCE_FAILED')).toBe('GENERATION_FAILED');
    expect(publicImageErrorCode('GPU_SHUTDOWN')).toBe('GENERATION_INTERRUPTED');
    expect(publicImageErrorCode('JOB_NOT_FOUND')).toBe('JOB_NOT_FOUND');
    expect(publicImageErrorCode('RESULT_EXPIRED')).toBe('RESULT_EXPIRED');
  });
  it('returns null for no error and collapses anything unknown to GENERATION_FAILED', () => {
    expect(publicImageErrorCode(null)).toBeNull();
    expect(publicImageErrorCode(undefined)).toBeNull();
    expect(publicImageErrorCode('')).toBeNull();
    for (const raw of ['CUDA_OOM', 'gpu_inference_failed', 'Traceback (most recent call last)', '__proto__', 'constructor', 'toString']) {
      expect(publicImageErrorCode(raw)).toBe('GENERATION_FAILED');
    }
  });
  it('only ever emits the documented closed set', () => {
    for (const raw of ['GPU_INFERENCE_FAILED', 'GPU_SHUTDOWN', 'JOB_NOT_FOUND', 'RESULT_EXPIRED', 'x']) {
      expect(PUBLIC_IMAGE_ERROR_CODES).toContain(publicImageErrorCode(raw));
    }
  });
});
