#!/usr/bin/env sh
#
# deploy/staging-rollback.test.sh
#
# Fixture tests for deploy/staging-rollback.sh, against a stub docker
# injected through the DOCKER_CMD seam. The stub logs every call, so
# the cases can assert the property that matters most: the only
# lifecycle command issued is `down` against project tugpt-staging,
# and the production project is only ever *read* (ps).
#
# Cases: happy path (staging removed, production running, call log
# clean); staging containers surviving `down` fails staging-gone;
# production not running fails production-running.
#
# Run: sh deploy/staging-rollback.test.sh   (exit 0 = all cases pass)

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROLLBACK="$SCRIPT_DIR/staging-rollback.sh"
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
# State files in $FIXTURE_DIR: staging_left (empty|some), prod (up|down).
cat > "$TMP/docker-stub" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$FIXTURE_DIR/calls.log"
case "$*" in
    "compose -p tugpt-staging -f docker-compose.yml -f docker-compose.staging.yml down")
        exit 0
        ;;
    "ps -aq --filter label=com.docker.compose.project=tugpt-staging")
        [ "$(cat "$FIXTURE_DIR/staging_left")" = "some" ] && printf 'abc123\n'
        exit 0
        ;;
    "ps -q --filter label=com.docker.compose.project=tugpt")
        [ "$(cat "$FIXTURE_DIR/prod")" = "up" ] && printf 'def456\n'
        exit 0
        ;;
    *)
        echo "stub: unexpected args: $*" >&2
        exit 2
        ;;
esac
STUB
chmod +x "$TMP/docker-stub"

run_case() {
    : > "$TMP/calls.log"
    FIXTURE_DIR="$TMP" TUGPT_STAGING_ROLLBACK_TEST_SEAMS=1 \
    DOCKER_CMD="$TMP/docker-stub" CHECKOUT_DIR="$TMP" \
        sh "$ROLLBACK" 2>&1
}

# Case 1: happy path.
printf 'empty\n' > "$TMP/staging_left"; printf 'up\n' > "$TMP/prod"
out=$(run_case); rc=$?
expect "rollback succeeds when staging clears and production runs" 0 "$rc" "production verified running" "$out"
# The call log must show exactly one lifecycle command, against staging only.
if grep -q 'compose -p tugpt-staging .* down' "$TMP/calls.log" \
    && ! grep -qE 'compose -p tugpt( | .* (down|up|stop|rm|kill|restart))' "$TMP/calls.log"; then
    printf 'ok   only lifecycle command targets tugpt-staging\n'
else
    printf 'FAIL call log shows an unexpected lifecycle command:\n'
    cat "$TMP/calls.log"
    failures=$((failures + 1))
fi

# Case 2: staging containers survive down.
printf 'some\n' > "$TMP/staging_left"
out=$(run_case); rc=$?
expect "surviving staging containers fail staging-gone" 1 "$rc" "FAIL staging-gone" "$out"
printf 'empty\n' > "$TMP/staging_left"

# Case 3: production not running.
printf 'down\n' > "$TMP/prod"
out=$(run_case); rc=$?
expect "production down fails production-running" 1 "$rc" "FAIL production-running" "$out"
printf 'up\n' > "$TMP/prod"

# Case 4: inherited-environment redirection, WITHOUT the test opt-in.
# An "evil" DOCKER_CMD that would record its own invocation, plus
# poisoned DOCKER_HOST / DOCKER_CONTEXT / CHECKOUT_DIR. In real-use
# mode the script must ignore all of it: the evil binary is never
# executed, and the script talks to the real docker CLI (absent in
# this sandbox, so the run fails closed rather than succeeding).
cat > "$TMP/docker-evil" <<'EVIL'
#!/bin/sh
printf 'evil docker invoked: %s\n' "$*" >> "$FIXTURE_DIR/evil.log"
exit 0
EVIL
chmod +x "$TMP/docker-evil"
rm -f "$TMP/evil.log"
out=$(FIXTURE_DIR="$TMP" DOCKER_CMD="$TMP/docker-evil" \
    DOCKER_HOST="tcp://127.0.0.1:9999" DOCKER_CONTEXT="evil" \
    CHECKOUT_DIR="/nonexistent-dir" \
    sh "$ROLLBACK" 2>&1); rc=$?
if [ -e "$TMP/evil.log" ]; then
    printf 'FAIL inherited DOCKER_CMD was executed in real-use mode\n'
    failures=$((failures + 1))
else
    printf 'ok   inherited DOCKER_CMD is ignored in real-use mode\n'
fi
if [ "$rc" = "0" ]; then
    printf 'FAIL real-use run with no real docker must not report success\n'
    failures=$((failures + 1))
else
    printf 'ok   real-use run fails closed without a real docker\n'
fi
case "$out" in
    *"test seams enabled"*)
        printf 'FAIL test seams reported enabled without the opt-in\n'
        failures=$((failures + 1))
        ;;
    *) printf 'ok   test seams stay off without the opt-in\n' ;;
esac

# Case 5: hostile PATH, real-use mode. A directory containing an evil
# `docker` is prepended to PATH. The script pins its own PATH before
# resolving any command, so the evil binary must never run; with no
# real docker in this sandbox the run fails closed.
mkdir -p "$TMP/evilbin"
cat > "$TMP/evilbin/docker" <<'EVIL'
#!/bin/sh
printf 'evil PATH docker invoked: %s\n' "$*" >> "$FIXTURE_DIR/evil-path.log"
exit 0
EVIL
chmod +x "$TMP/evilbin/docker"
rm -f "$TMP/evil-path.log"
out=$(FIXTURE_DIR="$TMP" PATH="$TMP/evilbin:/usr/bin:/bin" \
    /bin/sh "$ROLLBACK" 2>&1); rc=$?
if [ -e "$TMP/evil-path.log" ]; then
    printf 'FAIL docker resolved through the inherited PATH in real-use mode\n'
    failures=$((failures + 1))
else
    printf 'ok   hostile PATH cannot redirect docker in real-use mode\n'
fi
if [ "$rc" = "0" ]; then
    printf 'FAIL hostile-PATH real-use run must not report success without a real docker\n'
    failures=$((failures + 1))
else
    printf 'ok   hostile-PATH run fails closed\n'
fi

if [ "$failures" -gt 0 ]; then
    printf 'staging-rollback.test: %s case(s) FAILED\n' "$failures"
    exit 1
fi
printf 'staging-rollback.test: all cases passed\n'
exit 0
