'use client';
/**
 * Create > Images: prompt, size, generate, live progress, result and history.
 * Talks only to /api/v1/create/images; the GPU, its token and the organization id
 * never reach the browser.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import s from './create.module.css';

type Status = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';
export interface StudioImage {
  readonly id: string; readonly prompt: string; readonly width: number; readonly height: number;
  readonly seed: number; readonly model: string; readonly status: Status; readonly progress: number;
  readonly errorCode: string | null; readonly seconds: number | null; readonly createdAt: string;
  readonly finishedAt: string | null; readonly fileUrl: string | null;
}
interface ServiceState { readonly configured: boolean; readonly available: boolean; readonly model: string | null }
type Size = 'square' | 'landscape' | 'portrait';

const SIZES: readonly { key: Size; label: string; detail: string }[] = [
  { key: 'square', label: 'Square', detail: '1024 × 1024' },
  { key: 'landscape', label: 'Landscape', detail: '1280 × 720' },
  { key: 'portrait', label: 'Portrait', detail: '720 × 1280' },
];
const MAX = 1000;
const POLL_MS = 1200;
const HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;
const active = (st: Status) => st === 'queued' || st === 'processing';

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  GPU_INFERENCE_FAILED: 'The GPU could not generate this image. Try rephrasing the prompt.',
  GPU_SHUTDOWN: 'Generation was interrupted.',
  JOB_NOT_FOUND: 'This job is no longer known to the image service.',
  RESULT_EXPIRED: 'This image has expired and is no longer stored.',
};

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
  } catch { /* fall through */ }
  if (res.status === 401) return 'Your session has ended. Sign in again to continue.';
  return 'Something went wrong. Please try again.';
}

function statusText(img: StudioImage): string {
  if (img.status === 'queued') return 'Waiting for the GPU…';
  if (img.status === 'processing') return `Generating… ${img.progress}%`;
  if (img.status === 'completed') return img.seconds !== null ? `Done in ${img.seconds.toFixed(1)} s` : 'Done';
  if (img.status === 'cancelled') return 'Cancelled';
  if (img.status === 'expired') return 'Expired';
  return FAILURE_TEXT[img.errorCode ?? ''] ?? 'Generation failed.';
}

type LoadResult =
  | { readonly ok: true; readonly service: ServiceState; readonly images: StudioImage[] }
  | { readonly ok: false; readonly message: string };

async function fetchHistory(): Promise<LoadResult> {
  try {
    const res = await fetch('/api/v1/create/images', { cache: 'no-store' });
    if (!res.ok) return { ok: false, message: await readError(res) };
    const body = await res.json() as { service: ServiceState; images: StudioImage[] };
    return { ok: true, service: body.service, images: body.images };
  } catch {
    return { ok: false, message: 'Could not reach TuGPT. Check your connection and try again.' };
  }
}

const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ImageStudio() {
  const [service, setService] = useState<ServiceState | null>(null);
  const [images, setImages] = useState<StudioImage[]>([]);
  /** Finished images whose preview failed to load (the bytes are served from the private GPU). */
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const markBroken = useCallback((id: string) => setBroken((b) => (b.has(id) ? b : new Set(b).add(id))), []);
  const retryPreview = (id: string) => setBroken((b) => { const n = new Set(b); n.delete(id); return n; });
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<Size>('square');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const upsert = useCallback((img: StudioImage) => {
    setImages((list) => [img, ...list.filter((i) => i.id !== img.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  const applyLoad = useCallback((r: LoadResult) => {
    if (!mounted.current) return;
    if (!r.ok) { setLoadError(r.message); setLoadState('error'); return; }
    setService(r.service);
    setImages(r.images);
    setSelectedId((cur) => cur ?? r.images.find((i) => i.status === 'completed' || active(i.status))?.id ?? null);
    setLoadState('ready');
  }, []);

  // Initial state is already 'loading'; Retry sets it before fetching again.
  useEffect(() => {
    mounted.current = true;
    void fetchHistory().then(applyLoad);
    return () => { mounted.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [applyLoad]);

  const retry = () => { setLoadState('loading'); void fetchHistory().then(applyLoad); };

  const running = images.find((i) => active(i.status)) ?? null;
  const runningId = running?.id ?? null;

  // Poll the one running job until it finishes.
  useEffect(() => {
    if (!runningId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/v1/create/images/${runningId}`, { cache: 'no-store' });
        if (res.ok) {
          const { image } = await res.json() as { image: StudioImage };
          if (!stopped && mounted.current) upsert(image);
          if (!active(image.status)) return;
        }
      } catch { /* transient: keep polling */ }
      if (!stopped) pollTimer.current = setTimeout(tick, POLL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_MS);
    return () => { stopped = true; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [runningId, upsert]);

  const trimmed = prompt.trim();
  const canGenerate = !!service?.available && trimmed.length > 0 && [...prompt].length <= MAX && !submitting && !running;

  async function generate(e?: FormEvent) {
    e?.preventDefault();
    if (!canGenerate) return;
    setSubmitting(true); setFormError('');
    try {
      const res = await fetch('/api/v1/create/images', { method: 'POST', headers: HEADERS, body: JSON.stringify({ prompt: trimmed, size }) });
      if (!res.ok) { setFormError(await readError(res)); return; }
      const { image } = await res.json() as { image: StudioImage };
      upsert(image); setSelectedId(image.id);
    } catch {
      setFormError('Could not reach TuGPT. Check your connection and try again.');
    } finally { if (mounted.current) setSubmitting(false); }
  }

  async function cancel(id: string) {
    try {
      const res = await fetch(`/api/v1/create/images/${id}/cancel`, { method: 'POST', headers: HEADERS, body: '{}' });
      if (!res.ok) { setFormError(await readError(res)); return; }
      upsert((await res.json() as { image: StudioImage }).image);
    } catch { setFormError('Could not cancel. Please try again.'); }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void generate(); }
  }

  const selected = images.find((i) => i.id === selectedId) ?? running ?? images.find((i) => i.status === 'completed') ?? null;
  const count = [...prompt].length;

  return (
    <div className={s.studio}>
      <section className={s.composer} aria-labelledby="create-image-title">
        <div className={s.composerHead}>
          <h2 id="create-image-title">Image generation</h2>
          {loadState === 'ready' && service && (
            <span className={`${s.badge} ${service.available ? s.ok : s.off}`}>
              {service.available ? 'Ready' : service.configured ? 'Temporarily unavailable' : 'Not enabled yet'}
            </span>
          )}
        </div>
        {loadState === 'ready' && service && !service.available && (
          <p className={s.notice} role="status">
            {service.configured
              ? 'The private GPU is not answering right now. Your image list is still here, but previews and downloads come from the GPU and return when it answers. Try again in a minute.'
              : 'Image generation has not been switched on for this workspace.'}
          </p>
        )}
        <form onSubmit={generate} className={s.form} noValidate>
          <label htmlFor="create-prompt" className={s.label}>Describe the image</label>
          <textarea
            id="create-prompt" className={s.prompt} value={prompt} rows={4} maxLength={MAX}
            placeholder="A product photo of a ceramic coffee cup on a sunlit oak table, soft shadows"
            onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey}
            aria-describedby="create-prompt-hint" disabled={loadState !== 'ready'}
          />
          <div id="create-prompt-hint" className={s.hint}>
            <span>Ctrl or ⌘ + Enter to generate</span>
            <span aria-live="polite">{count} / {MAX}</span>
          </div>
          <fieldset className={s.sizes} disabled={loadState !== 'ready'}>
            <legend className={s.label}>Size</legend>
            {SIZES.map((o) => (
              <label key={o.key} className={`${s.size} ${size === o.key ? s.sizeOn : ''}`}>
                <input type="radio" name="size" value={o.key} checked={size === o.key} onChange={() => setSize(o.key)} />
                <span className={`${s.frame} ${s[o.key]}`} aria-hidden="true" />
                <span><strong>{o.label}</strong><small>{o.detail}</small></span>
              </label>
            ))}
          </fieldset>
          {formError && <p className={s.error} role="alert">{formError}</p>}
          <div className={s.formActions}>
            <button type="submit" className={s.primary} disabled={!canGenerate} aria-disabled={!canGenerate}>
              {submitting ? 'Starting…' : running ? 'Generating…' : 'Generate image'}
            </button>
            {service?.model && <span className={s.model}>Model: {service.model.split('/').pop()} · private EU GPU</span>}
          </div>
        </form>
      </section>

      <section className={s.stage} aria-label="Result" aria-busy={!!running}>
        {loadState === 'loading' && <div className={s.placeholder}><span className={s.spinner} aria-hidden="true" /><p>Loading your images…</p></div>}
        {loadState === 'error' && (
          <div className={s.placeholder} role="alert">
            <p>{loadError}</p>
            <button type="button" className={s.secondary} onClick={retry}>Try again</button>
          </div>
        )}
        {loadState === 'ready' && !selected && (
          <div className={s.placeholder}><p className={s.emptyTitle}>No images yet</p><p>Describe what you want to see and choose Generate image. Results appear here and stay in your history.</p></div>
        )}
        {loadState === 'ready' && selected && (
          <figure className={s.result}>
            <div className={s.canvas} style={{ aspectRatio: `${selected.width} / ${selected.height}` }}>
              {selected.status === 'completed' && selected.fileUrl && broken.has(selected.id) ? (
                <div className={s.previewOff} role="status">
                  <p className={s.emptyTitle}>Preview unavailable</p>
                  <p>This image is kept on TuGPT&rsquo;s private GPU, which is not answering right now.</p>
                  <button type="button" className={s.secondary} onClick={() => retryPreview(selected.id)}>Try again</button>
                </div>
              ) : selected.status === 'completed' && selected.fileUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- private, authenticated, no-store image; next/image would cache it
                <img key={selected.id} src={selected.fileUrl} alt={selected.prompt} width={selected.width} height={selected.height} onError={() => markBroken(selected.id)} />
              ) : active(selected.status) ? (
                <div className={s.progressWrap}>
                  <div className={s.progress} role="progressbar" aria-label="Generation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selected.progress}>
                    <span style={{ width: `${Math.max(4, selected.progress)}%` }} />
                  </div>
                  <p aria-live="polite">{statusText(selected)}</p>
                  <button type="button" className={s.secondary} onClick={() => void cancel(selected.id)}>Cancel</button>
                </div>
              ) : (
                <div className={s.progressWrap}><p role="status">{statusText(selected)}</p></div>
              )}
            </div>
            <figcaption className={s.caption}>
              <p className={s.captionPrompt}>{selected.prompt}</p>
              <p className={s.meta}>
                {selected.width} × {selected.height} · seed {selected.seed} · {statusText(selected)}
              </p>
              {selected.status === 'completed' && selected.fileUrl && !broken.has(selected.id) && (
                <div className={s.resultActions}>
                <a className={s.secondary} href={`${selected.fileUrl}?download=1`} download>Download PNG</a>
                <a className={s.secondary} href={selected.fileUrl} target="_blank" rel="noopener noreferrer">Open full size<span className={s.sr}> (opens in a new tab)</span></a>
                </div>
              )}
            </figcaption>
          </figure>
        )}
      </section>

      {loadState === 'ready' && images.length > 0 && (
        <section className={s.history} aria-labelledby="create-history-title">
          <h2 id="create-history-title">Your images</h2>
          <p className={s.meta}>Only you can see these.</p>
          <ul className={s.thumbs}>
            {images.map((img) => (
              <li key={img.id}>
                <button type="button" className={`${s.thumb} ${img.id === selected?.id ? s.thumbOn : ''}`} onClick={() => setSelectedId(img.id)}
                  aria-pressed={img.id === selected?.id} aria-label={`${img.prompt}. ${statusText(img)}. ${timeFmt.format(new Date(img.createdAt))}`}>
                  <span className={s.thumbArt} style={{ aspectRatio: `${img.width} / ${img.height}` }}>
                    {img.status === 'completed' && img.fileUrl && broken.has(img.id)
                      ? <span className={s.thumbState}>Preview unavailable</span>
                      : img.status === 'completed' && img.fileUrl
                      // eslint-disable-next-line @next/next/no-img-element -- see above
                      ? <img src={img.fileUrl} alt="" loading="lazy" width={img.width} height={img.height} onError={() => markBroken(img.id)} />
                      : <span className={s.thumbState}>{active(img.status) ? `${img.progress}%` : statusText(img)}</span>}
                  </span>
                  <span className={s.thumbText}>{img.prompt}</span>
                  <time className={s.thumbTime} dateTime={img.createdAt}>{timeFmt.format(new Date(img.createdAt))}</time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
