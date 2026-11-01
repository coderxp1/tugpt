#!/usr/bin/env sh
#
# deploy/caddy/check-cert.test.sh
#
# Tests for deploy/caddy/check-cert.sh.
#
# check-cert.sh shipped with shellcheck and no execution, which is the same
# mistake deploy/check-host.test.sh exists to prevent one level down: a checker
# whose green output is trusted, and which nobody has ever watched fail. It is
# run once a week by cron on a box where the consequence of a wrong answer is a
# silent certificate expiry, so "it looked right" is not enough.
#
# check-cert.sh needs no test seams. It resolves docker, openssl and date
# through PATH, so a fixture directory in front of PATH is the whole harness.
# `date` is deliberately NOT stubbed: the arithmetic under test is real date
# arithmetic, and the fixtures generate expiry timestamps relative to now.
#
# Run:  sh deploy/caddy/check-cert.test.sh
# Exit: 0 all assertions passed, 1 otherwise.

# The stub bodies below are single-quoted on purpose: they are shell source
# written to a file and run later, so $1/$@ must reach the stub unexpanded.
# shellcheck disable=SC2016

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SUT="$HERE/check-cert.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0
CASE=""

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  [%s] %s\n' "$CASE" "$1"; }

squash() { printf '%s\n' "$1" | tr -s ' \t' ' '; }

assert_has() {
  # `--` matters: several expected strings begin with a dash (remediation
  # commands), and grep would read them as options.
  if squash "$OUT" | grep -qF -- "$(squash "$1")"; then pass; else fail "expected output to contain: $1"; fi
}
assert_lacks() {
  if squash "$OUT" | grep -qF -- "$(squash "$1")"; then fail "expected output NOT to contain: $1"; else pass; fi
}
# Day counts are computed from the real clock, so the floor can land either
# side of a second boundary. Matching two adjacent values keeps the arithmetic
# under test without making the suite flaky.
assert_matches() {
  if squash "$OUT" | grep -qE -- "$1"; then pass; else fail "expected output to match: $1"; fi
}
assert_exit() {
  if [ "$RC" = "$1" ]; then pass; else fail "expected exit $1, got $RC"; fi
}

stub() {
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\n%s\n' "$2" > "$1"
  chmod +x "$1"
}

# --- the fixture directory -------------------------------------------------
# One docker stub and one openssl stub, both steered by FIX_* variables the
# test exports per case. Nothing else is replaced.
BIN="$WORK/bin"
mkdir -p "$BIN"

stub "$BIN/docker" 'for a in "$@"; do
  case "$a" in
    --services)
      # `ps --status running --services` lists running services, and exits 0
      # with no output when none match.
      [ "${FIX_CADDY_RUNNING:-1}" = "1" ] && echo caddy
      exit 0 ;;
    nslookup)
      exit "${FIX_DNS_RC:-0}" ;;
  esac
done
exit 0'

stub "$BIN/openssl" 'case "$1" in
  s_client) echo "-----BEGIN CERTIFICATE-----" ;;
  x509)     [ -n "${FIX_ENDDATE:-}" ] && echo "notAfter=${FIX_ENDDATE}" ;;
esac
exit 0'

# An expiry N days out, expressed the way `openssl x509 -enddate` expresses it.
enddate_in() { date -u -d "+$1 days" '+%b %e %H:%M:%S %Y GMT'; }

# Run the script under the fixture PATH, inheriting whatever FIX_* the case has
# exported. Sets OUT and RC.
run() {
  OUT=$(PATH="$BIN:$PATH" sh "$SUT" 2>&1); RC=$?
}

# =============================================================================
# Case 1 - TUGPT_DOMAIN unset. Cannot run; must say so and name the fix.
# =============================================================================
CASE="no-domain"
OUT=$(PATH="$BIN:$PATH" TUGPT_DOMAIN='' sh "$SUT" 2>&1); RC=$?

assert_exit 2
assert_has 'check-cert: TUGPT_DOMAIN is not set.'
assert_has '. /etc/tugpt/web.env'

# =============================================================================
# Case 2 - a required binary is missing. Exit 2 (could not run), never 0.
# =============================================================================
CASE="missing-openssl"
MINIMAL="$WORK/minimal"
mkdir -p "$MINIMAL"
cp "$BIN/docker" "$MINIMAL/docker"
for u in sh cut grep date tr sed; do
  command -v "$u" >/dev/null 2>&1 && ln -sf "$(command -v "$u")" "$MINIMAL/$u"
done
OUT=$(PATH="$MINIMAL" TUGPT_DOMAIN=dashboard.tugpt.pro sh "$SUT" 2>&1); RC=$?

assert_exit 2
assert_has 'check-cert: openssl is not on PATH.'

# =============================================================================
# Case 3 - caddy is not running.
#
# The ordering guarantee: the container check runs BEFORE the DNS check, so a
# stopped container reports itself and does not masquerade as a DNS fault. That
# ordering is the difference between fixing the right thing and spending an
# afternoon in /etc/resolv.conf.
# =============================================================================
CASE="caddy-stopped"
export TUGPT_DOMAIN=dashboard.tugpt.pro FIX_CADDY_RUNNING=0 FIX_DNS_RC=0
FIX_ENDDATE="$(enddate_in 89)"; export FIX_ENDDATE
run

assert_exit 1
assert_has "FAIL  caddy is not running under project 'tugpt'."
assert_has '--profile proxy up -d caddy'
assert_lacks 'cannot resolve'
assert_lacks 'dns'

# =============================================================================
# Case 4 - caddy up, container DNS broken. The silent-renewal-failure case.
# =============================================================================
CASE="dns-broken"
export FIX_CADDY_RUNNING=1 FIX_DNS_RC=1
run

assert_exit 1
assert_has 'FAIL  dns   caddy cannot resolve acme-v02.api.letsencrypt.org'
assert_has 'Renewals will fail silently until the certificate expires.'
assert_has '127.0.0.53 nameserver is the systemd-resolved stub'
# The run must CONTINUE to the certificate check rather than stopping at DNS -
# one run should give the whole picture.
assert_matches 'ok +cert +dashboard\.tugpt\.pro valid for [0-9]+d'

# =============================================================================
# Case 5 - everything healthy.
# =============================================================================
CASE="healthy"
export FIX_CADDY_RUNNING=1 FIX_DNS_RC=0
FIX_ENDDATE="$(enddate_in 89)"; export FIX_ENDDATE
run

assert_exit 0
assert_has 'ok    dns   caddy resolves acme-v02.api.letsencrypt.org'
assert_matches 'ok +cert +dashboard\.tugpt\.pro valid for (88|89)d'
assert_lacks 'FAIL'

# =============================================================================
# Case 6 - certificate inside the warning window. Caddy renews around 30d out,
# so under 21d means renewal has already been failing for a week or more.
# =============================================================================
CASE="cert-expiring"
FIX_ENDDATE="$(enddate_in 10)"; export FIX_ENDDATE
run

assert_exit 1
assert_matches 'FAIL +cert +dashboard\.tugpt\.pro expires in (9|10)d \(threshold 21d\)'
assert_has 'Caddy renews around 30d out'
# DNS was fine; that must still be reported as fine.
assert_has 'ok    dns'

# =============================================================================
# Case 7 - MIN_DAYS is honoured, so the threshold is a decision and not a
# constant somebody has to edit the script to change.
# =============================================================================
CASE="min-days-override"
FIX_ENDDATE="$(enddate_in 10)"; export FIX_ENDDATE
OUT=$(PATH="$BIN:$PATH" MIN_DAYS=5 sh "$SUT" 2>&1); RC=$?

assert_exit 0
assert_matches 'ok +cert +dashboard\.tugpt\.pro valid for (9|10)d'

# =============================================================================
# Case 8 - nothing answers on :443. Not a certificate problem to guess at.
# =============================================================================
CASE="no-certificate"
export FIX_ENDDATE=""
run

assert_exit 1
assert_has 'FAIL  cert  could not read a certificate from dashboard.tugpt.pro:443'

# =============================================================================
# Case 9 - the expiry date is unparseable. Exit 2 (could not run), not 1 -
# this is the checker failing, not the certificate.
# =============================================================================
CASE="unparseable-enddate"
export FIX_ENDDATE="not-a-real-date"
run

assert_exit 2
assert_has 'FAIL  cert  could not parse the expiry date: not-a-real-date'

# =============================================================================
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
