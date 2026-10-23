// @vitest-environment jsdom
/**
 * KnowledgeManager — the owner's FAQ workshop as the owner sees it.
 *
 * The route tests prove the API's authorization and shaping. These
 * prove the screen wires them together: entries render with their
 * enabled state, the toggle PATCHes the flag, adding posts the new
 * entry, and the preview shows the selection the assistant would
 * actually use — including the honest empty result.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeManager } from './KnowledgeManager';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ENTRY = {
  id: '11111111-2222-3333-4444-555555555555',
  question: '¿Cuál es el horario?',
  answer: 'Lunes a viernes, 9:00 a 18:00.',
  enabled: true,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/v1/knowledge' && (!init || init.method === undefined)) {
      return jsonResponse({ entries: [ENTRY] });
    }
    if (url === '/api/v1/knowledge/preview') {
      return jsonResponse({
        selected: [{ question: ENTRY.question, answer: ENTRY.answer }],
      });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
});

describe('KnowledgeManager', () => {
  it('renders the entries with their enabled state', async () => {
    render(<KnowledgeManager />);
    expect(await screen.findByText('¿Cuál es el horario?')).toBeTruthy();
    expect(screen.getByText('Lunes a viernes, 9:00 a 18:00.')).toBeTruthy();
    expect(screen.getByText('Activa')).toBeTruthy();
  });

  it('toggling PATCHes the enabled flag for that entry', async () => {
    const user = userEvent.setup();
    render(<KnowledgeManager />);
    await screen.findByText('¿Cuál es el horario?');

    await user.click(screen.getByText('Inactiva'));

    await waitFor(() => {
      const patch = mockFetch.mock.calls.find(
        ([url, init]) =>
          url === `/api/v1/knowledge/${ENTRY.id}` && init?.method === 'PATCH'
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body as string)).toEqual({ enabled: false });
    });
  });

  it('adding an entry POSTs the question and answer', async () => {
    const user = userEvent.setup();
    render(<KnowledgeManager />);
    await screen.findByText('¿Cuál es el horario?');

    await user.type(
      screen.getByPlaceholderText('¿Cuál es el horario de atención?'),
      '¿Hacen envíos?'
    );
    await user.type(
      screen.getByPlaceholderText('Lunes a viernes, de 9:00 a 18:00.'),
      'Sí, a todo el país.'
    );
    await user.click(screen.getByText('Agregar'));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([url, init]) => url === '/api/v1/knowledge' && init?.method === 'POST'
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body as string)).toEqual({
        question: '¿Hacen envíos?',
        answer: 'Sí, a todo el país.',
      });
    });
  });

  it('the preview shows the selection the assistant would use', async () => {
    const user = userEvent.setup();
    render(<KnowledgeManager />);
    await screen.findByText('¿Cuál es el horario?');

    await user.type(
      screen.getByPlaceholderText('Escriba una pregunta como la haría un cliente…'),
      '¿Cuál es el horario de atención?'
    );
    await user.click(screen.getByText('Probar'));

    expect(
      await screen.findByText('El asistente usaría estas respuestas:')
    ).toBeTruthy();
  });

  it('an empty preview result is stated honestly, not hidden', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/knowledge' && (!init || init.method === undefined)) {
        return jsonResponse({ entries: [ENTRY] });
      }
      if (url === '/api/v1/knowledge/preview') {
        return jsonResponse({ selected: [] });
      }
      return jsonResponse({});
    });
    const user = userEvent.setup();
    render(<KnowledgeManager />);
    await screen.findByText('¿Cuál es el horario?');

    await user.type(
      screen.getByPlaceholderText('Escriba una pregunta como la haría un cliente…'),
      '¿Tienen estacionamiento?'
    );
    await user.click(screen.getByText('Probar'));

    expect(
      await screen.findByText(/Ninguna respuesta registrada coincide/)
    ).toBeTruthy();
  });
});
