'use client';

/**
 * The product constellation: TuGPT at the core, every product a node wired to it,
 * a filament from the core to each one. Live products carry a travelling
 * signal; products waiting on a person pulse pink; planned ones are dashed
 * and inert.
 *
 * Interaction model
 *   - Every product is one element in one list. With a page, it is a real
 *     link (keyboard, middle-click, screen readers all work as links do).
 *     Without one, it is a button that only shows its details — it never
 *     pretends to navigate.
 *   - Hover or focus selects a product into the inspector; selection is
 *     presentation only.
 *   - The slab tilts slightly toward the pointer. Skipped for coarse pointers
 *     and reduced motion, throttled to one write per animation frame, and it
 *     touches two CSS variables — no React re-render per mouse move.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { ProductId, ProductState, ProductView } from '@/lib/hub/products';
import { Glyph, TuGPTMark } from './glyphs';
import s from './hub.module.css';

/** Decorative orbit rings around the core, in slab percent. */
const RINGS = [
  { rx: 17, ry: 20 },
  { rx: 31, ry: 36 },
] as const;
const CORE = { x: 50, y: 50 } as const;

const DOT: Record<ProductState, string> = {
  live: s.dotLive,
  connected: s.dotConnected,
  attention: s.dotAttention,
  setup: s.dotSetup,
  planned: s.dotPlanned,
  unknown: s.dotUnknown,
  held: s.dotPlanned,
};

function nodeClass(p: ProductView, selected: boolean): string {
  return [
    s.node,
    p.state === 'attention' ? s.nodeHot : '',
    p.state === 'planned' ? s.nodePlanned : '',
    p.state === 'live' ? s.nodeLive : '',
    p.state === 'connected' ? s.nodeConnected : '',
    selected ? s.nodeSelected : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ConstellationProps {
  readonly products: readonly ProductView[];
  readonly organizationName: string | null;
}

export function Constellation({ products, organizationName }: ConstellationProps) {
  const t = useT();
  const initial = useMemo<ProductId>(
    () => (products.find((p) => p.state === 'attention') ?? products[0]).id,
    [products]
  );
  const [selectedId, setSelectedId] = useState<ProductId>(initial);
  const selected = products.find((p) => p.id === selectedId) ?? products[0];

  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const motionOk = useRef(false);

  useEffect(() => {
    // No matchMedia (old engines, test DOMs): stay still rather than guess.
    if (typeof window.matchMedia !== 'function') return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(pointer: fine)');
    const update = () => {
      motionOk.current = !reduce.matches && fine.matches;
    };
    update();
    reduce.addEventListener('change', update);
    fine.addEventListener('change', update);
    return () => {
      reduce.removeEventListener('change', update);
      fine.removeEventListener('change', update);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!motionOk.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      stageRef.current?.style.setProperty('--ry', `${(px * 6).toFixed(2)}deg`);
      stageRef.current?.style.setProperty('--rx', `${(-py * 5).toFixed(2)}deg`);
    });
  }, []);

  const onPointerLeave = useCallback(() => {
    stageRef.current?.style.setProperty('--ry', '0deg');
    stageRef.current?.style.setProperty('--rx', '0deg');
  }, []);

  const metricLabel = (p: ProductView) =>
    p.metric !== null && p.metricKey ? `${p.metric} ${t(p.metricKey)}` : t(p.stateKey);

  return (
    <div className={s.stageWrap}>
      <div
        ref={stageRef}
        className={s.stage}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <div className={`${s.slab} ${s.glass}`}>
          <div className={s.slabInner}>
            <div className={s.slabLabel} aria-hidden="true">
              <span>{t('hub.stage.label')}</span>
              <span>{organizationName ?? t('shell.organizationUnknown')}</span>
            </div>

            <svg className={s.web} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <ellipse className={s.orbit} cx={CORE.x} cy={CORE.y} rx={RINGS[0].rx} ry={RINGS[0].ry} />
              <ellipse className={`${s.orbit} ${s.orbitOuter}`} cx={CORE.x} cy={CORE.y} rx={RINGS[1].rx} ry={RINGS[1].ry} />
              {products.map((p, i) => {
                const pos = p.slot;
                const hot = p.state === 'attention';
                const flowing = p.state === 'live' || p.state === 'connected' || hot;
                const cls = [
                  s.filament,
                  p.state === 'planned' ? s.filamentPlanned : '',
                  p.id === selectedId ? (hot ? s.filamentHot : s.filamentActive) : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g key={p.id}>
                    <line className={cls} x1={CORE.x} y1={CORE.y} x2={pos.x} y2={pos.y} />
                    {flowing ? (
                      <line
                        className={`${s.packet} ${hot ? s.packetHot : ''}`}
                        x1={CORE.x}
                        y1={CORE.y}
                        x2={pos.x}
                        y2={pos.y}
                        pathLength={1}
                        style={{ animationDelay: `${i * -0.45}s` }}
                      />
                    ) : null}
                  </g>
                );
              })}
            </svg>

            <div className={s.core} aria-hidden="true">
              <span className={s.coreHalo} />
              <span className={s.coreRing} />
              <span className={s.coreRing2} />
              <span className={s.coreDisc}>
                <TuGPTMark size={34} />
                <small>{t('hub.core')}</small>
              </span>
            </div>

            <ul className={s.nodes} aria-label={t('hub.products.label')}>
              {products.map((p) => {
                const pos = p.slot;
                const isSel = p.id === selectedId;
                const body = (
                  <>
                    <span className={s.glyph}>
                      <Glyph name={p.glyph} />
                    </span>
                    <span className={s.nodeText}>
                      <span className={s.nodeTitle}>{t(p.titleKey)}</span>
                      <span className={s.nodeMeta}>
                        <span className={`${s.dot} ${DOT[p.state]}`} aria-hidden="true" />
                        <span className={p.metric !== null ? s.metric : undefined}>{metricLabel(p)}</span>
                      </span>
                      <span className={s.nodeDesc}>{t(p.descriptionKey)}</span>
                    </span>
                  </>
                );
                const select = () => setSelectedId(p.id);
                return (
                  <li
                    key={p.id}
                    className={s.nodeItem}
                    style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                    data-product={p.id}
                    data-state={p.state}
                  >
                    {p.href ? (
                      <Link href={p.href} className={nodeClass(p, isSel)} onMouseEnter={select} onFocus={select}>
                        {body}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className={nodeClass(p, isSel)}
                        onMouseEnter={select}
                        onFocus={select}
                        onClick={select}
                        aria-pressed={isSel}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      <aside
        className={`${s.glass} ${s.inspector} ${selected.state === 'attention' ? s.inspectorHot : ''}`}
        aria-live="polite"
        aria-label={t('hub.inspector.label')}
      >
        <p className={s.eyebrow}>{t('hub.inspector.eyebrow')}</p>
        <span className={s.inspectorGlyph}>
          <Glyph name={selected.glyph} size={26} />
        </span>
        <h2 className={s.inspectorTitle}>{t(selected.titleKey)}</h2>
        <span className={s.inspectorState}>
          <span className={`${s.dot} ${DOT[selected.state]}`} aria-hidden="true" />
          {t(selected.stateKey)}
        </span>
        <p className={s.inspectorDesc}>{t(selected.descriptionKey)}</p>
        {selected.metric !== null && selected.metricKey ? (
          <div className={s.inspectorFigure}>
            <strong>{selected.metric}</strong>
            <span>{t(selected.metricKey)}</span>
          </div>
        ) : null}
        <div className={s.inspectorFoot}>
          {selected.href ? (
            <Link href={selected.href} className={`${s.pill} ${s.pillSignal}`}>
              <span>{t('hub.open', { product: t(selected.titleKey) })}</span>
              <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            <p className={s.note}>
              {selected.state === 'planned' ? t('hub.note.planned') : t('hub.note.assisted')}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
