// Private owner launcher. No tenant credentials, providers, workers, or public listener.
import { randomBytes } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const build = spawnSync(pnpm, ['exec', 'turbo', 'build', '--filter=web^...'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const token = process.env.CONTROL_CENTER_TOKEN?.trim() || randomBytes(32).toString('hex');
if (token.length < 24) { console.error('CONTROL_CENTER_TOKEN must contain at least 24 characters.'); process.exit(1); }
console.log('\nOpen http://localhost:3000/control-center\nOwner access key (private; do not share):\n' + token + '\n\nKeep this terminal open. Ctrl+C stops the workspace.\n');
const child = spawn(pnpm, ['--filter', 'web', 'dev', '--hostname', '127.0.0.1', '--port', '3000'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CONTROL_CENTER_TOKEN: token },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', err => { console.error(err.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));
