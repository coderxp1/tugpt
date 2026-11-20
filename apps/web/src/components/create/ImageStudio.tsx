'use client';
/**
 * Create > Images: prompt, size, generate, live progress, result and history.
 * Talks only to /api/v1/create/images; the GPU, its token and the organization id
 * never reach the browser.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useT } from '@/i18n/provider';
import type { MessageKey, Translator } from '@/i18n/types';
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

const SIZES: readonly { key: Size; detail: string }[] = [
  { key: 'square', detail: '1024 × 1024' },
  { key: 'landscape', detail: '1280 × 720' },
  { key: 'portrait', detail: '720 × 1280' },
];

const MAX = 1000;
const POLL_MS = 1200;
const HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;
const active = (st: Status) => st === 'queued' || st === 'processing';

const FAILURES = new Set(['GPU_INFERENCE_FAILED', 'GPU_SHUTDOWN', 'JOB_NOT_FOUND', 'RESULT_EXPIRED']);

/** A server `message` is passed through as the server wrote it; otherwise the reader's language. */
async function readError(res: Response, t: Translator): Promise<string> {
  try {
    const body = await res.json() as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
  } catch { /* fall through */ }
  if (res.status === 401) return t('create.err.session');
  return t('create.err.generic');
}

function statusText(img: StudioImage, t: Translator): string {
  if (img.status === 'queued') return t('create.st.queued');
  if (img.status === 'processing') return t('create.st.processing', { progress: img.progress });
  if (img.status === 'completed') return img.seconds !== null ? t('create.st.doneIn', { seconds: img.seconds.toLocaleString(t.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t('create.st.done');
  if (img.status === 'cancelled') return t('create.st.cancelled');
  if (img.status === 'expired') return t('create.st.expired');
  return img.errorCode && FAILURES.has(img.errorCode) ? t(`create.fail.${img.errorCode}` as MessageKey) : t('create.fail.default');
}

type LoadResult =
  | { readonly ok: true; readonly service: ServiceState; readonly images: StudioImage[] }
  | { readonly ok: false; readonly message: string };

async function fetchHistory(t: Translator): Promise<LoadResult> {
  try {
    const res = await fetch('/api/v1/create/images', { cache: 'no-store' });
    if (!res.ok) return { ok: false, message: await readError(res, t) };
    const body = await res.json() as { service: ServiceState; images: StudioImage[] };
    return { ok: true, service: body.service, images: body.images };
  } catch {
    return { ok: false, message: t('create.err.network') };
  }
}


export function ImageStudio() {
  const t = useT();
  const timeFmt = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });
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
    void fetchHistory(t).then(applyLoad);
    return () => { mounted.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [applyLoad, t]);

  const retry = () => { setLoadState('loading'); void fetchHistory(t).then(applyLoad); };

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
      if (!res.ok) { setFormError(await readError(res, t)); return; }
      const { image } = await res.json() as { image: StudioImage };
      upsert(image); setSelectedId(image.id);
    } catch {
      setFormError(t('create.err.network'));
    } finally { if (mounted.current) setSubmitting(false); }
  }

  async function cancel(id: string) {
    try {
      const res = await fetch(`/api/v1/create/images/${id}/cancel`, { method: 'POST', headers: HEADERS, body: '{}' });
      if (!res.ok) { setFormError(await readError(res, t)); return; }
      upsert((await res.json() as { image: StudioImage }).image);
    } catch { setFormError(t('create.err.cancel')); }
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
          <h2 id="create-image-title">{t('create.studio.title')}</h2>
          {loadState === 'ready' && service && (
            <span className={`${s.badge} ${service.available ? s.ok : s.off}`}>
              {service.available ? t('create.badge.ready') : service.configured ? t('create.badge.down') : t('create.badge.off')}
            </span>
          )}
        </div>
        {loadState === 'ready' && service && !service.available && (
          <p className={s.notice} role="status">
            {service.configured
              ? t('create.notice.down')
              : t('create.notice.off')}
          </p>
        )}
        <form onSubmit={generate} className={s.form} noValidate>
          <label htmlFor="create-prompt" className={s.label}>{t('create.prompt.label')}</label>
          <textarea
            id="create-prompt" className={s.prompt} value={prompt} rows={4} maxLength={MAX}
            placeholder={t('create.prompt.placeholder')}
            onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey}
            aria-describedby="create-prompt-hint" disabled={loadState !== 'ready'}
          />
          <div id="create-prompt-hint" className={s.hint}>
            <span>{t('create.prompt.hint')}</span>
            <span aria-live="polite">{count} / {MAX}</span>
          </div>
          <fieldset className={s.sizes} disabled={loadState !== 'ready'}>
            <legend className={s.label}>{t('create.size')}</legend>
            {SIZES.map((o) => (
              <label key={o.key} className={`${s.size} ${size === o.key ? s.sizeOn : ''}`}>
                <input type="radio" name="size" value={o.key} checked={size === o.key} onChange={() => setSize(o.key)} />
                <span className={`${s.frame} ${s[o.key]}`} aria-hidden="true" />
                <span><strong>{t(`create.size.${o.key}`)}</strong><small>{o.detail}</small></span>
              </label>
            ))}
          </fieldset>
          {formError && <p className={s.error} role="alert">{formError}</p>}
          <div className={s.formActions}>
            <button type="submit" className={s.primary} disabled={!canGenerate} aria-disabled={!canGenerate}>
              {submitting ? t('create.starting') : running ? t('create.generating') : t('create.generate')}
            </button>
            {service?.model && <span className={s.model}>{t('create.model', { model: service.model.split('/').pop() ?? service.model })}</span>}
          </div>
        </form>
      </section>

      <section className={s.stage} aria-label={t('create.resultAria')} aria-busy={!!running}>
        {loadState === 'loading' && <div className={s.placeholder}><span className={s.spinner} aria-hidden="true" /><p>{t('create.loading')}</p></div>}
        {loadState === 'error' && (
          <div className={s.placeholder} role="alert">
            <p>{loadError}</p>
            <button type="button" className={s.secondary} onClick={retry}>{t('create.tryAgain')}</button>
          </div>
        )}
        {loadState === 'ready' && !selected && (
          <div className={s.placeholder}><p className={s.emptyTitle}>{t('create.empty.title')}</p><p>{service?.available ? t('create.empty.ready') : t('create.empty.off')}</p></div>
        )}
        {loadState === 'ready' && selected && (
          <figure className={s.result}>
            <div className={s.canvas} style={{ aspectRatio: `${selected.width} / ${selected.height}` }}>
              {selected.status === 'completed' && selected.fileUrl && broken.has(selected.id) ? (
                <div className={s.previewOff} role="status">
                  <p className={s.emptyTitle}>{t('create.preview.off')}</p>
                  <p>{t('create.preview.offBody')}</p>
                  <button type="button" className={s.secondary} onClick={() => retryPreview(selected.id)}>{t('create.tryAgain')}</button>
                </div>
              ) : selected.status === 'completed' && selected.fileUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- private, authenticated, no-store image; next/image would cache it
                <img key={selected.id} src={selected.fileUrl} alt={selected.prompt} width={selected.width} height={selected.height} onError={() => markBroken(selected.id)} />
              ) : active(selected.status) ? (
                <div className={s.progressWrap}>
                  <div className={s.progress} role="progressbar" aria-label={t('create.progressAria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={selected.progress}>
                    <span style={{ width: `${Math.max(4, selected.progress)}%` }} />
                  </div>
                  <p aria-live="polite">{statusText(selected, t)}</p>
                  <button type="button" className={s.secondary} onClick={() => void cancel(selected.id)}>{t('create.cancel')}</button>
                </div>
              ) : (
                <div className={s.progressWrap}><p role="status">{statusText(selected, t)}</p></div>
              )}
            </div>
            <figcaption className={s.caption}>
              <p className={s.captionPrompt}>{selected.prompt}</p>
              <p className={s.meta}>
                {selected.width} × {selected.height} · {t('create.seed', { seed: selected.seed })} · {statusText(selected, t)}
              </p>
              {selected.status === 'completed' && selected.fileUrl && !broken.has(selected.id) && (
                <div className={s.resultActions}>
                <a className={s.secondary} href={`${selected.fileUrl}?download=1`} download>{t('create.download')}</a>
                <a className={s.secondary} href={selected.fileUrl} target="_blank" rel="noopener noreferrer">{t('create.openFull')}<span className={s.sr}>{t('create.newTab')}</span></a>
                </div>
              )}
            </figcaption>
          </figure>
        )}
      </section>

      {loadState === 'ready' && images.length > 0 && (
        <section className={s.history} aria-labelledby="create-history-title">
          <h2 id="create-history-title">{t('create.history')}</h2>
          <p className={s.meta}>{t('create.historyPrivate')}</p>
          <ul className={s.thumbs}>
            {images.map((img) => (
              <li key={img.id}>
                <button type="button" className={`${s.thumb} ${img.id === selected?.id ? s.thumbOn : ''}`} onClick={() => setSelectedId(img.id)}
                  aria-pressed={img.id === selected?.id} aria-label={`${img.prompt}. ${statusText(img, t)}. ${timeFmt.format(new Date(img.createdAt))}`}>
                  <span className={s.thumbArt} style={{ aspectRatio: `${img.width} / ${img.height}` }}>
                    {img.status === 'completed' && img.fileUrl && broken.has(img.id)
                      ? <span className={s.thumbState}>{t('create.preview.off')}</span>
                      : img.status === 'completed' && img.fileUrl
                      // eslint-disable-next-line @next/next/no-img-element -- see above
                      ? <img src={img.fileUrl} alt="" loading="lazy" width={img.width} height={img.height} onError={() => markBroken(img.id)} />
                      : <span className={s.thumbState}>{active(img.status) ? `${img.progress}%` : statusText(img, t)}</span>}
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
