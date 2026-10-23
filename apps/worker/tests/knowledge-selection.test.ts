import { describe, expect, it } from 'vitest';
import { selectKnowledgeEntries } from '../src/knowledge-selection';

const ENTRIES = [
  { question: '¿Cuál es el horario?', answer: 'Lunes a viernes, 9:00 a 18:00.' },
  { question: '¿La consulta tiene costo?', answer: 'La primera consulta es gratuita.' },
  { question: '¿Hacen envíos?', answer: 'Sí, a todo el país en 48 horas.' },
];

describe('selectKnowledgeEntries (FAQ v1)', () => {
  it('selects the entry whose topic matches the message', () => {
    const selected = selectKnowledgeEntries(ENTRIES, '¿Cuál es el horario de atención?');
    expect(selected.map((e) => e.question)).toContain('¿Cuál es el horario?');
  });

  it('matches without accents and across case', () => {
    const selected = selectKnowledgeEntries(ENTRIES, 'HORARIO por favor');
    expect(selected).toHaveLength(1);
    expect(selected[0].question).toBe('¿Cuál es el horario?');
  });

  it('returns nothing when no entry covers the topic — the missing-answer path', () => {
    const selected = selectKnowledgeEntries(
      ENTRIES,
      '¿Tienen estacionamiento para bicicletas?'
    );
    expect(selected).toEqual([]);
  });

  it('returns nothing for an empty or stopword-only message', () => {
    expect(selectKnowledgeEntries(ENTRIES, 'hola, gracias')).toEqual([]);
    expect(selectKnowledgeEntries(ENTRIES, '')).toEqual([]);
  });

  it('caps the number of entries', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      question: `¿Horario especial ${i}?`,
      answer: 'Horario de 9 a 18.',
    }));
    const selected = selectKnowledgeEntries(many, 'horario', { maxEntries: 3 });
    expect(selected).toHaveLength(3);
  });

  it('caps the total entry characters', () => {
    const big = [
      { question: 'horario', answer: 'x'.repeat(3000) },
      { question: 'horario extendido', answer: 'y'.repeat(3000) },
    ];
    const selected = selectKnowledgeEntries(big, 'horario', { maxChars: 4000 });
    expect(selected).toHaveLength(1);
  });

  it('is deterministic regardless of input order', () => {
    const a = selectKnowledgeEntries(ENTRIES, 'horario y costo de la consulta');
    const b = selectKnowledgeEntries([...ENTRIES].reverse(), 'horario y costo de la consulta');
    expect(a).toEqual(b);
  });
});
