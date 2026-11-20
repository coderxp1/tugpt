// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentIdentity } from './AgentIdentity';
afterEach(cleanup);
it('identifies normal chat', () => {
  render(<AgentIdentity />);
  expect(screen.getByRole('status').textContent).toBe('Agent: TuGPT Assistant');
});
it('preserves the full custom name and updates when the restored binding changes', () => {
  const name = 'Shipping and returns specialist for international customers and regional teams';
  const { rerender } = render(<AgentIdentity label={name} />);
  expect(screen.getByRole('status').textContent).toBe('Agent: ' + name);
  rerender(<AgentIdentity label="Research assistant" />);
  expect(screen.getByRole('status').textContent).toBe('Agent: Research assistant');
  rerender(<AgentIdentity />);
  expect(screen.getByRole('status').textContent).toBe('Agent: TuGPT Assistant');
});
it('keeps unresolved or unavailable binding text instead of substituting the built-in agent', () => {
  render(<AgentIdentity label="This agent is unavailable" />);
  expect(screen.getByRole('status').textContent).toBe('Agent: This agent is unavailable');
});
