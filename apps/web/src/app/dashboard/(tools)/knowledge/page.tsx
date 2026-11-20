import { KnowledgeManager } from '@/components/knowledge/KnowledgeManager';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const off = await blockedFeature('knowledge');
  if (off) return <FeatureUnavailable feature={off} about="Knowledge holds the facts about your business that TuGPT uses when it drafts replies." />;
  return <KnowledgeManager />;
}
