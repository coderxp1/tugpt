#!/usr/bin/env bash
#
# deploy/workspace-q9c-preflight.test.sh
#
# Tests deploy/workspace-q9c-preflight.sql against a DISPOSABLE database that
# HAS the Q-9c migrations. Every mutation (drop a function, revoke the
# sso_control membership) happens inside a transaction that is never
# committed: the preflight's failure aborts the session, so it rolls back.
# Never point this at a shared or production database.
#
#   PREFLIGHT_TEST_DISPOSABLE=yes \
#   PREFLIGHT_TEST_PSQL='docker exec -i -e PGPASSWORD=... tugpt-a4-pg-NAME psql -X -q -h 127.0.0.1 -U postgres -d postgres' \
#   deploy/workspace-q9c-preflight.test.sh
set -uo pipefail
[ "${PREFLIGHT_TEST_DISPOSABLE:-}" = yes ] || { echo "refusing: set PREFLIGHT_TEST_DISPOSABLE=yes (disposable databases only)"; exit 2; }
[ -n "${PREFLIGHT_TEST_PSQL:-}" ] || { echo "PREFLIGHT_TEST_PSQL is required"; exit 2; }
SQL=$(cd "$(dirname "$0")" && pwd)/workspace-q9c-preflight.sql
read -r -a PSQL <<< "$PREFLIGHT_TEST_PSQL"
pass=0; fail=0

# expect NAME WANT_EXIT(0|nonzero) PATTERN PHASE [PRELUDE_SQL]
expect() {
  local name=$1 want=$2 pattern=$3 phase=$4 prelude=${5:-} out rc
  out=$( { [ -n "$prelude" ] && printf 'BEGIN;\n%s\nSET transaction_read_only = on;\n' "$prelude"; cat "$SQL"; } \
    | "${PSQL[@]}" -v ON_ERROR_STOP=1 -v phase="$phase" 2>&1 ); rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = nonzero ] && [ $rc -ne 0 ]; }; then
    if printf '%s' "$out" | grep -qF -- "$pattern"; then pass=$((pass+1)); echo "ok - $name"; return; fi
  fi
  fail=$((fail+1)); echo "not ok - $name (exit $rc)"; printf '%s\n' "$out" | tail -4 | sed 's/^/  /'
}

expect 'after: a complete Q-9c database passes' 0 'preflight (after): all checks passed' after
expect 'before: an already migrated database is reported, not re-applied' nonzero 'FAIL Q-9c not applied yet (already applied: run phase=after)' before
expect 'partial apply fails in the after phase' nonzero 'FAIL Q-9c functions are all present or all absent (no partial apply) (3/4 present)' after \
  'DROP FUNCTION public.chat_message_citations(uuid, uuid, uuid[]);'
expect 'partial apply fails in the before phase' nonzero 'FAIL Q-9c functions are all present or all absent (no partial apply) (3/4 present)' before \
  'DROP FUNCTION public.custom_agent_run_instructions(uuid, uuid, uuid);'
expect 'missing sso_control membership fails' nonzero 'FAIL authenticator is a member of sso_control' after \
  'REVOKE sso_control FROM authenticator;'
expect 'a reopened column grant fails' nonzero 'FAIL authenticated cannot SELECT custom_agents.instructions or chat_messages.citations' after \
  'GRANT SELECT (instructions) ON public.custom_agents TO authenticated;'
expect 'an invalid phase is rejected' nonzero 'phase must be before or after' during

# The read-only probe: the same checks in a read-write session must refuse to run.
out=$(sed '/^SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;$/d' "$SQL" | "${PSQL[@]}" -v ON_ERROR_STOP=1 -v phase=after 2>&1); rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qF 'session is not read-only; refusing to run'; then pass=$((pass+1)); echo "ok - a read-write session is refused"
else fail=$((fail+1)); echo "not ok - a read-write session is refused (exit $rc)"; fi

# Nothing above may have persisted.
expect 'database unchanged afterwards' 0 'preflight (after): all checks passed' after
echo "# workspace-q9c-preflight: $pass passed, $fail failed"
[ $fail -eq 0 ]
