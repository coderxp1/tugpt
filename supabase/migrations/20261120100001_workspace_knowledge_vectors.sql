-- Workspace Library (Agent 4): semantic retrieval.
--
-- Adds pgvector, one embedding per knowledge chunk, and hybrid search that
-- fuses full-text and vector rankings with Reciprocal Rank Fusion (k = 60).
--
-- Tenant isolation and source permissions are unchanged from 20261119100004:
--   * embeddings carry organization_id/collection_id with composite FKs to the
--     chunk, and are readable only through can_read_collection();
--   * nobody but the knowledge worker (service_role, via
--     complete_document_job in 20261120100002) writes embeddings;
--   * search_knowledge_hybrid is SECURITY INVOKER: RLS on chunks, documents
--     and embeddings decides per row at query time.
--
-- Index strategy: exact scan, pre-filtered by organization (and collection
-- when given). Vectors have no fixed dimension at the column level, because
-- the embedding model is deployment configuration; an HNSW index needs a
-- fixed dimension and is added per deployment once the model is chosen
-- (documented in docs/workspace/backend-api.md). Rows from other models or
-- dimensions are never compared (model + dims are filters).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Composite target for the embedding FK (id alone is already unique).
ALTER TABLE public.knowledge_chunks ADD CONSTRAINT knowledge_chunks_id_org_collection_doc_key
  UNIQUE (id, organization_id, collection_id, document_id);

CREATE TABLE public.knowledge_chunk_embeddings (
  chunk_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  document_id UUID NOT NULL,
  model TEXT NOT NULL CHECK (model ~ '^[A-Za-z0-9._:/@-]{1,200}$'),
  dims INTEGER NOT NULL CHECK (dims BETWEEN 1 AND 4096),
  embedding extensions.vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (extensions.vector_dims(embedding) = dims),
  FOREIGN KEY (chunk_id, organization_id, collection_id, document_id)
    REFERENCES public.knowledge_chunks (id, organization_id, collection_id, document_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunk_embeddings_scope ON public.knowledge_chunk_embeddings (organization_id, model, dims, collection_id);
CREATE INDEX knowledge_chunk_embeddings_document ON public.knowledge_chunk_embeddings (document_id);

ALTER TABLE public.knowledge_chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunk_embeddings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_chunk_embeddings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.knowledge_chunk_embeddings TO authenticated;
CREATE POLICY chunk_embeddings_read ON public.knowledge_chunk_embeddings FOR SELECT TO authenticated
  USING (private.can_read_collection(collection_id, auth.uid()));

-- Hybrid retrieval. p_query is always required (it drives snippets and FTS);
-- p_query_embedding is optional (pgvector text literal, e.g. '[0.1,0.2]') and
-- must come with p_embedding_model. Without an embedding this degrades to
-- full-text search, so search never depends on the embedding service.
CREATE OR REPLACE FUNCTION public.search_knowledge_hybrid(
  p_organization_id UUID, p_query TEXT, p_query_embedding TEXT DEFAULT NULL, p_embedding_model TEXT DEFAULT NULL,
  p_collection_ids UUID[] DEFAULT NULL, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (chunk_id UUID, document_id UUID, collection_id UUID, file_id UUID, title TEXT, ordinal INTEGER,
               snippet TEXT, rank REAL, fts_rank REAL, semantic_score REAL, match TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_q TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_tsq tsquery;
  v_vec extensions.vector;
  v_dims INTEGER;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_pool INTEGER;
BEGIN
  IF v_q IS NULL THEN RAISE EXCEPTION 'QUERY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF char_length(v_q) > 200 THEN RAISE EXCEPTION 'QUERY_TOO_LONG' USING ERRCODE = '22023'; END IF;
  IF p_collection_ids IS NOT NULL AND array_length(p_collection_ids, 1) > 50 THEN
    RAISE EXCEPTION 'TOO_MANY_COLLECTIONS' USING ERRCODE = '22023';
  END IF;
  IF (p_query_embedding IS NULL) <> (p_embedding_model IS NULL) THEN
    RAISE EXCEPTION 'INVALID_EMBEDDING' USING ERRCODE = '22023';
  END IF;
  IF p_query_embedding IS NOT NULL THEN
    IF char_length(p_query_embedding) > 100000 OR p_embedding_model !~ '^[A-Za-z0-9._:/@-]{1,200}$' THEN
      RAISE EXCEPTION 'INVALID_EMBEDDING' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_vec := p_query_embedding::extensions.vector;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_EMBEDDING' USING ERRCODE = '22023';
    END;
    v_dims := extensions.vector_dims(v_vec);
    IF v_dims > 4096 THEN RAISE EXCEPTION 'INVALID_EMBEDDING' USING ERRCODE = '22023'; END IF;
  END IF;
  v_tsq := websearch_to_tsquery('simple'::regconfig, v_q);
  IF numnode(v_tsq) = 0 THEN v_tsq := NULL; END IF;
  IF v_tsq IS NULL AND v_vec IS NULL THEN RETURN; END IF;
  v_pool := v_limit * 4;

  RETURN QUERY
  WITH fts AS (
    SELECT c.id AS cid, ts_rank(c.tsv, v_tsq) AS score,
           row_number() OVER (ORDER BY ts_rank(c.tsv, v_tsq) DESC, c.id) AS r
    FROM public.knowledge_chunks c
    JOIN public.knowledge_documents d ON d.id = c.document_id AND d.organization_id = c.organization_id
    WHERE v_tsq IS NOT NULL
      AND c.organization_id = p_organization_id
      AND c.tsv @@ v_tsq
      AND (p_collection_ids IS NULL OR c.collection_id = ANY (p_collection_ids))
      AND d.status = 'ready'
    ORDER BY ts_rank(c.tsv, v_tsq) DESC, c.id
    LIMIT v_pool
  ), sem AS (
    SELECT e.chunk_id AS cid, (1 - (e.embedding OPERATOR(extensions.<=>) v_vec))::real AS score,
           row_number() OVER (ORDER BY e.embedding OPERATOR(extensions.<=>) v_vec, e.chunk_id) AS r
    FROM public.knowledge_chunk_embeddings e
    JOIN public.knowledge_documents d ON d.id = e.document_id AND d.organization_id = e.organization_id
    WHERE v_vec IS NOT NULL
      AND e.organization_id = p_organization_id
      AND e.model = p_embedding_model
      AND e.dims = v_dims
      AND (p_collection_ids IS NULL OR e.collection_id = ANY (p_collection_ids))
      AND d.status = 'ready'
    ORDER BY e.embedding OPERATOR(extensions.<=>) v_vec, e.chunk_id
    LIMIT v_pool
  ), fused AS (
    SELECT u.cid, SUM(1.0 / (60 + u.r))::real AS rrf,
           MAX(u.fts_score)::real AS fts_score, MAX(u.sem_score)::real AS sem_score
    FROM (
      SELECT fts.cid, fts.r, fts.score AS fts_score, NULL::real AS sem_score FROM fts
      UNION ALL
      SELECT sem.cid, sem.r, NULL::real, sem.score FROM sem
    ) u
    GROUP BY u.cid
  )
  SELECT c.id, c.document_id, c.collection_id, d.file_id, d.title, c.ordinal,
    CASE WHEN f.fts_score IS NOT NULL THEN
      ts_headline('simple'::regconfig, c.content, v_tsq,
        'StartSel="",StopSel="",MaxWords=40,MinWords=15,MaxFragments=2,FragmentDelimiter=" … "')
    ELSE left(regexp_replace(c.content, '\s+', ' ', 'g'), 300) END,
    f.rrf, f.fts_score, f.sem_score,
    CASE WHEN f.fts_score IS NOT NULL AND f.sem_score IS NOT NULL THEN 'hybrid'
         WHEN f.fts_score IS NOT NULL THEN 'keyword' ELSE 'semantic' END
  FROM fused f
  JOIN public.knowledge_chunks c ON c.id = f.cid
  JOIN public.knowledge_documents d ON d.id = c.document_id AND d.organization_id = c.organization_id
  ORDER BY f.rrf DESC, c.id
  LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.search_knowledge_hybrid(UUID,TEXT,TEXT,TEXT,UUID[],INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge_hybrid(UUID,TEXT,TEXT,TEXT,UUID[],INTEGER) TO authenticated;

COMMIT;
