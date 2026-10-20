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
    FIXTURE_DIR="$TMP" DOCKER_CMD="$TMP/docker-stub" CHECKOUT_DIR="$TMP" \
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

if [ "$failures" -gt 0 ]; then
    printf 'staging-rollback.test: %s case(s) FAILED\n' "$failures"
    exit 1
fi
printf 'staging-rollback.test: all cases passed\n'
exit 0
