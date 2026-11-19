import { describe, expect, it } from 'vitest';
import { hasArray, messageKeyFor, problemOf } from './service';

describe('Workspace service: what a failed call means', () => {
  it('a route that is not deployed (HTML 404) or a store that is not configured is unavailable', () => {
    expect(problemOf({ status: 404, error: 'UNEXPECTED_RESPONSE' })).toBe('unavailable');
    expect(problemOf({ status: 405, error: 'UNEXPECTED_RESPONSE' })).toBe('unavailable');
    expect(problemOf({ status: 503, error: 'STORAGE_NOT_CONFIGURED' })).toBe('unavailable');
    expect(problemOf({ status: 503, error: 'STORE_UNAVAILABLE' })).toBe('unavailable');
  });
  it('a real 404 from the API is "not found", not "unavailable"', () => {
    expect(problemOf({ status: 404, error: 'NOT_FOUND' })).toBe('notFound');
  });
  it('classifies session, permission, network and other failures', () => {
    expect(problemOf({ status: 401, error: 'UNAUTHENTICATED' })).toBe('signedOut');
    expect(problemOf({ status: 403, error: 'FORBIDDEN' })).toBe('forbidden');
    expect(problemOf({ status: 0, error: 'NETWORK_ERROR' })).toBe('network');
    expect(problemOf({ status: 500, error: 'UNEXPECTED_RESPONSE' })).toBe('failed');
    expect(problemOf({ status: 409, error: 'ALREADY_DECIDED' })).toBe('failed');
  });
  it('maps codes to human sentences and never to the raw code', () => {
    expect(messageKeyFor({ status: 413, error: 'PAYLOAD_TOO_LARGE' })).toBe('workspace.err.tooLarge');
    expect(messageKeyFor({ status: 409, error: 'ALREADY_DECIDED' })).toBe('workspace.err.decided');
    expect(messageKeyFor({ status: 503, error: 'STORAGE_NOT_CONFIGURED' })).toBe('workspace.err.storage');
    expect(messageKeyFor({ status: 404, error: 'UNEXPECTED_RESPONSE' })).toBe('workspace.err.unavailable');
    expect(messageKeyFor({ status: 401, error: 'UNAUTHENTICATED' })).toBe('workspace.err.signedOut');
    expect(messageKeyFor({ status: 403, error: 'INVALID_ORIGIN' })).toBe('workspace.err.forbidden');
    expect(messageKeyFor({ status: 500, error: 'UNEXPECTED_RESPONSE' })).toBe('workspace.err.generic');
  });
  it('checks a response has the contract shape before it is trusted', () => {
    expect(hasArray({ folders: [] }, 'folders')).toBe(true);
    expect(hasArray({ threads: [] }, 'folders')).toBe(false);
    expect(hasArray(null, 'folders')).toBe(false);
    expect(hasArray({ folders: 'x' }, 'folders')).toBe(false);
  });
});
