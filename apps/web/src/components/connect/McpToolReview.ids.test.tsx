// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { McpToolReview } from './McpToolReview';
import type { McpTool } from '@/lib/connect-ui/mcp';

afterEach(cleanup);

// Three servers on one page, as on Connect. Tool names repeat across servers and
// include characters that are not valid in an HTML id (space, dot, slash).
const tool = (name: string, permissionClass: McpTool['permissionClass'] = 'read') => ({ name, description: `Does ${name}`, permissionClass }) as McpTool;
const SERVERS: Array<{ name: string; tools: McpTool[] }> = [
  { name: 'Server A', tools: [tool('search'), tool('create', 'write')] },
  { name: 'Server B', tools: [tool('search'), tool('file.read v2')] },
  { name: 'Server C', tools: [tool('search'), tool('a/b c', 'write'), tool('create', 'write')] },
];

function renderThree() {
  return render(
    <div>
      {SERVERS.map((sv) => (
        <section key={sv.name} aria-label={sv.name}>
          <McpToolReview tools={sv.tools} approved={false} onApprove={vi.fn(async () => null)} />
        </section>
      ))}
    </div>,
  );
}

describe('McpToolReview with several servers on one page', () => {
  it('gives every element a unique id that contains no whitespace', () => {
    const { container } = renderThree();
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.length).toBeGreaterThanOrEqual(10); // 7 selects + 3 "still to review" notes
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/\s/);
  });

  it('links every label and description to an element that exists', () => {
    const { container } = renderThree();
    const refs = [...container.querySelectorAll('label[for], [aria-describedby]')];
    expect(refs.length).toBeGreaterThan(0);
    for (const el of refs) {
      const target = el.getAttribute('for') ?? el.getAttribute('aria-describedby')!;
      expect(container.ownerDocument.getElementById(target), `${el.outerHTML.slice(0, 80)} -> ${target}`).not.toBeNull();
    }
  });

  it('labels each permission choice with its own tool, inside its own server', () => {
    const { getByRole } = renderThree();
    for (const sv of SERVERS) {
      const region = within(getByRole('region', { name: sv.name }));
      for (const x of sv.tools) {
        const select = region.getByLabelText(new RegExp(x.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
        expect(select.tagName).toBe('SELECT');
      }
      expect(region.getAllByRole('combobox')).toHaveLength(sv.tools.length);
    }
  });

  it('explains, per server, why Approve is not available yet', () => {
    const { getByRole } = renderThree();
    for (const sv of SERVERS) {
      const region = within(getByRole('region', { name: sv.name }));
      const btn = region.getByRole('button', { name: /approve/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      const note = region.getByTestId('mcp-review-left');
      expect(btn.getAttribute('aria-describedby')).toBe(note.id);
      expect(note.textContent).toMatch(String(sv.tools.length));
    }
  });
});
