import { describe, expect, it } from 'vitest';
import { filterMembers, MEMBER_QUERY_MAX } from './memberSearch';

const EN: Record<string, string> = { owner: 'Owner', admin: 'Administrator', agent: 'Member', viewer: 'Viewer' };
const ES: Record<string, string> = { owner: 'Propietario', admin: 'Administrador', agent: 'Miembro', viewer: 'Lector' };
const M = [
  { id: 1, name: 'Anna Owner', email: 'anna.owner@hartmann.example', role: 'owner' },
  { id: 2, name: 'José Núñez', email: 'jose.nunez@hartmann.example', role: 'admin' },
  { id: 3, name: 'Jürgen Straße', email: 'j.strasse@nordwind.example', role: 'agent' },
  { id: 4, name: null, email: 'no-name@hartmann.example', role: 'viewer' },
  { id: 5, name: 'No Email', email: null, role: 'agent' },
];
const ids = (q: string, labels = EN) => filterMembers(M, q, (r) => labels[r] ?? r).map((m) => m.id);

describe('filterMembers', () => {
  it('returns everyone, in order, for a blank query', () => {
    expect(ids('')).toEqual([1, 2, 3, 4, 5]);
    expect(ids('   ')).toEqual([1, 2, 3, 4, 5]);
  });
  it('matches name, email and the role label as shown', () => {
    expect(ids('anna')).toEqual([1]);
    expect(ids('@nordwind')).toEqual([3]);
    expect(ids('administrator')).toEqual([2]);
    expect(ids('member')).toEqual([3, 5]);
  });
  it('ignores case and accents on both sides', () => {
    expect(ids('jose nunez')).toEqual([2]);
    expect(ids('NÚÑEZ')).toEqual([2]);
    expect(ids('jurgen')).toEqual([3]);
    expect(ids('strasse')).toEqual([3]);
    expect(ids('ANNA')).toEqual([1]);
  });
  it('requires every word, across different fields', () => {
    expect(ids('owner hartmann')).toEqual([1]);
    expect(ids('member nordwind')).toEqual([3]);
    expect(ids('anna nordwind')).toEqual([]);
  });
  it('uses the viewer language for roles', () => {
    expect(ids('propietario', ES)).toEqual([1]);
    expect(ids('administrador', ES)).toEqual([2]);
    expect(ids('propietario', EN)).toEqual([]);
  });
  it('copes with missing names and emails', () => {
    expect(ids('no-name')).toEqual([4]);
    expect(ids('no email')).toEqual([5]);
    expect(ids('null')).toEqual([]);
  });
  it('treats regex characters literally and caps the query length', () => {
    expect(ids('.*')).toEqual([]);
    expect(ids('(')).toEqual([]);
    expect(ids('anna' + ' '.repeat(MEMBER_QUERY_MAX) + 'zzz')).toEqual([1]);
  });
});
