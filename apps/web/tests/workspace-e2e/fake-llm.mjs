#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible endpoint for the E2E runners: POST
 * /v1/chat/completions answers "Hello from the fake model" (SSE when
 * stream=true) and appends each request's messages to FAKE_LLM_LOG as one
 * JSON line, so a runner can assert what the app actually sent to the model.
 * Loopback only; no keys; never reaches a real model.
 *
 * env: FAKE_LLM_PORT, FAKE_LLM_LOG
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.FAKE_LLM_PORT);
const LOG = process.env.FAKE_LLM_LOG;
if (!PORT || !LOG) { console.error('FAKE_LLM_PORT and FAKE_LLM_LOG are required'); process.exit(2); }
const ANSWER = 'Hello from the fake model';

http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), stream: body.stream === true, messages: body.messages ?? [] }) + '\n');
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const part of ['Hello ', 'from the ', 'fake model']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }));
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake LLM on 127.0.0.1:${PORT}`));
