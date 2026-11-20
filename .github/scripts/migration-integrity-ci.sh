#!/bin/sh
# Forward-only migration gate for CI (job `migration-integrity` in .github/workflows/ci.yml).
#
# Inputs arrive ONLY as environment variables set in the step's `env:` block - never interpolated into
# this script - so a crafted ref name cannot become shell:
#   EVENT_NAME    github.event_name            (pull_request | push)
#   PR_BASE_SHA   github.event.pull_request.base.sha
#   PUSH_BEFORE   github.event.before
#
# Exit 0 verified, 1 violations, 2 cannot verify. There is no "skip": an empty, malformed or unknown base
# fails the job. Requires a full-history checkout (fetch-depth: 0).
set -eu

say() { printf '%s\n' "migration-integrity: $*" >&2; }

if [ -n "${MIGRATION_INTEGRITY_ANCHOR:-}" ]; then
  say "MIGRATION_INTEGRITY_ANCHOR is a test-only override and must not be set in CI"
  exit 2
fi

case "${EVENT_NAME:-}" in
  pull_request) base="${PR_BASE_SHA:-}" ;;
  push) base="${PUSH_BEFORE:-}" ;;
  *) say "unsupported event '${EVENT_NAME:-}'"; exit 2 ;;
esac

case "$base" in
  '' ) say "no base commit for event '$EVENT_NAME'"; exit 2 ;;
  *[!0-9a-f]* ) say "base is not a lowercase hex commit id"; exit 2 ;;
esac
if [ "${#base}" -ne 40 ]; then
  say "base is not a full 40-character commit id"
  exit 2
fi

if [ "$(git rev-parse --is-shallow-repository)" != "false" ]; then
  say "shallow clone; set fetch-depth: 0 on actions/checkout"
  exit 2
fi

if [ "$base" = "0000000000000000000000000000000000000000" ]; then
  if [ "$EVENT_NAME" = "push" ]; then
    # First push of a branch: no previous tip. Verify every commit since the anchor instead.
    say "first push of this branch; verifying full history from the anchor"
    exec node scripts/migration-integrity.cjs verify --history
  fi
  say "all-zero base on a pull request"
  exit 2
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  say "base $base is not in this clone"
  exit 2
fi

if ! merge_base="$(git merge-base "$base" HEAD)"; then
  say "no merge base between $base and HEAD"
  exit 2
fi
say "base $base, merge base $merge_base"
exec node scripts/migration-integrity.cjs verify --base "$merge_base" --history
