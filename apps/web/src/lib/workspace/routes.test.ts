import { describe, expect, it } from 'vitest';
import { WORKSPACE_AGENTS, WORKSPACE_HOME, WORKSPACE_LIBRARY, isChatPath, isSectionPath, isThreadId, starterHref, threadHref, threadIdFromPath } from './routes';
import { WORKSPACE_SECTIONS } from './nav';

const id = '0b6f3a52-6f1e-4c55-9a7e-2d3c4b5a6f70';

describe('workspace routes', () => {
  it('builds and reads chat addresses', () => {
    expect(threadHref(id)).toBe(`/workspace/c/${id}`);
    expect(threadIdFromPath(`/workspace/c/${id}`)).toBe(id);
    expect(threadIdFromPath(`/workspace/c/${id.toUpperCase()}/`)).toBe(id);
  });
  it('treats anything that is not a UUID as "no chat"', () => {
    for (const p of ['/workspace', '/workspace/c/', '/workspace/c/t1', '/workspace/c/..%2f..', `/workspace/c/${id}/x`, `/dashboard/c/${id}`, null, undefined]) {
      expect(threadIdFromPath(p), String(p)).toBeNull();
    }
    expect(isThreadId('t1')).toBe(false);
  });
  it('knows the chat surface', () => {
    expect(isChatPath('/workspace')).toBe(true);
    expect(isChatPath(`/workspace/c/${id}`)).toBe(true);
    expect(isChatPath('/workspace/library')).toBe(false);
    expect(isChatPath('/dashboard')).toBe(false);
  });
  it('marks the current section', () => {
    expect(isSectionPath(`/workspace/c/${id}`, WORKSPACE_HOME)).toBe(true);
    expect(isSectionPath('/workspace/library', WORKSPACE_HOME)).toBe(false);
    expect(isSectionPath('/workspace/library/', WORKSPACE_LIBRARY)).toBe(true);
    expect(isSectionPath('/workspace/librarything', WORKSPACE_LIBRARY)).toBe(false);
    expect(isSectionPath('/workspace/agents', WORKSPACE_LIBRARY)).toBe(false);
    expect(isSectionPath(null, WORKSPACE_AGENTS)).toBe(false);
  });
  it('starter links carry only an encoded key', () => {
    expect(starterHref('email')).toBe('/workspace?prompt=email');
    expect(starterHref('a&b')).toBe('/workspace?prompt=a%26b');
  });
  it('every Workspace section lives under /workspace', () => {
    for (const s of WORKSPACE_SECTIONS) expect(s.href).toMatch(/^\/workspace(\/|$)/);
  });
});
