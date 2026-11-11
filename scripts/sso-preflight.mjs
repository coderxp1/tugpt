#!/usr/bin/env node
/**
 * Non-production SSO preflight.
 *
 * Answers, without a browser and without any dashboard or service-role
 * credential, the one question that actually blocks the SSO journey: are the
 * GitHub and Google providers enabled on the non-production Supabase project,
 * and does the authorize endpoint hand off to the right provider?
 *
 * WHAT THIS PROVES
 *
 *   GET {url}/auth/v1/authorize?provider=github  -> 302 to github.com
 *   GET {url}/auth/v1/authorize?provider=google  -> 302 to accounts.google.com
 *
 * A provider that is not enabled answers 400 with
 * "Unsupported provider: provider is not enabled". That is a measured fact
 * about the project's auth configuration, obtained with the public anon key,
 * so nobody has to read it off a dashboard screenshot.
 *
 * WHAT THIS CANNOT PROVE
 *
 *   * Whether manual linking (`enable_manual_linking`) is on. GoTrue's
 *     /auth/v1/settings does not expose it; `linkIdentity` is the only probe,
 *     and it needs a real session. Reported as UNKNOWN rather than assumed.
 *   * Whether the redirect allowlist contains {site}/auth/callback. The
 *     authorize call 302s to the provider either way; the allowlist decides
 *     where the callback lands afterwards. Also reported as UNKNOWN.
 *   * Whether the OAuth client itself is valid — a wrong client secret is only
 *     visible after the provider round trip.
 *
 * Those three are exactly the owner-side items in
 * docs/sso-nonprod-verification.md §2; this script narrows that list instead of
 * pretending to replace it.
 *
 * USAGE
 *
 *   node scripts/sso-preflight.mjs
 *   node scripts/sso-preflight.mjs --env-file .env.local --site http://localhost:3000
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from the
 * environment, falling back to the named env file. The key is never printed,
 * logged, or included in the output.
 *
 * Exit codes: 0 all providers enabled, 1 a provider is not enabled,
 * 2 configuration problem (missing values, or a production project ref).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PRODUCTION_REF = 'rbiumegrwtavmljxbknp';
const PROVIDERS = [
  { id: 'github', host: 'github.com', label: 'GitHub' },
  { id: 'google', host: 'accounts.google.com', label: 'Google' },
];

function parseArgs(argv) {
  const args = { envFile: '.env.local', site: 'http://localhost:3000' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--env-file') args.envFile = argv[i += 1];
    else if (flag === '--site') args.site = argv[i += 1];
    else if (flag === '--help' || flag === '-h') {
      console.log('node scripts/sso-preflight.mjs [--env-file .env.local] [--site http://localhost:3000]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

/** Minimal KEY=VALUE reader. Quotes stripped; nothing is ever echoed. */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const fileEnv = readEnvFile(resolve(args.envFile));

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? fileEnv.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  '';

if (!url) fail(`NEXT_PUBLIC_SUPABASE_URL is not set (env or ${args.envFile})`);
if (!anonKey) fail(`NEXT_PUBLIC_SUPABASE_ANON_KEY is not set (env or ${args.envFile})`);
if (url.includes(PRODUCTION_REF)) {
  fail(`refusing to run against the PRODUCTION project (${PRODUCTION_REF}); this check is non-production only`);
}

const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
const callback = `${args.site.replace(/\/+$/, '')}/auth/callback`;

console.log('=== SSO preflight (non-production) ===');
console.log(`project:  ${url.replace(/^https?:\/\//, '')}`);
console.log(`site:     ${args.site}`);
console.log(`callback: ${callback}`);
console.log('');

// --- 1. Project auth settings ---------------------------------------------

let settings;
try {
  const response = await fetch(`${url}/auth/v1/settings`, { headers });
  if (!response.ok) {
    fail(`GET /auth/v1/settings returned ${response.status} — the URL or anon key is wrong`);
  }
  settings = await response.json();
} catch (error) {
  fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
}

const external = settings.external ?? {};
const enabledFromSettings = Object.entries(external)
  .filter(([, on]) => on === true)
  .map(([id]) => id)
  .sort();
console.log(`[info] providers reported enabled by /auth/v1/settings: ${enabledFromSettings.join(', ') || '(none)'}`);
console.log(`[info] signup disabled: ${settings.disable_signup === true}; email autoconfirm: ${settings.mailer_autoconfirm === true}`);
console.log('');

// --- 2. Provider handoff ---------------------------------------------------

const results = [];
for (const provider of PROVIDERS) {
  const target = `${url}/auth/v1/authorize?provider=${provider.id}&redirect_to=${encodeURIComponent(callback)}`;
  let status = 0;
  let location = '';
  let body = '';

  try {
    const response = await fetch(target, { headers, redirect: 'manual' });
    status = response.status;
    location = response.headers.get('location') ?? '';
    if (status >= 400) body = (await response.text()).slice(0, 300);
  } catch (error) {
    results.push({ provider, ok: false, detail: `request failed: ${error instanceof Error ? error.message : String(error)}` });
    continue;
  }

  if (status >= 300 && status < 400 && location) {
    const host = (() => {
      try {
        return new URL(location).host;
      } catch {
        return '';
      }
    })();
    const rightHost = host.endsWith(provider.host);
    const hasClientId = /[?&]client_id=[^&]+/.test(location);
    results.push({
      provider,
      ok: rightHost,
      detail: rightHost
        ? `302 -> ${host} (client_id ${hasClientId ? 'present' : 'ABSENT — check the OAuth client config'})`
        : `302 -> ${host || '(unparseable)'} — expected ${provider.host}`,
    });
    continue;
  }

  if (status === 400) {
    let message = body;
    try {
      const parsed = JSON.parse(body);
      message = parsed.msg ?? parsed.message ?? body;
    } catch {
      /* keep the raw body */
    }
    results.push({ provider, ok: false, detail: `400 — provider is NOT enabled (${message})` });
    continue;
  }

  results.push({ provider, ok: false, detail: `unexpected ${status || 'no response'}${body ? ` — ${body}` : ''}` });
}

for (const { provider, ok, detail } of results) {
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${provider.label}: ${detail}`);
}

console.log('');
console.log('[unknown] manual linking (enable_manual_linking): not exposed by the auth settings API.');
console.log('          Confirm Authentication -> Providers -> Manual linking, or run the link step of the journey.');
console.log('[unknown] redirect allowlist: the authorize call 302s before the allowlist is consulted.');
console.log(`          Confirm Authentication -> URL configuration contains ${callback}`);
console.log('');

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.log(`RESULT: ${failures.length} provider(s) not ready — the SSO journey cannot complete yet.`);
  process.exit(1);
}

console.log('RESULT: every provider hands off correctly. Remaining owner-side items are the two UNKNOWNs above.');
