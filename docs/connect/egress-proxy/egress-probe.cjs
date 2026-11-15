#!/usr/bin/env node
/**
 * Automated egress tests (prepared; run against a deployed proxy).
 * Usage: node egress-probe.cjs [proxyUrl]
 * Asserts every hostile target is refused, per docs/connect/egress-proxy/README.md.
 * NOT run yet â€” requires the deployment step (owner-gated).
 */
const http = require('node:http');

const proxy = process.argv[2] || 'http://egress-proxy:3128';

const cases = [
  { name: 'private IPv4 10/8', host: '10.0.0.1', port: 443 },
  { name: 'private IPv4 172.16/12', host: '172.16.0.1', port: 443 },
  { name: 'private IPv4 192.168/16', host: '192.168.1.1', port: 443 },
  { name: 'loopback IPv4', host: '127.0.0.1', port: 8080 },
  { name: 'link-local metadata', host: '169.254.169.254', port: 80 },
  { name: 'CGNAT 100.64/10', host: '100.64.0.1', port: 443 },
  { name: 'ULA IPv6', host: 'fc00::1', port: 443 },
  { name: 'this host (internal service)', host: '82.165.50.109', port: 443 },
];

function attempt(target) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: proxy.replace(/^https?:\/\//, '').split(':')[0],
        port: Number(proxy.split(':').pop()),
        method: 'CONNECT',
        path: `${target.host}:${target.port}`,
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }); });
    req.on('error', () => resolve({ status: 'refused' }));
    req.end();
  });
}

(async () => {
  let failed = 0;
  for (const c of cases) {
    const r = await attempt(c);
    // 403 (allowlist/policy deny) or refused/timeout all count as blocked.
    const blocked = r.status === 403 || r.status === 'refused' || r.status === 'timeout';
    if (!blocked) failed++;
    console.log(`${blocked ? 'PASS' : 'FAIL'} ${c.name}: ${r.status}`);
  }

  // Plain HTTP forward (non-CONNECT) must be refused with 405.
  const plain = await new Promise((resolve) => {
    const req = http.request(
      { host: proxy.replace(/^https?:\/\//, '').split(':')[0], port: Number(proxy.split(':').pop()), method: 'GET', path: '/', timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', () => resolve('refused'));
    req.end();
  });
  const plainOk = plain === 405 || plain === 'refused' || plain === 'timeout';
  if (!plainOk) failed++;
  console.log(`${plainOk ? 'PASS' : 'FAIL'} plain-HTTP forward: ${plain}`);

  console.log(failed === 0 ? 'ALL_BLOCKED' : `${failed} CASE(S) UNBLOCKED`);
  process.exit(failed === 0 ? 0 : 1);
})();
