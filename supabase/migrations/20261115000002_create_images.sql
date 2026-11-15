-- Create > Images: private per-user image generation history inside an organization.
--
-- Authorization model (docs/create-images.md):
--   * A generation belongs to exactly one (organization, user). Only that user, while
--     still a member of that organization, can read it or record a status change.
--     Owners/admins do NOT see other people's prompts or images.
--   * The row id IS the GPU job id. The GPU service scopes jobs by organization only;
--     the web route reads this row through the caller's RLS-bound client before it
--     asks the GPU for a status or a result, which adds the per-user boundary.
--   * The browser-facing role may only move status/progress fields. Prompt, size,
--     seed, owner and organization are immutable after insert. Forging a status on
--     your own row gains nothing: results are always fetched from the GPU, which
--     enforces its own job state.
--   * No image bytes are stored here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.image_generations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 1000),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 2147483647),
  model_key TEXT NOT NULL CHECK (model_key ~ '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed','cancelled','expired')),
  progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  seconds NUMERIC(8,2) CHECK (seconds IS NULL OR seconds BETWEEN 0 AND 3600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (id, organization_id),
  CHECK ((width, height) IN ((1024,1024),(1280,720),(720,1280)))
);
CREATE INDEX image_generations_owner_recent
  ON public.image_generations (organization_id, owner_user_id, created_at DESC);

ALTER TABLE public.image_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_generations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.image_generations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.image_generations TO authenticated;
GRANT UPDATE (status, progress, error_code, seconds, finished_at) ON public.image_generations TO authenticated;

CREATE POLICY image_generations_owner ON public.image_generations FOR ALL TO authenticated
  USING (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()))
  WITH CHECK (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()));

COMMIT;
