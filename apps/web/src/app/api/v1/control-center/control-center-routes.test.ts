// Control Center API routes — the health endpoint reports real local
// state (never secret values), and the lab endpoint runs labs or
// returns honest errors for unknown tests and bad bodies.

import { afterEach, describe, expect, it } from 'vitest';
import { GET as healthGET } from './health/route';
import { POST as labPOST } from './lab/route';

function post(body: unknown): Request {
  return new Request('http://localhost/api/v1/control-center/lab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('control-center health route', () => {
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const savedToken = process.env.CONTROL_CENTER_TOKEN;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = savedKey;
    if (savedToken === undefined) delete process.env.CONTROL_CENTER_TOKEN;
    else process.env.CONTROL_CENTER_TOKEN = savedToken;
  });

  it('reports the kill switch OFF and env presence as booleans', async () => {
    const res = await healthGET();
    const json = (await res.json()) as {
      whatsappKillSwitch: string;
      envPresence: Record<string, unknown>;
      catalogTotal: number;
    };
    expect(json.whatsappKillSwitch).toBe('OFF');
    expect(json.catalogTotal).toBeGreaterThan(0);
    for (const value of Object.values(json.envPresence)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('reports runtime and access mode, never the token itself, and is not cacheable', async () => {
    process.env.CONTROL_CENTER_TOKEN = 'a-perfectly-long-operator-token-value';
    const res = await healthGET();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('a-perfectly-long-operator-token-value');
    const json = JSON.parse(text) as {
      runtime: { nodeVersion: string; build: { sha: string | null } };
      access: { mode: string; tokenConfigured: boolean; weakToken: boolean };
    };
    expect(json.runtime.nodeVersion).toBe(process.version);
    expect(json.access).toEqual({ mode: 'token', tokenConfigured: true, weakToken: false });
    // No literal commit baked into the source: the build is whatever the
    // deploy exported, or null.
    expect(json.runtime.build.sha).toBe(process.env.TUGPT_GIT_SHA ?? null);
  });

  it('reports the database as not configured when no Supabase project is set, without probing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await healthGET();
    const json = (await res.json()) as {
      database: { configured: boolean; reachable: boolean | null; available: boolean; host: string | null };
      workers: { available: boolean; observable: boolean };
    };
    expect(json.database).toMatchObject({ configured: false, reachable: null, available: false, host: null });
    expect(json.workers).toMatchObject({ available: false, observable: false });
  });
});

describe('control-center lab route', () => {
  it('runs the FAQ lab and returns its real selection', async () => {
    const res = await labPOST(post({ test: 'faq-retrieval', input: { question: '¿Cuál es el horario?' } }));
    const json = (await res.json()) as {
      mode: string;
      output: { selected: unknown[] };
    };
    expect(json.mode).toBe('real-in-process');
    expect(json.output.selected.length).toBeGreaterThan(0);
  });

  it('returns an honest blocked result for transcription', async () => {
    const res = await labPOST(post({ test: 'voice-transcription', input: {} }));
    const json = (await res.json()) as { mode: string; summary: string };
    expect(json.mode).toBe('blocked');
    expect(json.summary).toContain('Gladia');
  });

  it('rejects unknown tests with 400', async () => {
    const res = await labPOST(post({ test: 'teleport', input: {} }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('UNKNOWN_TEST');
  });

  it('rejects a non-JSON body with 400', async () => {
    const req = new Request('http://localhost/api/v1/control-center/lab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{',
    });
    const res = await labPOST(req);
    expect(res.status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const req = new Request('http://localhost/api/v1/control-center/lab', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(70 * 1024),
      },
      body: JSON.stringify({ test: 'faq-retrieval', input: {} }),
    });
    const res = await labPOST(req);
    expect(res.status).toBe(413);
  });

  it('rejects malformed lab input with 400 instead of a 500', async () => {
    const res = await labPOST(
      post({ test: 'appointments', input: { durationMinutes: 100000 } }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-string test name with 400', async () => {
    const res = await labPOST(post({ test: 42, input: {} }));
    expect(res.status).toBe(400);
  });
});

// Regression: neither chunked transport nor a JSON primitive bypasses validation.
describe('lab transport bounds', () => {
  it('rejects null JSON without a server exception', async () => {
    const response = await labPOST(new Request('http://localhost/api/v1/control-center/lab', { method: 'POST', body: 'null' }));
    expect(response.status).toBe(400);
  });
  it('enforces the byte limit even without Content-Length', async () => {
    const response = await labPOST(new Request('http://localhost/api/v1/control-center/lab', { method: 'POST', body: JSON.stringify({ test: 'faq-retrieval', input: { question: 'a'.repeat(66000) } }) }));
    expect(response.status).toBe(413);
  });
});
