-- Workspace Library (Agent 4): one document per content per collection (Q-8).
--
-- A Library upload is two requests: POST /files, then POST .../documents.
-- When the second response is lost, or the user simply drops the same file
-- again, the client uploads the bytes again under a NEW file id. Without a
-- content key that created a second document with identical chunks, so search
-- returned every hit twice. The (collection_id, file_id) unique key from
-- 20261119100004 only covers retrying with the same file id.
--
-- * content_sha256 is copied from workspace_files by a BEFORE INSERT trigger.
--   It is not in the authenticated INSERT column grant, so clients cannot
--   choose it, and the trigger overwrites it in any case.
-- * A partial unique index makes the guarantee race-free: of two concurrent
--   adds of the same content, one wins and the other gets 23505, which the
--   API turns into "here is the existing document" (200, created=false).
-- * Existing data: rows are backfilled. Pre-existing duplicates are NOT
--   deleted; every duplicate after the oldest keeps content_sha256 NULL, so
--   the index can be built and nothing a user created disappears.
-- * RLS, column grants and the enqueue trigger are unchanged: only documents
--   that pass the existing documents_insert policy get this far.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.knowledge_documents
  ADD COLUMN content_sha256 TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION private.knowledge_documents_content_hash()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Same tenant only; NULL when the file has no hash yet (it is then not
  -- 'ready' and documents_insert refuses the row anyway).
  NEW.content_sha256 := (SELECT f.sha256 FROM public.workspace_files f
                         WHERE f.id = NEW.file_id AND f.organization_id = NEW.organization_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.knowledge_documents_content_hash() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER knowledge_documents_content_hash BEFORE INSERT OR UPDATE OF file_id, organization_id ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION private.knowledge_documents_content_hash();

-- Backfill: the oldest document per (collection, content) keeps the hash.
WITH hashed AS (
  SELECT d.id, f.sha256,
         row_number() OVER (PARTITION BY d.collection_id, f.sha256 ORDER BY d.created_at, d.id) AS rn
  FROM public.knowledge_documents d
  JOIN public.workspace_files f ON f.id = d.file_id AND f.organization_id = d.organization_id
  WHERE f.sha256 IS NOT NULL
)
UPDATE public.knowledge_documents d SET content_sha256 = h.sha256
FROM hashed h WHERE h.id = d.id AND h.rn = 1;

DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM public.knowledge_documents d
  JOIN public.workspace_files f ON f.id = d.file_id AND f.organization_id = d.organization_id
  WHERE f.sha256 IS NOT NULL AND d.content_sha256 IS NULL;
  IF n > 0 THEN
    RAISE NOTICE 'knowledge_documents: % pre-existing duplicate(s) kept without content_sha256 (not deleted)', n;
  END IF;
END $$;

CREATE UNIQUE INDEX knowledge_documents_collection_content
  ON public.knowledge_documents (collection_id, content_sha256) WHERE content_sha256 IS NOT NULL;

COMMIT;
