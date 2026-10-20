#!/usr/bin/env sh
#
# deploy/staging-rollback.sh
#
# Remove the staging stack, and prove production was not touched.
#
# Rollback for staging is deliberately boring: the staging project
# stops and is removed, and that is all this script does to the
# system. The Compose project name is hard-coded — the script takes
# no arguments, so there is no way to aim it at the production
# project (`tugpt`) from the command line.
#
# What it deliberately does NOT do:
#   - It never starts, stops, or reconfigures the production project.
#     After the staging teardown it *reads* production's container
#     list; if production is not running, the script fails loudly —
#     not because it touched production, but because a rollback that
#     ends with production down must not report success.
#   - It does not edit the Caddyfile or reload Caddy. Removing the
#     staging site block is a reviewed repo change followed by a
#     reload (staging runbook); an unreviewed live edit from a
#     rollback script is how production blocks get damaged.
#   - It does not remove the tugpt-staging-edge network. Production's
#     Caddy is attached to it (that attachment lives in the base
#     compose file), so removing the network is a repo change first,
#     not a rollback step.
#   - It does not remove /etc/tugpt-staging, the staging checkout, or
#     any data. Rollback is reversible; deletion is a separate,
#     explicitly approved cleanup.
#
# Usage (on the host, from the staging checkout, as root):
#
#   sudo sh deploy/staging-rollback.sh
#
# Exit codes: 0 staging removed and production verified running,
# 1 a verification failed, 2 the script could not run.
#
# deploy/staging-rollback.test.sh exercises it against a stub docker.
# Run that after changing anything below.

set -u   # deliberately NOT -e: every verification runs and reports

# --- test seam ---------------------------------------------------------------
DOCKER_CMD=${DOCKER_CMD:-docker}
CHECKOUT_DIR=${CHECKOUT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}

fails=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; fails=$((fails + 1)); }

if [ $# -ne 0 ]; then
    printf 'staging-rollback: takes no arguments (the project name is fixed by design)\n' >&2
    exit 2
fi

# --- teardown (staging project only) -------------------------------------------
cd "$CHECKOUT_DIR" || exit 2
# Word-splitting of $DOCKER_CMD is the documented test seam.
# shellcheck disable=SC2086
if $DOCKER_CMD compose -p tugpt-staging \
    -f docker-compose.yml -f docker-compose.staging.yml \
    down >/dev/null 2>&1; then
    pass teardown
else
    fail teardown "docker compose down for project tugpt-staging returned an error; read its output by running it by hand"
fi

# --- verify: nothing of staging remains -----------------------------------------
# shellcheck disable=SC2086
remaining=$($DOCKER_CMD ps -aq --filter label=com.docker.compose.project=tugpt-staging 2>/dev/null || echo '?')
if [ -z "$remaining" ]; then
    pass staging-gone
elif [ "$remaining" = "?" ]; then
    fail staging-gone "could not list containers to verify the teardown"
else
    fail staging-gone "containers belonging to tugpt-staging still exist after down"
fi

# --- verify: production untouched and running ------------------------------------
# Read-only. This script never issues a lifecycle command to project tugpt.
# shellcheck disable=SC2086
prod_running=$($DOCKER_CMD ps -q --filter label=com.docker.compose.project=tugpt 2>/dev/null || echo '?')
if [ -n "$prod_running" ] && [ "$prod_running" != "?" ]; then
    pass production-running
elif [ "$prod_running" = "?" ]; then
    fail production-running "could not list production containers to verify state"
else
    fail production-running "NO production containers are running. This script issued no command to the production project; production being down is a separate incident — do not treat this rollback as complete until it is understood"
fi

if [ "$fails" -gt 0 ]; then
    printf 'staging-rollback: %s verification(s) FAILED.\n' "$fails"
    exit 1
fi
printf 'staging-rollback: staging removed; production verified running and untouched.\n'
printf 'Remaining manual steps (runbook): remove the staging Caddy block via a reviewed repo change and reload Caddy; remove the staging DNS record if it was created.\n'
exit 0
