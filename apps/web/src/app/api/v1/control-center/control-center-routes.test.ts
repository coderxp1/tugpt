// Control Center API routes — the health endpoint reports real local
// state (never secret values), and the lab endpoint runs labs or
// returns honest errors for unknown tests and bad bodies.

import { describe, expect, it } from 'vitest';
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
});
