#!/usr/bin/env node
/**
 * The REAL server-client signing path over HTTP (Q-10): `next start` signs an
 * RS256 bridge token for role sso_control with TUGPT_DB_SIGNING_PRIVATE_KEY
 * (createSsoControlClient) -> PostgREST (JWKS, aud tugpt-dashboard-db,
 * sso.pre_request) -> SET ROLE sso_control (needs GRANT sso_control TO
 * authenticator) -> the Q-9c server functions. Exercised by:
 *   - a plain chat answer        -> append_chat_message_server
 *   - an agent run               -> custom_agent_run_instructions + append_chat_message_server
 * and, on the user's own token, custom_agent_instructions (owner vs non-owner).
 * The model is fake-llm.mjs; its log shows what the app sent to the model.
 *
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE (as conversations-http), FAKE_LLM_LOG,
 *      E2E_EXPECT = "granted" (default) | "revoked" (authenticator is NOT a member of
 *      sso_control: sessions cannot load, so every protected request must fail closed
 *      with 503 temporarily_unavailable and the model is never called; the harness
 *      checks separately that no row was written).
 * Exit code 0 only if every check passed. Cookie values and tokens are never logged.
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const LLM_LOG = process.env.FAKE_LLM_LOG;
const EXPECT = process.env.E2E_EXPECT ?? 'granted';
if (!['granted', 'revoked'].includes(EXPECT)) throw new Error(`E2E_EXPECT must be granted|revoked, got ${EXPECT}`);
const T_MEMBER = 'a4700000-0000-4000-8000-0000000000a2';
const MARKER = `E2E-MARKER-${randomBytes(6).toString('hex')}`;
const bodies = []; // every response body, scanned for leaked tokens at the end

async function http(who, method, path, { body } = {}) {
  const h = {};
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  bodies.push(text);
  let json = null; try { json = JSON.parse(text); } catch { /* NDJSON or empty */ }
  return { status: res.status, json, text };
}
const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const llmRequests = () => (existsSync(LLM_LOG) ? readFileSync(LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const assistants = (thread) => (thread.json?.messages ?? []).filter((m) => m.role === 'assistant');

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
}

let orgAgent = '';
try {
  console.log(`## signing path, expect=${EXPECT}`);
  if (EXPECT === 'granted') {
    await check('plain chat answer is stored through the RS256 sso_control token (append_chat_message_server)', async () => {
      const before = assistants(await http('memberA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`)).length;
      const r = await http('memberA', 'POST', `/api/v1/chat/threads/${T_MEMBER}/messages`, { body: { content: 'plain hello', modelKey: 'tugpt-scout' } });
      assert.equal(r.status, 200);
      const ev = ndjson(r.text);
      assert.equal(ev.at(-1).type, 'done', `last event ${JSON.stringify(ev.at(-1)).slice(0, 200)}`);
      assert.equal(ev.at(-1).message.role, 'assistant');
      assert.equal(ev.at(-1).message.content, 'Hello from the fake model');
      const after = assistants(await http('memberA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`));
      assert.equal(after.length, before + 1);
      assert.equal(after.at(-1).id, ev.at(-1).message.id);
    });

    await check('owner creates an organization agent and sees its instructions (custom_agent_instructions)', async () => {
      const c = await http('ownerA', 'POST', '/api/v1/agents', { body: { name: 'E2E signing desk', instructions: `Always mention ${MARKER}.`, visibility: 'organization' } });
      assert.equal(c.status, 201, JSON.stringify(c.json));
      orgAgent = c.json.agent.id;
      assert.equal(c.json.agent.instructions, `Always mention ${MARKER}.`);
      const g = await http('ownerA', 'GET', `/api/v1/agents/${orgAgent}`);
      assert.equal(g.status, 200);
      assert.equal(g.json.agent.instructions, `Always mention ${MARKER}.`);
    });

    await check('a member who cannot edit sees the agent without instructions', async () => {
      const g = await http('memberA', 'GET', `/api/v1/agents/${orgAgent}`);
      assert.equal(g.status, 200);
      assert.equal(g.json.agent.instructions, '');
      const l = await http('memberA', 'GET', '/api/v1/agents');
      assert.equal(l.status, 200);
      assert.equal(l.json.agents.find((a) => a.id === orgAgent)?.instructions, '');
      assert.ok(!bodies.at(-1).includes(MARKER) && !bodies.at(-2).includes(MARKER));
    });

    await check('the member runs it: instructions reach the model only through custom_agent_run_instructions, never the client', async () => {
      const n = llmRequests().length;
      const r = await http('memberA', 'POST', `/api/v1/agents/${orgAgent}/run`, { body: { content: 'hello agent' } });
      assert.equal(r.status, 200);
      const ev = ndjson(r.text);
      assert.equal(ev.at(-1).type, 'done', `last event ${JSON.stringify(ev.at(-1)).slice(0, 200)}`);
      assert.ok(!r.text.includes(MARKER), 'instructions leaked into the stream');
      const sent = llmRequests().slice(n);
      assert.equal(sent.length, 1);
      const system = sent[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      assert.match(system, /<agent_instructions>/);
      assert.ok(system.includes(MARKER), 'run instructions missing from the model prompt');
      const tid = ev[0].thread.id;
      const t = await http('memberA', 'GET', `/api/v1/chat/threads/${tid}`);
      assert.equal(t.status, 200);
      assert.equal(t.json.thread.agentId, orgAgent);
      assert.equal(assistants(t).at(-1).id, ev.at(-1).message.id);
      assert.ok(!t.text.includes(MARKER));
    });
  } else {
    // Sessions themselves are loaded with the same RS256 sso_control token (sso.load_session in
    // proxy.ts), so without the membership EVERY protected request fails closed with 503 before
    // any route handler runs. The harness separately checks that no row was written.
    const unavailable = (r) => { assert.equal(r.status, 503); assert.deepEqual(r.json, { error: 'temporarily_unavailable' }); };
    await check('without sso_control membership a thread read fails closed (503, session store)', async () => {
      unavailable(await http('memberA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`));
    });
    await check('without sso_control membership a chat send fails closed before the model is called', async () => {
      const n = llmRequests().length;
      unavailable(await http('memberA', 'POST', `/api/v1/chat/threads/${T_MEMBER}/messages`, { body: { content: 'plain hello', modelKey: 'tugpt-scout' } }));
      assert.equal(llmRequests().length, n);
    });
    await check('without sso_control membership agent create and run fail closed', async () => {
      const n = llmRequests().length;
      unavailable(await http('ownerA', 'POST', '/api/v1/agents', { body: { name: 'E2E revoked desk', instructions: `Always mention ${MARKER}.`, visibility: 'organization' } }));
      unavailable(await http('memberA', 'POST', '/api/v1/agents/a4900000-0000-4000-8000-0000000000ff/run', { body: { content: 'hello agent' } }));
      assert.equal(llmRequests().length, n);
    });
  }

  await check('no bearer token or instructions marker appears in any response body', async () => {
    for (const b of bodies) assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(b), 'JWT-like string in a response');
  });
} finally {
  if (orgAgent) {
    const d = await http('ownerA', 'DELETE', `/api/v1/agents/${orgAgent}`);
    if (d.status !== 200) { failed++; console.log(`not ok - cleanup: delete agent returned ${d.status}`); }
  }
}
console.log(`# signing (${EXPECT}): ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
