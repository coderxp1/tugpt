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
# missing edge network fails edge-network.
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

# --- env fixtures -------------------------------------------------------------------
printf 'NEXT_PUBLIC_SUPABASE_URL=https://prodref.supabase.co\nTUGPT_DOMAIN=tugpt.app\n' > "$TMP/prod.env"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://stagingref.supabase.co\n' > "$TMP/staging.env"
chmod 600 "$TMP/staging.env"

run_case() {
    FIXTURE_DIR="$TMP" DOCKER_CMD="$TMP/docker-stub" \
    STAGING_ENV_FILE="$TMP/staging.env" PROD_ENV_FILE="$TMP/prod.env" \
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

if [ "$failures" -gt 0 ]; then
    printf 'staging-preflight.test: %s case(s) FAILED\n' "$failures"
    exit 1
fi
printf 'staging-preflight.test: all cases passed\n'
exit 0
