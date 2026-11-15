// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown, parseBlocks, safeHref } from './Markdown';

describe('Markdown (model output)', () => {
  it('renders the bullet/bold answer the preview showed as raw text', () => {
    const { container } = render(<Markdown text={'Here are three:\n\n* **Shipment tracking**: updates.\n* **Compliance**: forms.'} />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelector('li strong')?.textContent).toBe('Shipment tracking');
    expect(container.textContent).not.toContain('**');
  });
  it('never creates HTML from model text', () => {
    const evil = '<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>x</b>**';
    const { container } = render(<Markdown text={evil} />);
    expect(container.querySelector('img,script,b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
  it('keeps only http(s) and mailto links', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('/dashboard')).toBeNull();
    expect(safeHref('https://tugpt.pro/a')).toBe('https://tugpt.pro/a');
    const { container } = render(<Markdown text={'[ok](https://tugpt.pro) [bad](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('rel')).toContain('noopener');
    expect(container.textContent).toContain('[bad](javascript:alert(1))');
  });
  it('renders numbered lists, code fences, headings and inline code', () => {
    const { container } = render(<Markdown text={'## Plan\n1. one\n2. two\n\n```ts\nconst a = `x`;\n```\nUse `pnpm`.'} />);
    expect(container.querySelector('h4')?.textContent).toBe('Plan');
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toBe('const a = `x`;');
    expect(container.querySelector('p code')?.textContent).toBe('pnpm');
  });
  it('tolerates a half-streamed answer', () => {
    expect(() => render(<Markdown text={'* **Ship'} />)).not.toThrow();
    expect(parseBlocks('```js\nlet x')).toEqual([{ t: 'code', lang: 'js', text: 'let x' }]);
  });
});
