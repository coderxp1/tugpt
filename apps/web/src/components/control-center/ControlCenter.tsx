'use client';

// TuGPT Product Control Center — the visible product surface.
//
// Every number on this page comes from a real source: the health API
// (app state, env presence as booleans, catalog counts), the lab API
// (real in-process product code over fixtures), or the catalog itself
// (repository evidence). Sections that need a live database, worker,
// or provider say so instead of showing invented data. Lab runs are
// recorded in this browser session only and are labeled as such.

import { useEffect, useState } from 'react';
import {
  FEATURE_CATALOG,
  FEATURE_STATUS_LABEL,
  type CatalogEntry,
} from '@/lib/control-center/catalog';
import type { LabResult } from '@/lib/control-center/labs';

type Tab =
  | 'overview'
  | 'catalog'
  | 'tests'
  | 'whatsapp'
  | 'appointments'
  | 'voice-media'
  | 'usage'
  | 'logs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'catalog', label: 'Feature catalog' },
  { id: 'tests', label: 'Test center' },
  { id: 'whatsapp', label: 'WhatsApp lab' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'voice-media', label: 'Voice & media' },
  { id: 'usage', label: 'Usage' },
  { id: 'logs', label: 'Logs & failures' },
];

interface HealthState {
  whatsappKillSwitch: string;
  envPresence: Record<string, boolean>;
  catalogCounts: Record<string, number>;
  catalogTotal: number;
  database: { available: boolean; reason: string };
  workers: { available: boolean; reason: string };
}

interface RunRecord {
  at: string;
  test: string;
  mode: string;
  summary: string;
}

async function runLab(
  test: string,
  input: Record<string, unknown>,
): Promise<LabResult | { error: { code: string; message: string } }> {
  const res = await fetch('/api/v1/control-center/lab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ test, input }),
  });
  return res.json();
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}

function CatalogTable({ entries }: { entries: CatalogEntry[] }) {
  return (
    <table className="w-full text-left text-sm text-zinc-300">
      <thead>
        <tr className="border-b border-zinc-800 text-zinc-400">
          <th className="py-2 pr-3">Feature</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2">Reality today</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-b border-zinc-800/60 align-top">
            <td className="py-2 pr-3 font-medium text-zinc-100">{e.name}</td>
            <td className="py-2 pr-3 whitespace-nowrap">{FEATURE_STATUS_LABEL[e.status]}</td>
            <td className="py-2">{e.reality}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ControlCenter() {
  const [tab, setTab] = useState<Tab>('overview');
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [faqQuestion, setFaqQuestion] = useState('¿Cuál es el horario?');
  const [receiptState, setReceiptState] = useState('sent');
  const [receiptKind, setReceiptKind] = useState('read');
  const [apptStart, setApptStart] = useState('2026-10-27T09:00:00.000Z');
  const [apptEnd, setApptEnd] = useState('2026-10-27T17:00:00.000Z');

  useEffect(() => {
    fetch('/api/v1/control-center/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((err: unknown) => setHealthError(err instanceof Error ? err.message : 'Health fetch failed'));
  }, []);

  async function execute(test: string, input: Record<string, unknown>) {
    setRunning(true);
    setRunError(null);
    try {
      const out = await runLab(test, input);
      if ('error' in out) {
        setRunError(`${out.error.code}: ${out.error.message}`);
        setRuns((prev) => [
          { at: new Date().toISOString(), test, mode: 'error', summary: out.error.message },
          ...prev,
        ]);
      } else {
        setResult(out);
        setRuns((prev) => [
          { at: new Date().toISOString(), test, mode: out.mode, summary: out.summary },
          ...prev,
        ]);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Lab request failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 text-zinc-200">
      <h1 className="text-2xl font-bold text-zinc-50">TuGPT Product Control Center</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Baseline: main <code>e82dcecb</code> (frozen MVP). WhatsApp kill switch:{' '}
        <strong className="text-red-400">OFF</strong>. Nothing on this page sends a message,
        calls a provider, writes to a database, or spends money.
      </p>

      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Control Center sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1 text-sm ${
              tab === t.id ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-5 space-y-4">
        {tab === 'overview' && (
          <Section title="System health">
            {healthError && <p className="text-red-400">{healthError}</p>}
            {!health && !healthError && <p>Loading real state…</p>}
            {health && (
              <div className="space-y-3 text-sm">
                <p>
                  WhatsApp kill switch: <strong>{health.whatsappKillSwitch}</strong> (code
                  default; no flag rows exist).
                </p>
                <div>
                  <p className="font-medium text-zinc-100">Connected services (presence only, never values)</p>
                  <ul className="mt-1 list-disc pl-5">
                    {Object.entries(health.envPresence).map(([k, v]) => (
                      <li key={k}>
                        {k}: {v ? 'configured' : 'not configured in this environment'}
                      </li>
                    ))}
                  </ul>
                </div>
                <p>
                  Database: {health.database.available ? 'connected' : 'not connected'} —{' '}
                  {health.database.reason}
                </p>
                <p>
                  Workers: {health.workers.available ? 'running' : 'not running'} —{' '}
                  {health.workers.reason}
                </p>
                <p>
                  Feature catalog: {health.catalogTotal} entries —{' '}
                  {Object.entries(health.catalogCounts)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(', ')}
                  .
                </p>
              </div>
            )}
          </Section>
        )}

        {tab === 'catalog' && (
          <Section title="Feature catalog — what is real, what is not">
            <CatalogTable entries={FEATURE_CATALOG} />
            <p className="mt-3 text-sm text-zinc-400">
              Evidence, PRs, and next actions for each entry live in the inventory document
              delivered with this dashboard. Nothing marked “in the UI” is a mock: those pages
              and routes exist in this application.
            </p>
          </Section>
        )}

        {tab === 'tests' && (
          <Section title="Test center — run real product code over fixtures">
            <p className="mb-3 text-sm text-zinc-400">
              Each button runs production code in-process. Mode labels tell you exactly what
              ran: <em>real-in-process</em> (production function, fixture input),
              <em>simulated-provider</em> (production service, mocked external calendar), or{' '}
              <em>blocked</em> (needs a live integration that does not exist here).
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={running} onClick={() => execute('faq-retrieval', { question: faqQuestion })} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                FAQ retrieval
              </button>
              <button type="button" disabled={running} onClick={() => execute('grounded-prompt', { question: faqQuestion })} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                Grounded prompt block
              </button>
              <input value={faqQuestion} onChange={(e) => setFaqQuestion(e.target.value)} aria-label="FAQ test question" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm" />
            </div>
            {running && <p className="mt-3 text-sm">Running…</p>}
            {runError && <p className="mt-3 text-sm text-red-400">{runError}</p>}
            {result && (
              <div className="mt-4">
                <p className="text-sm font-medium">Result: {result.test} — mode: {result.mode}</p>
                <p className="mt-1 text-sm text-zinc-400">{result.summary}</p>
                <pre className="mt-2 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">
                  {JSON.stringify(result.output, null, 2)}
                </pre>
              </div>
            )}
          </Section>
        )}

        {tab === 'whatsapp' && (
          <Section title="WhatsApp lab — synthetic payloads only, nothing is sent">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={running} onClick={() => execute('whatsapp-inbound', {})} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                Parse inbound payload
              </button>
              <select value={receiptState} onChange={(e) => setReceiptState(e.target.value)} aria-label="Prior delivery state" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm">
                <option value="queued">queued</option>
                <option value="sending">sending</option>
                <option value="sent">sent</option>
              </select>
              <select value={receiptKind} onChange={(e) => setReceiptKind(e.target.value)} aria-label="Receipt kind" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm">
                <option value="delivered">delivered</option>
                <option value="read">read</option>
              </select>
              <button type="button" disabled={running} onClick={() => execute('delivery-receipts', { currentStatus: receiptState, receipt: receiptKind })} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                Apply receipt
              </button>
            </div>
            <p className="mt-3 text-sm text-zinc-400">
              Inbound parsing uses the production webhook normalizer. Receipt transitions
              illustrate the display mapping; monotonic enforcement lives in the receipt RPC
              and is proven by pgTAP, and live callbacks require a live Meta connection.
            </p>
            {result && (
              <pre className="mt-3 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">
                {JSON.stringify(result.output, null, 2)}
              </pre>
            )}
          </Section>
        )}

        {tab === 'appointments' && (
          <Section title="Appointments lab — real service, simulated calendar">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <input value={apptStart} onChange={(e) => setApptStart(e.target.value)} aria-label="Window start" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1" />
              <input value={apptEnd} onChange={(e) => setApptEnd(e.target.value)} aria-label="Window end" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1" />
              <button type="button" disabled={running} onClick={() => execute('appointments', { windowStart: apptStart, windowEnd: apptEnd, durationMinutes: 30 })} className="rounded bg-zinc-100 px-3 py-1 text-zinc-900 disabled:opacity-50">
                Find slots + store request
              </button>
            </div>
            <p className="mt-3 text-sm text-zinc-400">
              Google free/busy is NOT involved: no Google credentials exist. The lab runs the
              production AvailabilityService and store against the package&apos;s mock calendar
              provider. The database CHECK refusing CONFIRMED writes is proven by pgTAP.
            </p>
            {result && (
              <pre className="mt-3 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">
                {JSON.stringify(result.output, null, 2)}
              </pre>
            )}
          </Section>
        )}

        {tab === 'voice-media' && (
          <Section title="Voice & media — what is blocked and why">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={running} onClick={() => execute('voice-transcription', {})} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                Check transcription pipeline
              </button>
              <button type="button" disabled={running} onClick={() => execute('media-generation', {})} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
                Check media generation
              </button>
            </div>
            <p className="mt-3 text-sm text-zinc-400">
              Both return an honest blocked result: transcription needs a vault-provisioned
              Gladia key and a database; media needs a connected GPU worker and the
              media_generation flag. The media job pages at /dashboard/media exist and show
              the flag-off state; the transcription pipeline stages are worker code, not a
              runnable demo here.
            </p>
            {result && <p className="mt-3 text-sm">{result.summary}</p>}
          </Section>
        )}

        {tab === 'usage' && (
          <Section title="Usage — reliable data only">
            <button type="button" disabled={running} onClick={() => execute('usage', {})} className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 disabled:opacity-50">
              Load usage totals
            </button>
            <p className="mt-3 text-sm text-zinc-400">
              Real usage totals come from the org_usage_summary RPC and need a database
              session. In this environment that returns blocked, not zeros — zeros would be
              invented data. When Supabase is configured, /dashboard/analytics shows the
              real totals (seeded FX rate in this codebase: EUR→USD 1.1234 @ 2026-10-21).
            </p>
            {result && <p className="mt-3 text-sm">{result.summary}</p>}
          </Section>
        )}

        {tab === 'logs' && (
          <Section title="Logs & failures — this session's lab runs">
            <p className="mb-3 text-sm text-zinc-400">
              These are real records of labs executed through this page in this browser
              session — not production logs. Production worker logs live with the deployed
              workers and are not reachable from here; lab failures below carry their error
              codes and messages for diagnosis.
            </p>
            {runs.length === 0 && <p className="text-sm">No lab runs yet in this session.</p>}
            <ul className="space-y-2 text-sm">
              {runs.map((r, i) => (
                <li key={i} className="rounded border border-zinc-800 p-2">
                  <span className="text-zinc-500">{r.at}</span> — <strong>{r.test}</strong>{' '}
                  [{r.mode}] — {r.summary}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </main>
  );
}
