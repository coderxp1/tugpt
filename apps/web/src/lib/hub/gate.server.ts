import { loadOrgFeatures } from './features.server';
import { isUsable, type FeatureKey, type FeatureStatus } from './features';

/** The feature's status when it is NOT usable for this organization; null when the page may render. */
export async function blockedFeature(key: FeatureKey): Promise<FeatureStatus | null> {
  const f = (await loadOrgFeatures()).find((x) => x.key === key);
  if (!f) return null;
  return isUsable(f.state) ? null : f;
}
