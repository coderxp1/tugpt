#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible endpoint for the E2E runners: POST
 * /v1/chat/completions answers "Hello from the fake model" (SSE when
 * stream=true) and appends each request's messages to FAKE_LLM_LOG as one
 * JSON line, so a runner can assert what the app actually sent to the model.
 * Loopback only; no keys; never reaches a real model.
 *
 * Opt-in behaviours, keyed on the LAST message's content:
 *   "[fail-once]"      the first request with that exact content answers HTTP 500, later ones succeed
 *   "[slow]"           streams six chunks one second apart, so a client can drop mid-answer
 *   "[stall-once]"     (Q-15 TIMEOUT-1) first request: two text chunks, then silence with the socket open
 *   "[noreply-once]"   first request: 200 + a role chunk, then silence (no first token)
 *   "[noheaders-once]" first request: never sends response headers
 *   "[nousage]"        never reports usage
 *   "[zerousage]"      reports usage, but 0 prompt and 0 completion tokens (a real, known zero)
 *   "[empty-once]"     first request: a clean SSE stream with no text at all, then [DONE]
 * Every request gets an `id` in its log line. When the client closes a response before this
 * server ended it, a line { event: 'closed', id, ms } is appended (proof the app aborted upstream).
 * Usage (Q-15 USAGE-1): when the request sets stream_options.include_usage, a final
 * chunk { choices: [], usage } follows the text (the shape Ollama/OpenAI send);
 * non-streaming answers always carry usage. Reported numbers: FAKE_USAGE below.
 *
 * env: FAKE_LLM_PORT, FAKE_LLM_LOG
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.FAKE_LLM_PORT);
const LOG = process.env.FAKE_LLM_LOG;
if (!PORT || !LOG) { console.error('FAKE_LLM_PORT and FAKE_LLM_LOG are required'); process.exit(2); }
const ANSWER = 'Hello from the fake model';
export const FAKE_USAGE = { stream: { prompt_tokens: 41, completion_tokens: 7 }, tools: { prompt_tokens: 23, completion_tokens: 5 } };
const once = new Map([['[fail-once]', new Set()], ['[stall-once]', new Set()], ['[noreply-once]', new Set()], ['[noheaders-once]', new Set()], ['[empty-once]', new Set()]]);
let seq = 0;
const firstTime = (marker, last) => {
  if (!last.includes(marker)) return false;
  const seen = once.get(marker);
  if (seen.has(last)) return false;
  seen.add(last); return true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`;
const ZERO = { prompt_tokens: 0, completion_tokens: 0 };
let usageChunk = () => '';

http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const last = String((body.messages ?? []).at(-1)?.content ?? '');
    const wantsUsage = body.stream_options?.include_usage === true && !last.includes('[nousage]');
    const zero = last.includes('[zerousage]');
    usageChunk = () => `data: ${JSON.stringify({ choices: [], usage: zero ? ZERO : FAKE_USAGE.stream })}\n\n`;
    const id = ++seq;
    const t0 = Date.now();
    appendFileSync(LOG, JSON.stringify({ id, at: new Date().toISOString(), stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, model: body.model, messages: body.messages ?? [] }) + '\n');
    res.on('close', () => {
      if (!res.writableEnded) appendFileSync(LOG, JSON.stringify({ event: 'closed', id, at: new Date().toISOString(), ms: Date.now() - t0 }) + '\n');
    });
    if (body.stream === true && firstTime('[empty-once]', last)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n${wantsUsage ? usageChunk() : ''}data: [DONE]\n\n`);
      return;
    }
    if (firstTime('[fail-once]', last)) { res.writeHead(500); res.end('{"error":"fake upstream failure"}'); return; }
    if (firstTime('[noheaders-once]', last)) { return; /* never answers; the socket stays open until the client leaves */ }
    if (body.stream === true && firstTime('[noreply-once]', last)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
      return; // no text, ever
    }
    if (body.stream === true && firstTime('[stall-once]', last)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk('Partial ')); res.write(chunk('answer '));
      return; // then silence
    }
    if (body.stream === true && last.includes('[slow]')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let gone = false; res.on('close', () => { gone = true; });
      (async () => {
        for (const part of ['Slow ', 'answer ', 'from ', 'the ', 'fake ', 'model']) {
          if (gone) return;
          res.write(chunk(part));
          await sleep(1000);
        }
        if (!gone) res.end(`${wantsUsage ? usageChunk() : ''}data: [DONE]\n\n`);
      })();
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const part of ['Hello ', 'from the ', 'fake model']) res.write(chunk(part));
      res.end(`${wantsUsage ? usageChunk() : ''}data: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER } }], ...(last.includes('[nousage]') ? {} : { usage: zero ? ZERO : FAKE_USAGE.tools }) }));
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake LLM on 127.0.0.1:${PORT}`));
