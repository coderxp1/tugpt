#!/usr/bin/env node
/**
 * Egress-proxy acceptance probe (Agent 2 M4). Run it against the REAL, digest-pinned proxy from a
 * container on the same internal network as the web tier:
 *
 *   PROBE_REBIND_HOST=<name> PROBE_CANARY_PORT=443 node egress-probe.cjs http://egress-proxy:3128
 *
 * Fail-closed by design. Exit 0 / ALL_BLOCKED only when ALL of these hold:
 *   1. preflight - the proxy accepts a TCP connection (else exit 2, PROXY_UNREACHABLE);
 *   2. control   - CONNECT to a public host returns 200 (else exit 3, NO_POSITIVE_CONTROL), so a dead
 *                  or non-forwarding proxy can never "pass";
 *   3. every deny case gets an explicit non-2xx HTTP answer FROM THE PROXY. A socket error or
 *      timeout after a good preflight is AMBIGUOUS and counts as FAIL - an unreachable target looks
 *      the same as a policy denial;
 *   4. DNS rebinding was tested (else exit 4, REBINDING_NOT_TESTED): PROBE_REBIND_HOST must
 *      alternate between a public address and THIS probe container's private address. The probe
 *      listens on PROBE_CANARY_PORT there; PASS only if the canary receives zero connections. A 200
 *      on its own is fine (the name resolved public that time) - a canary hit is the leak.
 *
 * The web tier sends only `CONNECT host:443`, so the proxy performs the final resolution. These
 * hostname and rebinding cases cover what the web-tier pre-check cannot fully protect.
 * Also: a DIRECT TCP connection (no proxy) to the control host must fail - the app network must
 * have no route around the proxy. The positive control proves that host is otherwise reachable.
 * Environment: PROBE_CONTROL_HOST (example.com), PROBE_DIRECT_TARGET (<control>:443),
 * PROBE_REBIND_HOST, PROBE_REBIND_TRIES (20), PROBE_CANARY_PORT (443), PROBE_TIMEOUT_MS (5000).
 */
const http = require('node:http');
const net = require('node:net');

const proxyUrl = new URL(process.argv[2] || process.env.PROBE_PROXY || 'http://egress-proxy:3128');
const PROXY_HOST = proxyUrl.hostname.replace(/^\[|\]$/g, '');
const PROXY_PORT = Number(proxyUrl.port || 3128);
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 5000);
const CONTROL = process.env.PROBE_CONTROL_HOST || 'example.com';
const REBIND = process.env.PROBE_REBIND_HOST || '';
const REBIND_TRIES = Number(process.env.PROBE_REBIND_TRIES || 20);
const CANARY_PORT = Number(process.env.PROBE_CANARY_PORT || 443);
const DIRECT = process.env.PROBE_DIRECT_TARGET || `${CONTROL}:443`;

const cases = [
  ['private 10/8', '10.0.0.1'], ['private 172.16/12', '172.16.0.1'], ['private 192.168/16', '192.168.1.1'],
  ['loopback', '127.0.0.1'], ['this-network 0/8', '0.0.0.0'], ['link-local metadata', '169.254.169.254'],
  ['CGNAT 100.64/10', '100.64.0.1'], ['benchmark 198.18/15', '198.18.0.1'], ['IETF 192.0.0/24', '192.0.0.1'],
  ['TEST-NET-1', '192.0.2.1'], ['multicast', '224.0.0.1'], ['reserved 240/4', '240.0.0.1'],
  ['decimal loopback', '2130706433'], ['hex loopback', '0x7f.0.0.1'], ['short loopback', '127.1'], ['octal loopback', '0177.0.0.1'],
  ['IPv6 loopback', '[::1]'], ['IPv6 unspecified', '[::]'], ['IPv6 ULA fc00::/7', '[fc00::1]'], ['IPv6 link-local', '[fe80::1]'],
  ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'], ['IPv4-mapped metadata', '[::ffff:169.254.169.254]'],
  ['NAT64 metadata 64:ff9b::/96', '[64:ff9b::a9fe:a9fe]'], ['documentation 2001:db8::/32', '[2001:db8::1]'],
  ['localhost', 'localhost'], ['name -> 127.0.0.1', 'localtest.me'], ['name -> 10.0.0.1', '10.0.0.1.nip.io'],
  ['name -> metadata', '169.254.169.254.nip.io'],
];

function tcpReachable(host = PROXY_HOST, port = PROXY_PORT) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(TIMEOUT, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** One proxy request -> { kind: 'http', status, error } or { kind: 'socket', detail }. */
function proxyRequest(method, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: PROXY_HOST, port: PROXY_PORT, method, path, timeout: TIMEOUT });
    const httpResult = (res, socket) => {
      if (socket) socket.destroy();
      res.resume();
      resolve({ kind: 'http', status: res.statusCode, error: res.headers['x-smokescreen-error'] || '' });
    };
    req.once('connect', (res, socket) => httpResult(res, socket));
    req.once('response', (res) => httpResult(res));
    req.once('timeout', () => { req.destroy(); resolve({ kind: 'socket', detail: 'timeout' }); });
    req.once('error', (e) => resolve({ kind: 'socket', detail: e.code || 'error' }));
    req.end();
  });
}

const denied = (r) => r.kind === 'http' && (r.status < 200 || r.status >= 300);
const show = (r) => (r.kind === 'http' ? `HTTP ${r.status}${r.error ? ` (${r.error})` : ''}` : `socket ${r.detail} (ambiguous)`);

function startCanary() {
  return new Promise((resolve, reject) => {
    const hits = [];
    const srv = net.createServer((s) => { hits.push(s.remoteAddress); s.destroy(); });
    srv.once('error', reject);
    srv.listen(CANARY_PORT, '0.0.0.0', () => resolve({ hits, close: () => srv.close() }));
  });
}

async function main() {
  if (!(await tcpReachable())) {
    console.log(`PROXY_UNREACHABLE ${PROXY_HOST}:${PROXY_PORT} - nothing was tested; this is NOT a pass`);
    return 2;
  }
  const control = await proxyRequest('CONNECT', `${CONTROL}:443`);
  if (!(control.kind === 'http' && control.status === 200)) {
    console.log(`NO_POSITIVE_CONTROL CONNECT ${CONTROL}:443 -> ${show(control)}; the proxy is not forwarding, so refusals prove nothing`);
    return 3;
  }
  console.log(`PASS control: CONNECT ${CONTROL}:443 -> HTTP 200`);

  let failed = 0;
  const directHost = DIRECT.slice(0, DIRECT.lastIndexOf(':')).replace(/^\[|\]$/g, '');
  const directOpen = await tcpReachable(directHost, Number(DIRECT.slice(DIRECT.lastIndexOf(':') + 1)));
  if (directOpen) failed++;
  console.log(`${directOpen ? 'FAIL' : 'PASS'} direct egress bypass (${DIRECT}, no proxy): ${directOpen ? 'connected - the app network routes around the proxy' : 'no connection'}`);
  const expectDenied = (label, r) => { if (!denied(r)) failed++; console.log(`${denied(r) ? 'PASS' : 'FAIL'} ${label}: ${show(r)}`); };
  for (const [name, host] of cases) expectDenied(`${name} (${host})`, await proxyRequest('CONNECT', `${host}:443`));
  expectDenied('plain-HTTP forward', await proxyRequest('GET', `http://${CONTROL}/`));
  expectDenied('non-443 port', await proxyRequest('CONNECT', `${CONTROL}:8443`));

  if (!REBIND) {
    console.log(failed === 0 ? 'REBINDING_NOT_TESTED - set PROBE_REBIND_HOST; acceptance is incomplete' : `${failed} CASE(S) UNBLOCKED`);
    return failed === 0 ? 4 : 1;
  }
  const canary = await startCanary();
  const statuses = {};
  for (let i = 0; i < REBIND_TRIES; i++) {
    const r = await proxyRequest('CONNECT', `${REBIND}:${CANARY_PORT}`);
    statuses[show(r)] = (statuses[show(r)] || 0) + 1;
  }
  await new Promise((r) => setTimeout(r, 500));
  canary.close();
  if (canary.hits.length) failed++;
  console.log(`${canary.hits.length ? 'FAIL' : 'PASS'} DNS rebinding (${REBIND}) x${REBIND_TRIES}: canary hits ${canary.hits.length}; proxy answers ${JSON.stringify(statuses)}`);

  console.log(failed === 0 ? 'ALL_BLOCKED' : `${failed} CASE(S) UNBLOCKED`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.log(`PROBE_ERROR ${e && e.message}`); process.exit(5); });
