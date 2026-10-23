#!/usr/bin/env sh
#
# deploy/staging-preflight.sh
#
# The staging deployment gate, as something that runs.
#
# The staging hosting plan (and PR #9) name three validations that must
# pass on the host before the staging stack is started for the first
# time: the merged Compose configuration must render as intended, the
# Caddyfile must validate, and staging must be provably isolated from
# production's environment. As prose, each of those is a step a tired
# operator can skim. This script performs them and exits non-zero if
# any one fails, so the deploy procedure can chain on its exit code.
#
# It changes nothing on the host. It reads two env files' *values* only
# to compare one field (the Supabase URL) for equality; no value is
# ever printed. Every check either passes or fails — there are no
# skips: a check that cannot run (a missing file, an empty value) is
# a failed check, because a gate that can be bypassed by absence is
# not a gate.
#
# Checks:
#   env-file       /etc/tugpt-staging/web.env exists, mode 600, root-owned
#   env-isolation  staging's Supabase URL is set and differs from
#                  production's — the practical tripwire against
#                  pointing staging at the production database project
#   edge-network   the tugpt-staging-edge network exists (created once
#                  by hand at deploy time; this script never creates it)
#   compose-render the merged staging config renders, and the web
#                  service is exactly as designed: staging-edge network
#                  only (never the production `tugpt` network), one
#                  published port, loopback 3002 only, restart "no",
#                  and the resource limits from the reviewed override
#                  (cpus "1.0", memory 1 GiB) present in the render
#   caddy-validate the checkout's Caddyfile validates under the caddy
#                  image, with production's TUGPT_DOMAIN
#
# Usage (on the host, from the staging checkout, as root):
#
#   sudo sh deploy/staging-preflight.sh
#
# Invoked as `sh <path>` rather than `./<path>`, like check-host.sh:
# the executable bit does not survive every path this file travels.
#
# Exit codes: 0 nothing failed, 1 at least one FAIL, 2 could not run.
#
# deploy/staging-preflight.test.sh exercises these checks against
# fixtures. Run it after changing anything below.

set -u   # deliberately NOT -e: one failing check must not end the run

# --- environment hardening -----------------------------------------------------
# In real use this gate runs against exactly the production layout:
# the system docker binary (resolved through a pinned PATH), the
# checkout this script ships in, and the two canonical env-file
# paths. Inherited DOCKER_CMD / CHECKOUT_DIR / STAGING_ENV_FILE /
# PROD_ENV_FILE values are discarded, and Docker's own target
# variables (DOCKER_HOST / DOCKER_CONTEXT / DOCKER_CONFIG) are
# unset, so no inherited environment can redirect what is being
# validated or where the validation points.
#
# The seams survive only behind the explicit test opt-in
# (TUGPT_STAGING_PREFLIGHT_TEST_SEAMS=1), which the fixture test sets
# and which prints a warning when active. It is never set by the
# runbook invocation, and there is no reason to set it on the host.
if [ "${TUGPT_STAGING_PREFLIGHT_TEST_SEAMS:-}" = "1" ]; then
    printf 'staging-preflight: WARNING: test seams enabled; not for host use\n' >&2
    # Each is a command line, word-split on use.
    DOCKER_CMD=${DOCKER_CMD:-docker}
    STAGING_ENV_FILE=${STAGING_ENV_FILE:-/etc/tugpt-staging/web.env}
    PROD_ENV_FILE=${PROD_ENV_FILE:-/etc/tugpt/web.env}
    CHECKOUT_DIR=${CHECKOUT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
else
    unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    DOCKER_CMD=docker
    STAGING_ENV_FILE=/etc/tugpt-staging/web.env
    PROD_ENV_FILE=/etc/tugpt/web.env
    CHECKOUT_DIR=$(cd "$(dirname "$0")/.." && pwd)
fi

fails=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; fails=$((fails + 1)); }

# env_value FILE KEY -> prints the value of KEY=... (last assignment wins).
# The caller must treat the result as a secret: compare, never print.
env_value() {
    grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

# --- env-file ----------------------------------------------------------------
if [ ! -f "$STAGING_ENV_FILE" ]; then
    fail env-file "$STAGING_ENV_FILE does not exist; staging secrets are not provisioned (that is a separate approval gate)"
else
    mode=$(stat -c '%a' "$STAGING_ENV_FILE" 2>/dev/null || echo '?')
    owner=$(stat -c '%U' "$STAGING_ENV_FILE" 2>/dev/null || echo '?')
    if [ "$mode" = "600" ] && [ "$owner" = "root" ]; then
        pass env-file
    else
        fail env-file "$STAGING_ENV_FILE is mode $mode owner $owner; expected 600 root (production env files are held to the same rule)"
    fi
fi

# --- env-isolation -------------------------------------------------------------
# Fail-closed by design: if either file is missing, the comparison
# cannot be made, and an unverifiable isolation is a FAILED isolation
# — never a skip. (The first revision skipped here, which let the
# script exit 0 with this check and caddy-validate unrun when the
# production env file was absent. That was a fail-open defect; the
# fixture test now covers it.)
if [ ! -f "$STAGING_ENV_FILE" ]; then
    fail env-isolation "staging env file is missing, so its Supabase URL cannot be compared against production's"
elif [ ! -f "$PROD_ENV_FILE" ]; then
    fail env-isolation "$PROD_ENV_FILE is missing, so the staging Supabase URL cannot be compared against production's"
else
    staging_url=$(env_value "$STAGING_ENV_FILE" NEXT_PUBLIC_SUPABASE_URL)
    prod_url=$(env_value "$PROD_ENV_FILE" NEXT_PUBLIC_SUPABASE_URL)
    if [ -z "$staging_url" ]; then
        fail env-isolation "NEXT_PUBLIC_SUPABASE_URL is empty in the staging env file"
    elif [ -z "$prod_url" ]; then
        fail env-isolation "NEXT_PUBLIC_SUPABASE_URL is empty in the production env file, so there is no production value to differ from; isolation is unverifiable"
    elif [ "$staging_url" = "$prod_url" ]; then
        fail env-isolation "staging's Supabase URL is IDENTICAL to production's; staging must use its own Supabase project"
    else
        pass env-isolation
    fi
fi

# --- edge-network ---------------------------------------------------------------
# Word-splitting of $DOCKER_CMD is the documented test seam.
# shellcheck disable=SC2086
if $DOCKER_CMD network inspect tugpt-staging-edge >/dev/null 2>&1; then
    pass edge-network
else
    fail edge-network "network tugpt-staging-edge does not exist; create it once (docker network create tugpt-staging-edge) BEFORE starting anything, production included — the base compose file explains why"
fi

# --- compose-render --------------------------------------------------------------
rendered=$(
    cd "$CHECKOUT_DIR" || exit 1
    # shellcheck disable=SC2086
    $DOCKER_CMD compose -p tugpt-staging \
        -f docker-compose.yml -f docker-compose.staging.yml config 2>/dev/null
) || rendered=""
if [ -z "$rendered" ]; then
    fail compose-render "docker compose config did not render; run it by hand in $CHECKOUT_DIR and read the error"
else
    # The web service's block: from its two-space key to the next one.
    web_block=$(printf '%s\n' "$rendered" | awk '
        /^  web:/ { in_web = 1; print; next }
        /^  [a-z]/ { in_web = 0 }
        in_web { print }
    ')
    render_fails=0
    # The network set must be EXACTLY {staging-edge}: presence of
    # staging-edge plus absence of tugpt (the first revision's checks)
    # would still admit any other additional network. Extract the
    # keys of web's networks mapping and compare the whole set.
    nets=$(printf '%s\n' "$web_block" | awk '
        /^    networks:/ { in_nets = 1; next }
        /^    [a-z]/ { in_nets = 0 }
        in_nets && /^      [^ ]/ {
            line = $0
            sub(/^      /, "", line)
            sub(/:.*/, "", line)
            print line
        }
    ')
    nets_joined=$(printf '%s' "$nets" | tr '\n' ' ')
    nets_joined=${nets_joined% }
    if [ "$nets_joined" != "staging-edge" ]; then
        fail compose-render "web is attached to networks [$nets_joined]; expected exactly [staging-edge]"
        render_fails=1
    fi
    published_count=$(printf '%s\n' "$web_block" | grep -c 'published:' || true)
    if [ "$published_count" != "1" ]; then
        fail compose-render "web publishes $published_count ports in the rendered config; expected exactly 1"
        render_fails=1
    fi
    if ! printf '%s\n' "$web_block" | grep -q 'host_ip: 127.0.0.1'; then
        fail compose-render "web's published port is not bound to 127.0.0.1 in the rendered config"
        render_fails=1
    fi
    if ! printf '%s\n' "$web_block" | grep -q 'published: "3002"'; then
        fail compose-render "web's published port is not 3002 in the rendered config"
        render_fails=1
    fi
    if ! printf '%s\n' "$web_block" | grep -q 'restart: "no"'; then
        fail compose-render "web's restart policy is not \"no\" in the rendered config"
        render_fails=1
    fi
    # The resource limits are part of the reviewed staging design
    # (docker-compose.staging.yml: cpus "1.0", memory 1G). Assert them
    # in the RENDER rather than trusting the override file's text: a
    # render without them means the override was dropped or edited,
    # and staging must not start unbounded on the production host.
    # Compose renders 1G as 1073741824 bytes; accept either form.
    if ! printf '%s\n' "$web_block" | grep -q 'cpus: "1.0"'; then
        fail compose-render "web's cpu limit is not \"1.0\" in the rendered config; the reviewed resource limits are missing or changed"
        render_fails=1
    fi
    if ! printf '%s\n' "$web_block" | grep -qE 'memory: "?1073741824"?|memory: "1G"'; then
        fail compose-render "web's memory limit is not 1G in the rendered config; the reviewed resource limits are missing or changed"
        render_fails=1
    fi
    [ "$render_fails" = "0" ] && pass compose-render
fi

# --- caddy-validate ---------------------------------------------------------------
# Fail-closed like env-isolation: without the production env file
# there is no TUGPT_DOMAIN to validate under, and an empty domain is
# not a validation — both are failures, not skips.
if [ ! -f "$PROD_ENV_FILE" ]; then
    fail caddy-validate "$PROD_ENV_FILE is missing, so TUGPT_DOMAIN is unknown and the Caddyfile cannot be validated"
else
    domain=$(env_value "$PROD_ENV_FILE" TUGPT_DOMAIN)
    if [ -z "$domain" ]; then
        fail caddy-validate "TUGPT_DOMAIN is empty in $PROD_ENV_FILE, so the Caddyfile cannot be validated"
    else
        # Word-splitting of $DOCKER_CMD is the documented test seam.
        # shellcheck disable=SC2086
        if $DOCKER_CMD run --rm -e "TUGPT_DOMAIN=$domain" \
            -v "$CHECKOUT_DIR/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
            caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
            pass caddy-validate
        else
            fail caddy-validate "the checkout's Caddyfile does not validate; do not load it into the running Caddy"
        fi
    fi
fi

# --- summary ------------------------------------------------------------------------
if [ "$fails" -gt 0 ]; then
    printf 'staging-preflight: %s check(s) FAILED — do not start the staging stack.\n' "$fails"
    exit 1
fi
printf 'staging-preflight: all checks passed.\n'
exit 0
