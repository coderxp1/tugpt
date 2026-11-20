import { describe, expect, it } from 'vitest';
import { customerModels } from './assistant-capabilities';
const raw = { key: 'legacy-route', label: 'Qwen on IONOS', description: 'https://private-inference.example/model', private: true, toolCalling: true };
describe('customer capability boundary', () => {
 it('strips provider/model labels, descriptions and hosting badges', () => {
  const [m] = customerModels([raw]); expect(m.label).toBe('TuGPT Assistant'); expect(m.description).toBe(''); expect(m.private).toBe(false); expect(m.toolCalling).toBe(true);
 });
 it('does not invent tier routing for multiple legacy models', () => { expect(customerModels([raw, {...raw,key:'second'}])).toEqual([]); });
 it('uses only explicit backend experience metadata and preserves unavailability', () => {
  const models=customerModels([{...raw,experience:'advanced',available:false},{...raw,key:'second',experience:'fast'}]);
  expect(models.map(m=>m.label)).toEqual(['Advanced','Fast']);expect(models[0].available).toBe(false);
 });
});
