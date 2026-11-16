/**
 * Client-side reader for the chat turn stream (NDJSON, one event per line).
 * Pure and browser-safe. Tolerates chunk boundaries anywhere (including inside
 * a multi-byte character), skips malformed lines instead of throwing, flushes
 * a final line without a trailing newline, and reports whether a terminal
 * event (done or error) arrived, so a cut-off stream is never shown as a
 * finished answer.
 */
export interface TurnStreamEvent {
  type: string;
  text?: string;
  tool?: string;
  provider?: string | null;
  ok?: boolean;
  code?: string;
  message?: unknown;
  /** approval_required only; parse with parsePendingApproval (lib/chat/approval.ts). */
  approval?: unknown;
  callId?: string;
}

export interface TurnStreamSummary { terminal: 'done' | 'error' | null; malformed: number }

function parseLine(line: string): TurnStreamEvent | null {
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') return null;
    return v as TurnStreamEvent;
  } catch { return null; }
}

export async function readTurnStream(body: ReadableStream<Uint8Array>, onEvent: (e: TurnStreamEvent) => void): Promise<TurnStreamSummary> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: TurnStreamSummary = { terminal: null, malformed: 0 };
  const handle = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    const ev = parseLine(line);
    if (!ev) { out.malformed += 1; return; }
    if (out.terminal) return; // nothing after done/error is trusted
    if (ev.type === 'done' || ev.type === 'error') out.terminal = ev.type;
    onEvent(ev);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  buf += dec.decode();
  handle(buf);
  return out;
}
