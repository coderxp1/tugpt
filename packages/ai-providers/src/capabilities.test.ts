import { describe, expect, it } from 'vitest';
import { resolveCapabilityRoute, rankKnowledgeVectors } from './capabilities';
describe('capability routing', () => {
  const route = { capability: 'image.generate' as const, provider:'local-diffusers',model:'z-image-turbo',enabled:true,external:false };
  it('selects explicit routes', () => expect(resolveCapabilityRoute([route],'image.generate')).toEqual(route));
  it('fails closed for absent, disabled or ambiguous routes', () => {
    for (const routes of [[],[{...route,enabled:false}],[route,route]]) expect(() => resolveCapabilityRoute(routes,'image.generate')).toThrow();
  });
  it('requires explicit external approval', () => {
    expect(() => resolveCapabilityRoute([{...route,external:true}],'image.generate')).toThrow('EXTERNAL_PROVIDER_NOT_APPROVED');
    expect(resolveCapabilityRoute([{...route,external:true}],'image.generate',true).external).toBe(true);
  });
});
describe('tenant-scoped semantic ranking', () => {
  it('excludes other organizations and incompatible embeddings before ranking', () => {
    const entries = [
      {id:'other',organizationId:'b',modelRevision:'r1',vector:[1,0]},
      {id:'wrong-model',organizationId:'a',modelRevision:'r2',vector:[1,0]},
      {id:'relevant',organizationId:'a',modelRevision:'r1',vector:[1,0]},
      {id:'unrelated',organizationId:'a',modelRevision:'r1',vector:[0,1]},
    ];
    expect(rankKnowledgeVectors([1,0],'a','r1',entries,1)).toEqual([{id:'relevant',score:1}]);
  });
  it.each([[],[0,0],[NaN,1],[Infinity,1]].map(query => ({query})))('rejects invalid queries %j', ({query}) => {
    expect(() => rankKnowledgeVectors(query,'a','r1',[])).toThrow();
  });
});
