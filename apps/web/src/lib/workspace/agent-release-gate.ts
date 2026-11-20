/** UI release gate only; authenticated API/RLS authorization is always required. */
export function workspaceAgentsEnabled(tier: string | undefined, optIn: string | undefined): boolean {
  return tier === 'staging' && optIn === 'true';
}
