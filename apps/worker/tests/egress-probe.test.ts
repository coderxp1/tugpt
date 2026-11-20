/**
 * Regression tests for docs/connect/egress-proxy/egress-probe.cjs, the acceptance probe that must
 * pass against the real egress proxy before customer MCP may be enabled.
 *
 * The previous probe counted "socket refused" and "timeout" as BLOCKED, so a dead proxy printed
 * ALL_BLOCKED and exited 0. These tests run the real probe script (child process) against stub
 * proxies on 127.0.0.1. MOCKED: the proxies are local stubs, not Smokescreen, so this verifies the
 * probe's verdict logic only. It says nothing about the real proxy's policy (that is what the probe
 * is for). No traffic leaves this host: the stubs never forward anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const PROBE = path.join(process.cwd(), '..', '..', 'docs', 'connect', 'egress-proxy', 'egress-probe.cjs');
const CONTROL = 'control.probe.test';
const REBIND = 'rebind.probe.test';

type Policy = (target: string, socket: Duplex) => void;
const servers: Array<{ close: () => void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

const answer = (socket: Duplex, status: number) => {
  socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'Connection Established' : 'Denied'}\r\nX-Smokescreen-Error: stub\r\n\r\n`);
};

async function stubProxy(policy: Policy, plainStatus = 403): Promise<string> {
  const sockets = new Set<Duplex>();
  const srv = http.createServer((_req, res) => { res.statusCode = plainStatus; res.end(); });
  srv.on('connect', (req, socket) => { sockets.add(socket); policy(req.url ?? '', socket); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push({ close: () => { for (const s of sockets) s.destroy(); srv.close(); } });
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function runProbe(proxy: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE, proxy], {
      env: { PATH: process.env.PATH ?? '', PROBE_CONTROL_HOST: CONTROL, PROBE_TIMEOUT_MS: '1500', ...env },
      timeout: 60_000,
    }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout }));
  });
}

/** A correct proxy: forwards only the public control host on :443, refuses everything else over HTTP. */
const correct: Policy = (target, socket) => answer(socket, target === `${CONTROL}:443` ? 200 : 403);

describe('egress-probe.cjs fails closed', () => {
  it('finds the probe it is testing', () => { expect(existsSync(PROBE), PROBE).toBe(true); });

  it('a dead proxy is PROXY_UNREACHABLE (exit 2), never ALL_BLOCKED', async () => {
    const r = await runProbe(`http://127.0.0.1:${await freePort()}`);
    expect(r.code).toBe(2);
    expect(r.out).toContain('PROXY_UNREACHABLE');
    expect(r.out).not.toContain('ALL_BLOCKED');
  });

  it('a proxy that refuses everything has no positive control (exit 3), never ALL_BLOCKED', async () => {
    const r = await runProbe(await stubProxy((_t, s) => answer(s, 403)));
    expect(r.code).toBe(3);
    expect(r.out).toContain('NO_POSITIVE_CONTROL');
    expect(r.out).not.toContain('ALL_BLOCKED');
  });

  it('a proxy that forwards everything fails every private target (exit 1)', async () => {
    const r = await runProbe(await stubProxy((_t, s) => answer(s, 200), 200), { PROBE_REBIND_HOST: REBIND, PROBE_CANARY_PORT: String(await freePort()) });
    expect(r.code).toBe(1);
    for (const host of ['127.0.0.1', '169.254.169.254', '[::1]', '[64:ff9b::a9fe:a9fe]', '2130706433', 'localtest.me', '10.0.0.1.nip.io']) {
      expect(r.out).toMatch(new RegExp(`FAIL .*\\(${host.replace(/[.[\]]/g, '\\$&')}\\): HTTP 200`));
    }
    expect(r.out).toMatch(/FAIL plain-HTTP forward: HTTP 200/);
    expect(r.out).toMatch(/FAIL non-443 port: HTTP 200/);
  });

  it('dropped connections are ambiguous, not blocks (exit 1)', async () => {
    const r = await runProbe(await stubProxy((t, s) => (t === `${CONTROL}:443` ? answer(s, 200) : s.destroy())), { PROBE_REBIND_HOST: REBIND, PROBE_CANARY_PORT: String(await freePort()) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL loopback \(127\.0\.0\.1\): socket \S+ \(ambiguous\)/);
    expect(r.out).not.toContain('ALL_BLOCKED');
  });

  it('a correct proxy without a rebinding host is incomplete (exit 4), not ALL_BLOCKED', async () => {
    const r = await runProbe(await stubProxy(correct));
    expect(r.code).toBe(4);
    expect(r.out).toContain('REBINDING_NOT_TESTED');
    expect(r.out).not.toContain('ALL_BLOCKED');
    expect(r.out).not.toContain('FAIL');
  });

  it('a rebinding leak (the proxy reaches the private canary) fails even though every answer is 200', async () => {
    const canaryPort = await freePort();
    const leaky: Policy = (target, socket) => {
      if (target === `${REBIND}:${canaryPort}`) {
        // Simulates TOCTOU: checked a public answer, then connected to the private one (the canary).
        const up = net.connect(canaryPort, '127.0.0.1', () => { up.destroy(); answer(socket, 200); });
        up.once('error', () => answer(socket, 502));
        return;
      }
      correct(target, socket);
    };
    const r = await runProbe(await stubProxy(leaky), { PROBE_REBIND_HOST: REBIND, PROBE_REBIND_TRIES: '5', PROBE_CANARY_PORT: String(canaryPort) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL DNS rebinding \(rebind\.probe\.test\) x5: canary hits 5/);
  });

  it('a direct route around the proxy is a FAIL even when the proxy itself is correct', async () => {
    const direct = net.createServer((sk) => sk.destroy());
    await new Promise<void>((r) => direct.listen(0, '127.0.0.1', r));
    servers.push({ close: () => direct.close() });
    const canaryPort = await freePort();
    const r = await runProbe(await stubProxy((t, s) => (t === `${REBIND}:${canaryPort}` ? answer(s, 403) : correct(t, s))), {
      PROBE_DIRECT_TARGET: `127.0.0.1:${(direct.address() as AddressInfo).port}`, PROBE_REBIND_HOST: REBIND, PROBE_CANARY_PORT: String(canaryPort),
    });
    expect(r.out).toMatch(/FAIL direct egress bypass .*connected/);
    expect(r.out).not.toContain('ALL_BLOCKED');
    expect(r.code).toBe(1);
  });

  it('a canary that cannot listen is a probe error (exit 5), never a pass', async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '0.0.0.0', r));
    servers.push({ close: () => busy.close() });
    const r = await runProbe(await stubProxy(correct), { PROBE_REBIND_HOST: REBIND, PROBE_CANARY_PORT: String((busy.address() as AddressInfo).port) });
    expect(r.code).toBe(5);
    expect(r.out).toContain('PROBE_ERROR');
    expect(r.out).not.toContain('ALL_BLOCKED');
  });

  it('a correct proxy with rebinding refused (or resolved public) is ALL_BLOCKED (exit 0)', async () => {
    const canaryPort = await freePort();
    let n = 0;
    // Alternate like a rebinding name: odd tries "resolve public" (200, no canary contact), even tries are refused.
    const safe: Policy = (target, socket) => (target === `${REBIND}:${canaryPort}` ? answer(socket, n++ % 2 ? 200 : 403) : correct(target, socket));
    const r = await runProbe(await stubProxy(safe), { PROBE_REBIND_HOST: REBIND, PROBE_REBIND_TRIES: '6', PROBE_CANARY_PORT: String(canaryPort) });
    expect(r.out).toMatch(/PASS direct egress bypass .*no connection/);
    expect(r.out).toMatch(/PASS DNS rebinding \(rebind\.probe\.test\) x6: canary hits 0/);
    expect(r.out).not.toContain('FAIL');
    expect(r.out.trim().split('\n').pop()).toBe('ALL_BLOCKED');
    expect(r.code).toBe(0);
  });
});
