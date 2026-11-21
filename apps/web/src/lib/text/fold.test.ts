import { describe, expect, it } from 'vitest';
import { foldText, searchWords } from './fold';

describe('foldText', () => {
  it('ignores case and accents, in composed and decomposed form', () => {
    for (const v of ['José', 'JOSÉ', 'Jose\u0301', 'jose']) expect(foldText(v)).toBe('jose');
    expect(foldText('Núñez Müller Ærø')).toBe('nunez muller ærø'.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
    expect(foldText('ÇÀÉÎÕÜ')).toBe('caeiou');
  });
  it('spells out ß and folds compatibility characters', () => {
    expect(foldText('Straße')).toBe('strasse');
    expect(foldText('STRAẞE')).toBe('strasse');
    expect(foldText('ﬁnance')).toBe('finance');
    expect(foldText('ＡＮＮＡ')).toBe('anna');
  });
});

describe('searchWords', () => {
  it('splits on any whitespace and drops blanks', () => {
    expect(searchWords('  Ana\tMARÍA \n ')).toEqual(['ana', 'maria']);
    expect(searchWords('   ')).toEqual([]);
  });
});
