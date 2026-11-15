// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown, parseBlocks, safeHref } from './Markdown';

afterEach(cleanup);

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
  it('labels code blocks with their language and copies the exact code text', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<Markdown text={'Run:\n\n```ts\nconst a = "<b>1</b>";\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toBe('const a = "<b>1</b>";');
    expect(container.textContent).toContain('ts');
    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = "<b>1</b>";'));
    await screen.findByText('Copied');
    expect(container.querySelector('b')).toBeNull();
  });
  it('labels an untagged fence as code and reports a failed copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    render(<Markdown text={'```\nls -la\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await screen.findByText('Copy failed');
  });
});
