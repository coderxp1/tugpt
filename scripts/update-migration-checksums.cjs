#!/usr/bin/env node
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: runs with plain `node`, no build, no dependencies (CI job and contributors). */
/**
 * Records checksums for NEW migrations in supabase/migrations/checksums.json.
 * It refuses (exit 1) to re-record an edited migration or to drop the entry of a deleted one:
 * applied migrations are immutable, and a correction is a new migration with a new id.
 * Thin wrapper over scripts/migration-integrity.cjs (one implementation).
 */
const { run } = require('./migration-integrity.cjs');
const r = run(['update', ...process.argv.slice(2)]);
for (const l of r.lines) (r.code ? console.error : console.log)(l);
process.exit(r.code);
