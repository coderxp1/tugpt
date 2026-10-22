/**
 * Outbound log hygiene — a structural guard, in the same style as
 * outbound-gate.test.ts.
 *
 * The outbound path handles three things that must never reach a
 * log line: the customer's message body, the recipient's phone
 * number, and the Meta access token. The worker code was inspected
 * when written (the sender's errors carry only an HTTP status; the
 * worker itself does not log; the entrypoint logs batch counts).
 * This test keeps that true under future edits: any line in the
 * outbound sources that writes to a log must not reference the
 * sensitive values.
 *
 * Scope note: this scans log STATEMENTS, not the whole file — the
 * body and token legitimately exist as variables passed to the
 * sender. What is forbidden is putting them in a log call.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const OUTBOUND_SOURCES = [
  'whatsapp-send.ts',
  'outbound-worker.ts',
  'outbound-queue-adapter.ts',
  'outbound-index.ts',
];

const LOG_CALL = /console\.(log|info|warn|error)|logger\.(log|info|warn|error|debug)/;
const SENSITIVE = /\b(body|accessToken|token|recipientPhone|phoneNumber)\b/;

describe('outbound log hygiene', () => {
  for (const file of OUTBOUND_SOURCES) {
    it(`${file}: no log statement references message content, phone numbers, or tokens`, () => {
      const lines = readFileSync(join(srcDir, file), 'utf8').split('\n');
      const offending: string[] = [];
      lines.forEach((line, index) => {
        // A log call and its continuation lines (template strings
        // spanning lines) — check the call line plus the following
        // three lines, which covers the entrypoint's multi-line
        // console calls.
        if (LOG_CALL.test(line)) {
          const window = lines.slice(index, index + 4).join('\n');
          if (SENSITIVE.test(window)) {
            offending.push(`${file}:${index + 1}`);
          }
        }
      });
      expect(offending).toEqual([]);
    });
  }

  it('the sender builds errors from HTTP status only (no response body in error text)', () => {
    const source = readFileSync(join(srcDir, 'whatsapp-send.ts'), 'utf8');
    // The refusal error is constructed from the status code; the
    // response body is never read as text for an error message.
    expect(source).toContain('WhatsApp send refused with HTTP ${response.status}');
    expect(source).not.toMatch(/response\.text\(\)/);
  });
});
