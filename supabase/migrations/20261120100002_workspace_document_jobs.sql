-- Workspace Library (Agent 4): asynchronous document processing.
--
-- Every knowledge document gets exactly one job row (private schema, not
-- exposed through PostgREST). Inserting a document enqueues it; a reindex
-- request re-queues it. The knowledge worker (service_role) leases jobs,
-- extracts/chunks/embeds, and reports completion or failure. Web requests no
-- longer parse documents.
--
--   queued --claim--> running --complete--> done
--                        |  \--fail(retryable, attempts < max)--> queued (backoff)
--                        |   \-fail(final or attempts = max)----> dead
--                        \--lease expired--> reclaimable (counts as an attempt)
--
-- Backoff: 30 s * 2^(attempts-1), capped at 1 h. max_attempts = 5.
-- Leases are tokens: a worker that lost its lease cannot write results.
-- Processing state is mirrored onto knowledge_documents (attempts,
-- next_attempt_at) so the existing RLS-protected API can show it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.knowledge_documents
  ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN embedding_model TEXT CHECK (embedding_model IS NULL OR embedding_model ~ '^[A-Za-z0-9._:/@-]{1,200}$');

-- Users may only supply the identifying columns; processing state is written
-- exclusively by the SECURITY DEFINER functions below.
REVOKE INSERT ON public.knowledge_documents FROM authenticated;
GRANT INSERT (id, organization_id, collection_id, file_id, added_by, title) ON public.knowledge_documents TO authenticated;

-- Chunks are now written only by the worker (complete_document_job). The
-- 20261119100004 in-request writer stays defined but is no longer callable by
-- users, so no client can inject index content bypassing extraction.
REVOKE EXECUTE ON FUNCTION public.replace_document_chunks(UUID,UUID,TEXT,TEXT[],TEXT) FROM authenticated;

CREATE TABLE private.knowledge_document_jobs (
  document_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  leased_by TEXT CHECK (leased_by IS NULL OR leased_by ~ '^[A-Za-z0-9._:-]{1,64}$'),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z_]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, organization_id) REFERENCES public.knowledge_documents (id, organization_id) ON DELETE CASCADE,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX knowledge_document_jobs_ready ON private.knowledge_document_jobs (run_after) WHERE status = 'queued';
CREATE INDEX knowledge_document_jobs_leases ON private.knowledge_document_jobs (lease_expires_at) WHERE status = 'running';
REVOKE ALL ON private.knowledge_document_jobs FROM PUBLIC, anon, authenticated, service_role;

-- Enqueue on insert.
CREATE OR REPLACE FUNCTION private.knowledge_documents_enqueue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO private.knowledge_document_jobs (document_id, organization_id) VALUES (NEW.id, NEW.organization_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.knowledge_documents_enqueue() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER knowledge_documents_enqueue AFTER INSERT ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION private.knowledge_documents_enqueue();

-- Backfill: documents created before this migration that never finished.
INSERT INTO private.knowledge_document_jobs (document_id, organization_id)
SELECT d.id, d.organization_id FROM public.knowledge_documents d WHERE d.status IN ('pending','indexing')
ON CONFLICT (document_id) DO NOTHING;

-- User-facing: re-queue a document (collection writers only). Audited.
CREATE OR REPLACE FUNCTION public.request_document_reindex(p_organization_id UUID, p_document_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d public.knowledge_documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.knowledge_documents k
  WHERE k.id = p_document_id AND k.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT private.can_read_collection(d.collection_id, auth.uid()) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT private.can_write_collection(d.collection_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.knowledge_documents k SET status = 'pending', error_code = NULL, processing_attempts = 0,
    next_attempt_at = now(), updated_at = now() WHERE k.id = d.id;
  INSERT INTO private.knowledge_document_jobs AS j (document_id, organization_id) VALUES (d.id, d.organization_id)
  ON CONFLICT (document_id) DO UPDATE SET status = 'queued', attempts = 0, run_after = now(), lease_token = NULL,
    lease_expires_at = NULL, leased_by = NULL, last_error_code = NULL, updated_at = now();
  PERFORM private.workspace_audit(d.organization_id, 'workspace.document.reindex_requested', 'knowledge_document',
    jsonb_build_object('document_id', d.id, 'collection_id', d.collection_id));
END $$;
REVOKE ALL ON FUNCTION public.request_document_reindex(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_document_reindex(UUID,UUID) TO authenticated;

-- Worker: lease up to p_limit jobs. Expired leases are reclaimed; a job whose
-- attempts are exhausted when its lease expires becomes dead instead.
CREATE OR REPLACE FUNCTION public.claim_document_jobs(p_worker TEXT, p_limit INTEGER DEFAULT 1, p_lease_seconds INTEGER DEFAULT 300)
RETURNS TABLE (document_id UUID, organization_id UUID, collection_id UUID, file_id UUID, media_type TEXT,
               sha256 TEXT, size_bytes BIGINT, attempt INTEGER, lease_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 20);
        v_lease INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 30), 3600);
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9._:-]{1,64}$' THEN RAISE EXCEPTION 'INVALID_WORKER' USING ERRCODE = '22023'; END IF;

  -- Exhausted jobs whose lease ran out: final failure.
  WITH dead AS (
    UPDATE private.knowledge_document_jobs j SET status = 'dead', lease_token = NULL, lease_expires_at = NULL,
      leased_by = NULL, last_error_code = 'PROCESSING_ABANDONED', updated_at = now()
    WHERE j.status = 'running' AND j.lease_expires_at < now() AND j.attempts >= j.max_attempts
    RETURNING j.document_id
  )
  UPDATE public.knowledge_documents k SET status = 'failed', error_code = 'PROCESSING_ABANDONED',
    next_attempt_at = NULL, updated_at = now()
  FROM dead WHERE k.id = dead.document_id;

  RETURN QUERY
  WITH picked AS (
    SELECT j.document_id FROM private.knowledge_document_jobs j
    WHERE (j.status = 'queued' AND j.run_after <= now())
       OR (j.status = 'running' AND j.lease_expires_at < now() AND j.attempts < j.max_attempts)
    ORDER BY j.run_after, j.document_id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ), leased AS (
    UPDATE private.knowledge_document_jobs j SET status = 'running', attempts = j.attempts + 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => v_lease),
      leased_by = p_worker, updated_at = now()
    FROM picked WHERE j.document_id = picked.document_id
    RETURNING j.document_id, j.organization_id, j.attempts, j.lease_token
  ), docs AS (
    UPDATE public.knowledge_documents k SET status = 'indexing', processing_attempts = leased.attempts,
      next_attempt_at = NULL, updated_at = now()
    FROM leased WHERE k.id = leased.document_id
    RETURNING k.id, k.collection_id, k.file_id
  )
  SELECT l.document_id, l.organization_id, docs.collection_id, docs.file_id, f.media_type, f.sha256, f.size_bytes,
         l.attempts, l.lease_token
  FROM leased l JOIN docs ON docs.id = l.document_id
  JOIN public.workspace_files f ON f.id = docs.file_id AND f.organization_id = l.organization_id;
END $$;
REVOKE ALL ON FUNCTION public.claim_document_jobs(TEXT,INTEGER,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(TEXT,INTEGER,INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION private.lease_job(p_document_id UUID, p_lease_token UUID)
RETURNS private.knowledge_document_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE j private.knowledge_document_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.knowledge_document_jobs x WHERE x.document_id = p_document_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'running' OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_expires_at < now() THEN
    RAISE EXCEPTION 'LEASE_LOST' USING ERRCODE = '55000';
  END IF;
  RETURN j;
END $$;
REVOKE ALL ON FUNCTION private.lease_job(UUID,UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Worker: store the outcome. Chunks (and optional embeddings, same order and
-- count) replace the document's previous index atomically.
CREATE OR REPLACE FUNCTION public.complete_document_job(
  p_document_id UUID, p_lease_token UUID, p_status TEXT, p_chunks TEXT[] DEFAULT '{}', p_error_code TEXT DEFAULT NULL,
  p_embedding_model TEXT DEFAULT NULL, p_embeddings TEXT[] DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  j private.knowledge_document_jobs%ROWTYPE;
  d public.knowledge_documents%ROWTYPE;
  v_n INTEGER := COALESCE(array_length(p_chunks, 1), 0);
  v_e INTEGER := COALESCE(array_length(p_embeddings, 1), 0);
BEGIN
  j := private.lease_job(p_document_id, p_lease_token);
  SELECT * INTO d FROM public.knowledge_documents k WHERE k.id = j.document_id AND k.organization_id = j.organization_id FOR UPDATE;
  IF p_status NOT IN ('ready','failed','unsupported') THEN RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = '22023'; END IF;
  IF p_status <> 'ready' AND (v_n > 0 OR v_e > 0) THEN RAISE EXCEPTION 'CHUNKS_REQUIRE_READY' USING ERRCODE = '22023'; END IF;
  IF p_status <> 'ready' AND p_error_code IS NULL THEN RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023'; END IF;
  IF v_n > 2000 THEN RAISE EXCEPTION 'TOO_MANY_CHUNKS' USING ERRCODE = '54000'; END IF;
  IF p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z_]{1,64}$' THEN RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023'; END IF;
  IF v_e > 0 AND (v_e <> v_n OR p_embedding_model IS NULL) THEN RAISE EXCEPTION 'EMBEDDINGS_MISMATCH' USING ERRCODE = '22023'; END IF;
  IF v_e = 0 AND p_embedding_model IS NOT NULL THEN RAISE EXCEPTION 'EMBEDDINGS_MISMATCH' USING ERRCODE = '22023'; END IF;

  DELETE FROM public.knowledge_chunks c WHERE c.document_id = d.id; -- embeddings cascade
  IF v_n > 0 THEN
    INSERT INTO public.knowledge_chunks (organization_id, collection_id, document_id, ordinal, content)
    SELECT d.organization_id, d.collection_id, d.id, u.ord - 1, u.chunk FROM unnest(p_chunks) WITH ORDINALITY AS u(chunk, ord);
  END IF;
  IF v_e > 0 THEN
    INSERT INTO public.knowledge_chunk_embeddings (chunk_id, organization_id, collection_id, document_id, model, dims, embedding)
    SELECT c.id, c.organization_id, c.collection_id, c.document_id, p_embedding_model,
           extensions.vector_dims(u.v::extensions.vector), u.v::extensions.vector
    FROM unnest(p_embeddings) WITH ORDINALITY AS u(v, ord)
    JOIN public.knowledge_chunks c ON c.document_id = d.id AND c.ordinal = u.ord - 1;
  END IF;
  UPDATE public.knowledge_documents k SET status = p_status, chunk_count = v_n,
    error_code = CASE WHEN p_status = 'ready' THEN NULL ELSE p_error_code END,
    indexed_at = CASE WHEN p_status = 'ready' THEN now() ELSE k.indexed_at END,
    embedding_model = CASE WHEN v_e > 0 THEN p_embedding_model ELSE NULL END,
    next_attempt_at = NULL, updated_at = now()
  WHERE k.id = d.id;
  UPDATE public.knowledge_collections c SET updated_at = now() WHERE c.id = d.collection_id;
  UPDATE private.knowledge_document_jobs x SET status = 'done', lease_token = NULL, lease_expires_at = NULL, leased_by = NULL,
    last_error_code = CASE WHEN p_status = 'ready' THEN NULL ELSE p_error_code END, updated_at = now()
  WHERE x.document_id = d.id;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.complete_document_job(UUID,UUID,TEXT,TEXT[],TEXT,TEXT,TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_job(UUID,UUID,TEXT,TEXT[],TEXT,TEXT,TEXT[]) TO service_role;

-- Worker: report a failure. Retryable failures re-queue with backoff until
-- max_attempts; returns the resulting job status ('queued' or 'dead').
CREATE OR REPLACE FUNCTION public.fail_document_job(p_document_id UUID, p_lease_token UUID, p_error_code TEXT, p_retryable BOOLEAN DEFAULT true)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE j private.knowledge_document_jobs%ROWTYPE; v_next TIMESTAMPTZ;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[A-Z_]{1,64}$' THEN RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023'; END IF;
  j := private.lease_job(p_document_id, p_lease_token);
  IF COALESCE(p_retryable, true) AND j.attempts < j.max_attempts THEN
    v_next := now() + make_interval(secs => LEAST(30 * power(2, GREATEST(j.attempts - 1, 0)), 3600));
    UPDATE private.knowledge_document_jobs x SET status = 'queued', run_after = v_next, lease_token = NULL,
      lease_expires_at = NULL, leased_by = NULL, last_error_code = p_error_code, updated_at = now()
    WHERE x.document_id = j.document_id;
    UPDATE public.knowledge_documents k SET status = 'pending', error_code = p_error_code, next_attempt_at = v_next, updated_at = now()
    WHERE k.id = j.document_id;
    RETURN 'queued';
  END IF;
  UPDATE private.knowledge_document_jobs x SET status = 'dead', lease_token = NULL, lease_expires_at = NULL,
    leased_by = NULL, last_error_code = p_error_code, updated_at = now()
  WHERE x.document_id = j.document_id;
  UPDATE public.knowledge_documents k SET status = 'failed', error_code = p_error_code, next_attempt_at = NULL, updated_at = now()
  WHERE k.id = j.document_id;
  RETURN 'dead';
END $$;
REVOKE ALL ON FUNCTION public.fail_document_job(UUID,UUID,TEXT,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_document_job(UUID,UUID,TEXT,BOOLEAN) TO service_role;

-- Worker: extend a lease during long extractions.
CREATE OR REPLACE FUNCTION public.extend_document_job_lease(p_document_id UUID, p_lease_token UUID, p_lease_seconds INTEGER DEFAULT 300)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE j private.knowledge_document_jobs%ROWTYPE; v_until TIMESTAMPTZ;
BEGIN
  j := private.lease_job(p_document_id, p_lease_token);
  v_until := now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 30), 3600));
  UPDATE private.knowledge_document_jobs x SET lease_expires_at = v_until, updated_at = now() WHERE x.document_id = j.document_id;
  RETURN v_until;
END $$;
REVOKE ALL ON FUNCTION public.extend_document_job_lease(UUID,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_document_job_lease(UUID,UUID,INTEGER) TO service_role;

COMMIT;
