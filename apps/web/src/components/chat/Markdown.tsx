/**
 * Safe Markdown for model output.
 *
 * Model text is untrusted: it can contain anything a prompt-injected source
 * wanted it to say. This renderer therefore never produces HTML strings. It
 * parses a deliberately small Markdown subset into React elements, so every
 * character the model sends ends up as a text node (React escapes it).
 *
 * Supported: paragraphs, headings (#–###), bullet and numbered lists, fenced
 * code, inline code, **bold**, *italic*, blockquotes, horizontal rules and
 * links. Links are kept only for http(s) and mailto; anything else (javascript:,
 * data:, relative paths) is shown as plain text. Unclosed markers — normal while
 * an answer streams — degrade to literal text instead of breaking layout.
 */
import { Fragment, type ReactNode } from 'react';
import s from './chat.module.css';

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"']+$/i;

export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!SAFE_URL.test(url)) return null;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

/** Inline: `code`, **bold**, *italic* / _italic_, [text](url). Recursion is bounded by input length. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)|(\[[^\]\n]{1,200}\]\([^)\s]{1,2000}\))/g;
  let last = 0; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k} className={s.inlineCode}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close); const href = safeHref(tok.slice(close + 2, -1));
      out.push(href
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">{inline(label, k)}</a>
        : <Fragment key={k}>{tok}</Fragment>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: 'p'; text: string } | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'ul' | 'ol'; items: string[]; start: number } | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; text: string } | { t: 'hr' };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]{0,20})\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, text: h[2].replace(/\s+#+\s*$/, '') }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d{1,6})[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const items: string[] = [ul ? ul[1] : ol![2]];
      const start = ol ? Number(ol[1]) : 1;
      while (i + 1 < lines.length) {
        const nx = lines[i + 1];
        const m = kind === 'ul' ? /^\s*[-*+]\s+(.*)$/.exec(nx) : /^\s*\d{1,6}[.)]\s+(.*)$/.exec(nx);
        if (m) { items.push(m[1]); i++; continue; }
        if (nx.trim() && /^\s{2,}\S/.test(nx)) { items[items.length - 1] += ' ' + nx.trim(); i++; continue; }
        break;
      }
      blocks.push({ t: kind, items, start });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const body = [q[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', text: body.join('\n') });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((l, i) => (i ? [<br key={`${key}-br${i}`} />, ...inline(l, `${key}-${i}`)] : inline(l, `${key}-${i}`)));
}

export function Markdown({ text }: { text: string }) {
  return <div className={s.md}>{parseBlocks(text).map((b, i) => {
    const k = `b${i}`;
    switch (b.t) {
      case 'p': return <p key={k}>{withBreaks(b.text, k)}</p>;
      case 'h': { const H = (`h${b.level + 2}`) as 'h3' | 'h4' | 'h5'; return <H key={k}>{inline(b.text, k)}</H>; }
      case 'ul': return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>;
      case 'ol': return <ol key={k} start={b.start}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>;
      case 'code': return <pre key={k} className={s.codeBlock} data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
      case 'quote': return <blockquote key={k}>{withBreaks(b.text, k)}</blockquote>;
      case 'hr': return <hr key={k} />;
    }
  })}</div>;
}
