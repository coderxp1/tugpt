/**
 * @file tool-calling-probe-cli.ts
 * @description CLI for the live tool-calling probe. NOT exported from index.
 *
 * Usage (non-production key only):
 *   LANGDOCK_PROBE_KEY_FILE=/path/to/0600-keyfile \
 *   node packages/ai-providers/dist/tool-calling-probe-cli.js \
 *     --confirm-nonprod --out /srv/.../tool-calling-probe.json
 *
 * The key file must contain only the key, must not be group/world readable,
 * and is never echoed. Exit codes: 0 report written, 2 guard refusal, 1 error.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { assertProbeAllowed, ProbeGuardError, runToolCallingProbe } from './tool-calling-probe';
import { LangdockToolCallingAdapter } from './tool-calling';

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function readKeyFile(path: string | undefined): string {
  if (!path) throw new ProbeGuardError('LANGDOCK_PROBE_KEY_FILE is not set');
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) {
    throw new ProbeGuardError('key file must not be group/world accessible (chmod 600)');
  }
  const key = readFileSync(path, 'utf8').trim();
  if (!key || /\s/.test(key)) throw new ProbeGuardError('key file is empty or malformed');
  return key;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  try {
    assertProbeAllowed(process.env, argv);
    const out = argValue(argv, '--out');
    if (!out) throw new ProbeGuardError('--out <path> is required');
    const endpointUrl = process.env.LANGDOCK_PROBE_ENDPOINT ?? 'https://api.langdock.com/openai/eu/v1';
    const adapter = new LangdockToolCallingAdapter({
      apiKey: readKeyFile(process.env.LANGDOCK_PROBE_KEY_FILE),
      endpointUrl,
    });
    const modelsArg = argValue(argv, '--models');
    const report = await runToolCallingProbe({
      adapter,
      endpointHost: new URL(endpointUrl).host,
      ...(modelsArg ? { models: modelsArg.split(',') } : {}),
    });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o640 });
    process.stdout.write(
      `requests=${report.requestsMade}/${report.requestCap} recommended=${report.recommendedVerifiedModels.join(',') || 'none'}\n`
    );
    for (const [m, s] of Object.entries(report.summary)) {
      process.stdout.write(`  ${m}: ${s.passed}/${s.total}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ProbeGuardError) {
      process.stderr.write(`probe refused: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`probe failed: ${err instanceof Error ? err.name : 'unknown'}\n`);
    return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
