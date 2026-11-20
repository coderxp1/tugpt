import { describe, expect, it } from 'vitest';
import { workspaceAgentsEnabled } from './agent-release-gate';
describe('Workspace staging release gate', () => {
  it.each([undefined, 'production', 'development', '', 'STAGING'])('fails closed outside staging: %s', (tier) => {
    expect(workspaceAgentsEnabled(tier, 'true')).toBe(false);
  });
  it.each([undefined, 'false', '1', 'TRUE', ''])('requires exact explicit opt-in: %s', (value) => {
    expect(workspaceAgentsEnabled('staging', value)).toBe(false);
  });
  it('enables the staging customer flow only with both settings', () => {
    expect(workspaceAgentsEnabled('staging', 'true')).toBe(true);
  });
});
