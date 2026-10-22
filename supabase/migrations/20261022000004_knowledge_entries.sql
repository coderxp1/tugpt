-- ===========================================================================
-- Knowledge entries (FAQ v1): workspace-scoped facts for draft grounding.
--
-- Migration: 20261022000004_knowledge_entries.sql
--
-- WHAT THIS IS
--
-- The smallest useful knowledge base: question/answer pairs owned by
-- an organization, which the draft worker retrieves (deterministic
-- keyword selection, no embeddings in v1) and the prompt builder
-- renders as a clearly-subordinated DATA section before the
-- non-negotiable guardrails. Until now, drafts grounded only in the
-- free-text business instructions in ai_draft_configs; the model had
-- no structured facts to answer from, and the anti-invention
-- guardrail (correctly) made it decline questions the business could
-- have answered trivially — opening hours, prices, policies.
--
-- SECURITY SHAPE
--
--   * RLS enabled AND forced. Members of the organization can read;
--     owner/admin can write (the ai_draft_configs policy idiom:
--     private.is_org_member / private.has_org_role). There is no
--     policy path by which one organization can read or write
--     another's entries.
--   * Supabase's default ALL grants to anon/authenticated are
--     revoked (RLS does not restrain TRUNCATE — see
--     20260904000001); authenticated then receives exactly the DML
--     the policies govern.
--   * Entries are CONTENT, never configuration: nothing in this
--     table is executed, and the prompt builder treats entry text as
--     untrusted data (see prompt-scaffolding's knowledge framing).
--     A malicious or mistaken entry can at worst state a wrong fact
--     for a human reviewer to catch — it cannot change the rules,
--     which are appended after it and cannot be removed.
--
-- Deliberately NOT here: embeddings/vector search, a management UI
-- (entries are managed through the API/SQL for the pilot; the
-- dashboard page is a follow-up), per-profile scoping (knowledge is
-- workspace-scoped; an organization has one voice in v1).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.knowledge_entries (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.trim(question)) > 0),
  answer TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.trim(answer)) > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite unique target, the tenant-consistency idiom used by the
-- other org-scoped tables (future composite FKs land on this).
ALTER TABLE public.knowledge_entries
  ADD CONSTRAINT knowledge_entries_id_organization_unique
  UNIQUE (id, organization_id);

CREATE INDEX idx_knowledge_entries_org_enabled
  ON public.knowledge_entries(organization_id, enabled);

ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_entries_select
  ON public.knowledge_entries
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY knowledge_entries_write
  ON public.knowledge_entries
  FOR ALL
  TO authenticated
  USING (
    private.has_org_role(organization_id, auth.uid(),
      ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    private.has_org_role(organization_id, auth.uid(),
      ARRAY['owner', 'admin']::organization_role[])
  );

-- Default ALL grants arrive with the table; take them back, then
-- grant exactly what the policies govern.
REVOKE ALL ON public.knowledge_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_entries TO service_role;

CREATE TRIGGER trigger_knowledge_entries_updated_at
  BEFORE UPDATE ON public.knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
