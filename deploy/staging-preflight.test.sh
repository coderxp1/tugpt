#!/usr/bin/env sh
#
# deploy/staging-preflight.test.sh
#
# Fixture tests for deploy/staging-preflight.sh. A stub `docker`
# (injected through the script's DOCKER_CMD seam) answers the network,
# compose-render, and caddy-validate calls from fixtures; the env
# files are real temp files so the permission and isolation checks run
# for real.
#
# Cases: the all-good run passes; a staging env pointing at the
# production Supabase URL fails env-isolation; a rendered config with
# the web service on the production network fails compose-render; a
# missing edge network fails edge-network; a missing production env
# file fails BOTH env-isolation and caddy-validate (the fail-open
# regression: they used to skip, and the script could exit 0); an
# empty TUGPT_DOMAIN fails caddy-validate.
#
# Run: sh deploy/staging-preflight.test.sh   (exit 0 = all cases pass)

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PREFLIGHT="$SCRIPT_DIR/staging-preflight.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

failures=0
expect() {
    # expect <description> <wanted-exit> <actual-exit> <wanted-substring> <output>
    if [ "$2" != "$3" ]; then
        printf 'FAIL %s: exit %s, wanted %s\n' "$1" "$3" "$2"
        failures=$((failures + 1))
        return
    fi
    case "$5" in
        *"$4"*) printf 'ok   %s\n' "$1" ;;
        *)
            printf 'FAIL %s: output missing "%s"\n' "$1" "$4"
            failures=$((failures + 1))
            ;;
    esac
}

# --- stub docker -----------------------------------------------------------------
cat > "$TMP/docker-stub" <<'STUB'
#!/bin/sh
# Answers from $FIXTURE_DIR: net (ok|missing), render (good|poisoned), caddy (ok|bad)
case "$1" in
    network)
        [ "$(cat "$FIXTURE_DIR/net")" = "ok" ]
        ;;
    compose)
        cat "$FIXTURE_DIR/render-$(cat "$FIXTURE_DIR/render").yml"
        ;;
    run)
        [ "$(cat "$FIXTURE_DIR/caddy")" = "ok" ]
        ;;
    *)
        echo "stub: unexpected args: $*" >&2
        exit 2
        ;;
esac
STUB
chmod +x "$TMP/docker-stub"

# --- rendered-config fixtures -------------------------------------------------------
cat > "$TMP/render-good.yml" <<'YAML'
services:
  web:
    image: tugpt-web-staging
    restart: "no"
    networks:
      staging-edge:
        aliases:
          - staging-web
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 3000
        published: "3002"
YAML
cat > "$TMP/render-poisoned.yml" <<'YAML'
services:
  web:
    image: tugpt-web-staging
    restart: "no"
    networks:
      tugpt:
        aliases:
          - staging-web
    ports:
      - mode: ingress
        target: 3000
        published: "3002"
YAML
cat > "$TMP/render-extraport.yml" <<'YAML'
services:
  web:
    image: tugpt-web-staging
    restart: "always"
    networks:
      staging-edge:
        aliases:
          - staging-web
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 3000
        published: "3002"
      - mode: ingress
        host_ip: 127.0.0.1
        target: 3000
        published: "3003"
YAML

# --- env fixtures -------------------------------------------------------------------
printf 'NEXT_PUBLIC_SUPABASE_URL=https://prodref.supabase.co\nTUGPT_DOMAIN=tugpt.app\n' > "$TMP/prod.env"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://stagingref.supabase.co\n' > "$TMP/staging.env"
chmod 600 "$TMP/staging.env"

run_case() {
    FIXTURE_DIR="$TMP" DOCKER_CMD="$TMP/docker-stub" \
    STAGING_ENV_FILE="$TMP/staging.env" PROD_ENV_FILE="${PROD_ENV_OVERRIDE:-$TMP/prod.env}" \
    CHECKOUT_DIR="$TMP" \
        sh "$PREFLIGHT" 2>&1
}

# Case 1: everything correct.
printf 'ok\n' > "$TMP/net"; printf 'good\n' > "$TMP/render"; printf 'ok\n' > "$TMP/caddy"
out=$(run_case); rc=$?
expect "all-good passes" 0 "$rc" "all checks passed" "$out"

# Case 2: staging env points at the production project.
printf 'NEXT_PUBLIC_SUPABASE_URL=https://prodref.supabase.co\n' > "$TMP/staging.env"
chmod 600 "$TMP/staging.env"
out=$(run_case); rc=$?
expect "same Supabase URL fails env-isolation" 1 "$rc" "FAIL env-isolation" "$out"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://stagingref.supabase.co\n' > "$TMP/staging.env"
chmod 600 "$TMP/staging.env"

# Case 3: rendered config puts web on the production network.
printf 'poisoned\n' > "$TMP/render"
out=$(run_case); rc=$?
expect "production network in render fails compose-render" 1 "$rc" "FAIL compose-render" "$out"
printf 'good\n' > "$TMP/render"

# Case 4: edge network missing.
printf 'missing\n' > "$TMP/net"
out=$(run_case); rc=$?
expect "missing edge network fails edge-network" 1 "$rc" "FAIL edge-network" "$out"
printf 'ok\n' > "$TMP/net"

# Case 5: an extra published port (and a non-"no" restart policy) in the render.
printf 'extraport\n' > "$TMP/render"
out=$(run_case); rc=$?
expect "extra published port fails compose-render" 1 "$rc" "FAIL compose-render" "$out"
printf 'good\n' > "$TMP/render"

# Case 6: Caddyfile does not validate.
printf 'bad\n' > "$TMP/caddy"
out=$(run_case); rc=$?
expect "invalid Caddyfile fails caddy-validate" 1 "$rc" "FAIL caddy-validate" "$out"
printf 'ok\n' > "$TMP/caddy"

# Case 7: staging env file with loose permissions.
chmod 644 "$TMP/staging.env"
out=$(run_case); rc=$?
expect "world-readable staging env fails env-file" 1 "$rc" "FAIL env-file" "$out"
chmod 600 "$TMP/staging.env"

# Case 8: staging env file missing entirely.
mv "$TMP/staging.env" "$TMP/staging.env.away"
out=$(run_case); rc=$?
expect "missing staging env fails env-file" 1 "$rc" "FAIL env-file" "$out"
mv "$TMP/staging.env.away" "$TMP/staging.env"

# Case 9: production env file missing. Regression test for the
# fail-open defect: env-isolation and caddy-validate used to SKIP
# here, letting the script exit 0 with two critical checks unrun.
# Both must now FAIL and the script must exit non-zero.
PROD_ENV_OVERRIDE="$TMP/prod-missing.env"
out=$(run_case); rc=$?
expect "missing production env fails env-isolation (no skip)" 1 "$rc" "FAIL env-isolation" "$out"
expect "missing production env fails caddy-validate (no skip)" 1 "$rc" "FAIL caddy-validate" "$out"
case "$out" in
    *"all checks passed"*)
        printf 'FAIL missing production env must never report success\n'
        failures=$((failures + 1))
        ;;
    *) printf 'ok   missing production env never reports success\n' ;;
esac
unset PROD_ENV_OVERRIDE

# Case 10: production env file present but TUGPT_DOMAIN missing —
# caddy-validate must FAIL (validation cannot run), not skip or pass.
printf 'NEXT_PUBLIC_SUPABASE_URL=https://prodref.supabase.co\n' > "$TMP/prod-nodomain.env"
PROD_ENV_OVERRIDE="$TMP/prod-nodomain.env"
out=$(run_case); rc=$?
expect "empty TUGPT_DOMAIN fails caddy-validate" 1 "$rc" "FAIL caddy-validate" "$out"
unset PROD_ENV_OVERRIDE

if [ "$failures" -gt 0 ]; then
    printf 'staging-preflight.test: %s case(s) FAILED\n' "$failures"
    exit 1
fi
printf 'staging-preflight.test: all cases passed\n'
exit 0
