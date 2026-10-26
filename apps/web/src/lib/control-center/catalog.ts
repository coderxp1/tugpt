// TuGPT Product Control Center — feature catalog.
//
// This is the honest inventory paul asked for: every entry states what
// the repository actually contains, where the evidence lives, and what
// is still missing. Statuses are deliberately narrow — "in the UI" means
// a real page or route a user can reach, "backend" means code and tests
// without a user-facing surface, and nothing here claims a live
// provider integration has been exercised: none has.

export type FeatureStatus =
  | 'in-ui'
  | 'backend-only'
  | 'partial'
  | 'unverified'
  | 'blocked'
  | 'planned';

export interface CatalogEntry {
  id: string;
  name: string;
  status: FeatureStatus;
  /** What a user can actually do today, in one sentence. */
  reality: string;
  /** Repository evidence: files, PRs, commits, test suites. */
  evidence: string;
  /** The concrete next action, or 'none' when the item is complete for the MVP. */
  nextAction: string;
  /** Whether the Control Center lab can exercise it here (pure/mock) or not. */
  lab: 'runnable' | 'blocked' | 'none';
}

export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = {
  'in-ui': 'Implemented and accessible in the UI',
  'backend-only': 'Implemented in the backend, missing UI',
  'partial': 'Partially implemented',
  'unverified': 'Code present, not verified end to end',
  'blocked': 'Blocked by configuration or external integration',
  'planned': 'Planned, not implemented',
};

export const FEATURE_CATALOG: CatalogEntry[] = [
  {
    id: 'whatsapp-inbound',
    name: 'WhatsApp inbound messaging',
    status: 'backend-only',
    reality:
      'The webhook ingests Meta payloads, deduplicates by payload hash, and opens conversations — but there is no live Meta connection, so no real customer message has ever arrived.',
    evidence:
      'apps/web/src/app/api/v1/webhooks/whatsapp/route.ts; apps/worker/src/process-message.ts; migration 20260903000008 (transcript ingest). CI database-tests green on main e82dcecb; worker 460/460.',
    nextAction:
      'Owner gates: Meta app credentials, whatsapp_connections row, webhook subscription, then the pilot enablement decision.',
    lab: 'runnable',
  },
  {
    id: 'whatsapp-outbound',
    name: 'WhatsApp outbound delivery',
    status: 'backend-only',
    reality:
      'Approved drafts enqueue exactly once and the worker sends via the Graph API with permanent/transient failure split — but the kill switch is OFF and no live send has ever happened.',
    evidence:
      'PR #10 (merged): migration 20261022000001 + approve_and_enqueue 20261022000003; apps/worker/src/outbound-worker.ts, whatsapp-send.ts. Worker suites green.',
    nextAction: 'Pilot enablement (separate approval); the token architecture supports one business only.',
    lab: 'runnable',
  },
  {
    id: 'delivery-receipts',
    name: 'Delivery receipts (delivered/read)',
    status: 'in-ui',
    reality:
      'Delivered/read states reach the workspace: the draft detail panel shows Entregado/Leído times once Meta sends status callbacks. Receipts are monotonic, idempotent, and never break ingestion.',
    evidence:
      'PR #16 (merged): migration 20261022000005; lib/whatsapp-normalizer.ts extractWhatsAppStatuses; draft detail panel via toDeliveryView. pgTAP 15, web 543/543 at merge time.',
    nextAction: 'None for the MVP — live callbacks arrive only after a live connection exists.',
    lab: 'runnable',
  },
  {
    id: 'ai-failover',
    name: 'AI provider failover',
    status: 'backend-only',
    reality:
      'Draft generation runs a three-provider failover chain with quotas, but every provider call in tests is mocked — no live model call has been made from this codebase.',
    evidence:
      'packages/ai-orchestration (138 tests), packages/ai-providers (238 tests); ADR-012. No UI surface exposes provider choice or live failover state.',
    nextAction: 'Provision a provider key via the secure path and run one live draft in staging; add provider-status UI only after that.',
    lab: 'none',
  },
  {
    id: 'human-review',
    name: 'Human review and approval',
    status: 'in-ui',
    reality:
      'Reviewers list drafts, edit, approve, reject, assign, and hand a conversation to a human (which stops drafting). Approval and delivery enqueue happen in one atomic transaction; duplicate approvals cannot double-send.',
    evidence:
      'apps/web/src/app/dashboard/drafts, inbox pages; drafts approve/edit/reject/assign/handoff routes; migration 20261022000003 approve_and_enqueue_draft (pgTAP).',
    nextAction: 'None for the MVP — usable today once a tenant session exists.',
    lab: 'runnable',
  },
  {
    id: 'usage-quotas',
    name: 'Usage, quotas, and costs',
    status: 'in-ui',
    reality:
      'The analytics page reports totals from the accounting records (unpriced events counted, never zeroed), with EUR→USD conversion at the seeded ECB rate 1.1234 @ 2026-10-21. Per-organization media quotas exist in the database; no numeric launch limits are configured.',
    evidence:
      'PR #12 (merged): org_usage_summary RPC + /dashboard/analytics; media quota pgTAP (media_quotas.test.sql). Quotas are per-org limits, never invented numbers.',
    nextAction: 'Approve numeric media launch limits and measure latencies before enabling media_generation for any prod org.',
    lab: 'blocked',
  },
  {
    id: 'voice-transcription',
    name: 'Voice-note transcription',
    status: 'backend-only',
    reality:
      'The transcription worker submits audio to Gladia, and a completed transcript becomes the message body and enqueues a draft — gated on both voice_transcription and ai_draft_generation flags. Gladia has never been called from production code.',
    evidence:
      'apps/worker/src/transcription-worker.ts; migration 20260903000008; transcription_worker_rpcs pgTAP. No transcription UI surface exists.',
    nextAction: 'Provision the Gladia key through the vault and run one staged voice note end to end.',
    lab: 'blocked',
  },
  {
    id: 'media-generation',
    name: 'Image / media generation',
    status: 'partial',
    reality:
      'Media job submission, queue, cancellation, and result pages exist in the UI, and the worker pipeline is code-complete — but generation runs on a GPU worker that is not connected to this deployment, and media_generation stays OFF for prod orgs.',
    evidence:
      'PRs #4/#5 (Phase A, merged into the media stack); /dashboard/media pages; media/jobs API routes; media_worker_rpcs pgTAP. Live GPU run separately gated; FLUX.1-schnell is the product model.',
    nextAction: 'Owner decision on GPU access + launch limits; until then the media pages show the flag-off state honestly.',
    lab: 'blocked',
  },
  {
    id: 'appointments',
    name: 'Appointment booking',
    status: 'partial',
    reality:
      'Availability comes from Google free/busy only, OAuth connect/disconnect works in code, and the database CHECK refuses any premature CONFIRMED write. There is no booking UI and no appointments API route — booking is worker + settings-page only, and no Google credentials exist.',
    evidence:
      'PR #8 (merged): packages/appointments (115 tests); /settings/integrations page; google start/callback/disconnect routes. google_calendar_freebusy stays OFF.',
    nextAction: 'Google Cloud project + OAuth credentials (secure path), staging deployment, and the per-org flag — each a separate approval.',
    lab: 'runnable',
  },
  {
    id: 'faq-management',
    name: 'FAQ management and grounded replies',
    status: 'in-ui',
    reality:
      'Owners list, create, edit, enable/disable, and delete FAQ entries, and preview exactly which entries a question retrieves — the preview and the draft worker call the same shared selection function.',
    evidence:
      'PRs #14/#15 (merged): knowledge_entries migration 20261022000004; /dashboard/knowledge page; knowledge API + preview route; packages/database/src/knowledge-selection.ts.',
    nextAction: 'None for the MVP.',
    lab: 'runnable',
  },
  {
    id: 'crm',
    name: 'CRM synchronization',
    status: 'planned',
    reality:
      'No CRM integration code exists in the repository. A HUBSPOT_API_KEY placeholder appears in .env.example, but no route, worker, or sync logic references it. This is deferred work, not a hidden feature.',
    evidence:
      'Search over apps/web/src, apps/worker/src, packages: zero CRM references outside .env.example. Explicitly deferred in the Oct-31 MVP mandate.',
    nextAction: 'None — deferred until after the pilot. Do not scope it now.',
    lab: 'none',
  },
  {
    id: 'voice-agents',
    name: 'Real-time voice agents',
    status: 'planned',
    reality:
      'No real-time voice agent code exists: no realtime API client, no voice session handling, no live conversation loop. Voice in this product means async voice-note transcription only.',
    evidence:
      'Search over apps/web/src, apps/worker/src, packages: zero realtime/voice-agent references. Explicitly deferred in the Oct-31 MVP mandate.',
    nextAction: 'None — deferred until after the pilot.',
    lab: 'none',
  },
  {
    id: 'meeting-intelligence',
    name: 'Meeting intelligence',
    status: 'planned',
    reality:
      'No meeting transcription, summarization, or action-item extraction code exists.',
    evidence:
      'No matching modules, routes, or migrations in the repository. Explicitly deferred in the Oct-31 MVP mandate.',
    nextAction: 'None — deferred until after the pilot.',
    lab: 'none',
  },
];
