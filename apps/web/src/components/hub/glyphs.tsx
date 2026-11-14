/**
 * Hub glyphs. Inline SVG, stroke-based, `currentColor`, so state colour is set
 * by CSS on the parent and there is no icon dependency to add.
 */

import type { ProductGlyph } from '@/lib/hub/products';

const PATHS: Record<ProductGlyph, React.ReactNode> = {
  chat: (
    <>
      <path d="M4 5h16v11H11l-5 3.5V16H4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  draft: (
    <>
      <path d="M6 3.5h8l4 4V20.5H6z" />
      <path d="M14 3.5v4h4M9 12h6M9 15.5h4" />
    </>
  ),
  book: (
    <>
      <path d="M4.5 5.5c2.5-1 5-1 7.5.5 2.5-1.5 5-1.5 7.5-.5v13c-2.5-1-5-1-7.5.5-2.5-1.5-5-1.5-7.5-.5z" />
      <path d="M12 6v13" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M10 9.5v5l4.5-2.5z" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4M8 14h3" />
    </>
  ),
  phone: (
    <>
      <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z" />
      <path d="M9 9c0 3 2.5 5.8 6 6l1-1.6-2-1-1 1c-1-.5-2-1.5-2.4-2.4l1-1-1-2z" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19.5h16" />
      <path d="M7 16v-4M11 16V8M15 16v-6M19 16V5" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z" />
    </>
  ),
};

export function Glyph({ name, size = 20 }: { name: ProductGlyph; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The website's speech-bubble mark, redrawn at the same proportions. */
export function TuGPTMark({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={(size * 29) / 35} viewBox="0 0 35 29">
      <path d="M2 3h31v19H17l-8 5v-5H2z" fill="currentColor" />
      <path d="M10 10h15M10 15h9" stroke="#0b0c0d" strokeWidth="2.5" />
    </svg>
  );
}
