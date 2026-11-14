#!/usr/bin/env sh
#
# deploy/caddy/check-cert.sh
#
# Catches the two ways TLS on dashboard.tugpt.pro can fail without anyone noticing until
# the site goes down.
#
# 1. The Caddy container cannot resolve DNS.
#
#    Docker copies the host's /etc/resolv.conf into containers. On a host
#    running systemd-resolved that file can contain only 127.0.0.53 — the stub
#    listener, which exists only in the host's network namespace and is
#    unreachable from inside a container. Docker usually detects the stub and
#    substitutes public resolvers, but not always, and when it does not the
#    container has no working DNS at all.
#
#    This bit us on the 2026-08-24 deployment: the initial ACME challenge
#    failed for exactly this reason. The compose file now pins explicit
#    resolvers on the caddy service so the container does not depend on the
#    host's resolv.conf. This check exists because that is a setting somebody
#    can remove, and because the consequence is invisible: an existing
#    certificate keeps serving for weeks while every renewal attempt fails.
#
# 2. The served certificate is close to expiring.
#
#    Caddy renews at roughly two-thirds of the lifetime — around 30 days out on
#    a 90-day Let's Encrypt certificate. If renewals are failing, the remaining
#    days tick down silently. Anything under three weeks means renewal has been
#    failing for a week or more and needs looking at now, not at expiry.
#
# Usage, on the VPS:
#
#   cd /opt/tugpt
#   set -a; . /etc/tugpt/web.env; set +a
#   sh deploy/caddy/check-cert.sh
#
# Invoked as `sh <path>` rather than `./<path>` on purpose: this file arrives
# through the GitHub API, which writes blobs as 0644, so the executable bit
# does not survive a fresh clone. `chmod +x` it if you prefer, but nothing
# here depends on that.
#
# Exit codes: 0 all good, 1 a check failed, 2 it could not run.
#
# Optional, as root, to be told rather than to remember:
#
#   0 7 * * 1 cd /opt/tugpt && set -a && . /etc/tugpt/web.env && set +a && \
#     sh deploy/caddy/check-cert.sh || \
#     logger -t tugpt-cert -p daemon.err "TLS check failed on dashboard.tugpt.pro"
#
# Weekly is the right cadence: it gives roughly four warnings between the first
# failed renewal and an outage.

set -eu

DOMAIN="${TUGPT_DOMAIN:-}"
MIN_DAYS="${MIN_DAYS:-21}"
PROJECT="${COMPOSE_PROJECT:-tugpt}"
ACME_HOST="${ACME_HOST:-acme-v02.api.letsencrypt.org}"

if [ -z "$DOMAIN" ]; then
  echo "check-cert: TUGPT_DOMAIN is not set." >&2
  echo "            Run: set -a; . /etc/tugpt/web.env; set +a" >&2
  exit 2
fi

for cmd in docker openssl date; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "check-cert: $cmd is not on PATH." >&2
    exit 2
  fi
done

failed=0

# --- 0. Is caddy even up? -----------------------------------------------------
# Without this, a stopped container makes the DNS check below fail and blame
# DNS, which sends you looking in the wrong place.
if ! docker compose -p "$PROJECT" --profile proxy ps --status running --services 2>/dev/null \
     | grep -qx caddy; then
  echo "FAIL  caddy is not running under project '$PROJECT'." >&2
  echo "            docker compose -p $PROJECT --profile proxy up -d caddy" >&2
  exit 1
fi

# --- 1. DNS from inside the container -----------------------------------------
# nslookup is in the busybox that caddy:2-alpine ships, so nothing extra is
# needed inside the container.
if docker compose -p "$PROJECT" --profile proxy exec -T caddy \
     nslookup "$ACME_HOST" >/dev/null 2>&1; then
  echo "ok    dns   caddy resolves $ACME_HOST"
else
  echo "FAIL  dns   caddy cannot resolve $ACME_HOST" >&2
  echo "            Renewals will fail silently until the certificate expires." >&2
  echo "            Look at the container's resolver:" >&2
  echo "              docker compose -p $PROJECT --profile proxy exec caddy cat /etc/resolv.conf" >&2
  echo "            A 127.0.0.53 nameserver is the systemd-resolved stub and is" >&2
  echo "            not reachable from a container. docker-compose.yml pins" >&2
  echo "            explicit resolvers on the caddy service to prevent this; if" >&2
  echo "            they have been removed, restore them and recreate caddy." >&2
  failed=1
fi

# --- 2. Days left on the certificate actually being served --------------------
# Deliberately over the network rather than reading Caddy's storage: what
# matters is the certificate a browser receives.
enddate=$(echo \
  | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null \
  | cut -d= -f2)

if [ -z "$enddate" ]; then
  echo "FAIL  cert  could not read a certificate from $DOMAIN:443" >&2
  echo "            Is caddy running? docker compose -p $PROJECT --profile proxy ps" >&2
  exit 1
fi

end_epoch=$(date -d "$enddate" +%s 2>/dev/null || echo '')
if [ -z "$end_epoch" ]; then
  echo "FAIL  cert  could not parse the expiry date: $enddate" >&2
  exit 2
fi

days_left=$(( (end_epoch - $(date +%s)) / 86400 ))

if [ "$days_left" -lt "$MIN_DAYS" ]; then
  echo "FAIL  cert  $DOMAIN expires in ${days_left}d (threshold ${MIN_DAYS}d)" >&2
  echo "            Caddy renews around 30d out, so this means renewal has" >&2
  echo "            been failing for a while. Check the DNS result above and:" >&2
  echo "              docker compose -p $PROJECT --profile proxy logs --tail=100 caddy" >&2
  failed=1
else
  echo "ok    cert  $DOMAIN valid for ${days_left}d"
fi

exit "$failed"
