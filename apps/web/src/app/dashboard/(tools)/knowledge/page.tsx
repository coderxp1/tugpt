// Knowledge (FAQ) management — server component shell.
//
// Like the analytics page: no session lookup here. The dashboard
// layout resolves the session for the shell, the proxy is the
// page's authentication gate (see proxy-route-coverage.test.ts),
// and the data's authorization is the knowledge API's — session,
// tenant, feature gate, and the table's RLS policies.

import { KnowledgeManager } from '@/components/knowledge/KnowledgeManager';

export default function KnowledgePage() {
  return <KnowledgeManager />;
}
