// @vitest-environment jsdom
// Control Center component — proves the page renders its sections
// from the health API and runs a lab on click, with no invented data:
// the health response is stubbed to the shape the real endpoint
// returns, and the lab response is the real lab output shape.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlCenter } from './ControlCenter';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
});

describe('ControlCenter', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              whatsappKillSwitch: 'OFF',
              envPresence: { NEXT_PUBLIC_SUPABASE_URL: false },
              catalogCounts: { 'in-ui': 3 },
              catalogTotal: 13,
              database: { available: false, reason: 'No database here.' },
              workers: { available: false, reason: 'No workers here.' },
            }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
  });

  it('renders the overview with the kill switch OFF and the health state', async () => {
    render(<ControlCenter />);
    await waitFor(() => {
      expect(screen.getByText(/WhatsApp kill switch:/)).toBeTruthy();
    });
    expect(screen.getAllByText('OFF').length).toBeGreaterThan(0);
    expect(screen.getByText(/No database here\./)).toBeTruthy();
  });

  it('switches to the catalog tab and lists features', async () => {
    render(<ControlCenter />);
    await userEvent.click(screen.getByRole('button', { name: 'Feature catalog' }));
    expect(screen.getByText('FAQ management and grounded replies')).toBeTruthy();
    expect(screen.getByText('CRM synchronization')).toBeTruthy();
  });

  it('runs a lab from the test center and shows its mode', async () => {
    mockFetch.mockImplementation((url: string, init?: { body?: string }) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              whatsappKillSwitch: 'OFF',
              envPresence: {},
              catalogCounts: {},
              catalogTotal: 13,
              database: { available: false, reason: '' },
              workers: { available: false, reason: '' },
            }),
        });
      }
      const body = JSON.parse(init?.body ?? '{}') as { test: string };
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            test: body.test,
            mode: 'real-in-process',
            summary: 'Ran the production function over fixtures.',
            output: { selected: [] },
          }),
      });
    });
    render(<ControlCenter />);
    await userEvent.click(screen.getByRole('button', { name: 'Test center' }));
    await userEvent.click(screen.getByRole('button', { name: 'FAQ retrieval' }));
    await waitFor(() => {
      expect(screen.getByText(/mode: real-in-process/)).toBeTruthy();
    });
  });
});
