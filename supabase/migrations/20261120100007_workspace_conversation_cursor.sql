-- Workspace conversations (Agent 4): stable keyset pagination (Q-7).
--
-- 20261119100001 ordered by (updated_at DESC, id DESC) but paged with
-- "updated_at < p_before" alone, so every thread sharing the boundary
-- timestamp with the last row of a page was skipped. (The web layer also
-- rounded the cursor to milliseconds, which skipped threads within the same
-- millisecond; that part is fixed in the app, which now returns an opaque
-- cursor carrying the exact timestamp and the id.)
--
-- * p_before_id is the tie-breaker: with it, the page starts strictly after
--   (p_before, p_before_id) in the same (updated_at DESC, id DESC) order, a
--   row comparison that cannot skip or repeat a row while the rows themselves
--   do not change. id is the primary key, so the order is total.
-- * Without p_before_id the old "updated_at < p_before" behaviour is kept for
--   callers that still send a bare timestamp. p_before_id without p_before is
--   rejected (22023 INVALID_CURSOR).
-- * The limit cap is 101 instead of 100 so the API can ask for one row more
--   than it returns and only hand out a cursor when another page exists.
-- * Everything else is unchanged: SECURITY INVOKER (RLS applies), the
--   caller's own threads in the given organization only, same filters,
--   search, snippets, grants.
--
-- The signature changes (one new trailing parameter with a default), so the
-- old function is dropped and recreated in one transaction. Calls by name
-- (PostgREST) or by position without the new argument keep working.
BEGIN;

DROP FUNCTION public.search_chat_threads(UUID, TEXT, BOOLEAN, UUID, BOOLEAN, INTEGER, TIMESTAMPTZ);

CREATE FUNCTION public.search_chat_threads(
  p_organization_id UUID,
  p_query TEXT DEFAULT NULL,
  p_archived BOOLEAN DEFAULT false,
  p_folder_id UUID DEFAULT NULL,
  p_unfiled BOOLEAN DEFAULT false,
  p_limit INTEGER DEFAULT 50,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_before_id UUID DEFAULT NULL)
RETURNS TABLE (id UUID, title TEXT, model_key TEXT, folder_id UUID, archived_at TIMESTAMPTZ,
               created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, snippet TEXT, match_source TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_q TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_tsq tsquery;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 101);
BEGIN
  IF v_q IS NOT NULL AND char_length(v_q) > 200 THEN
    RAISE EXCEPTION 'QUERY_TOO_LONG' USING ERRCODE = '22023';
  END IF;
  IF p_before_id IS NOT NULL AND p_before IS NULL THEN
    RAISE EXCEPTION 'INVALID_CURSOR' USING ERRCODE = '22023';
  END IF;
  IF v_q IS NOT NULL THEN
    v_tsq := websearch_to_tsquery('simple'::regconfig, v_q);
  END IF;
  RETURN QUERY
  SELECT t.id, t.title, t.model_key, t.folder_id, t.archived_at, t.created_at, t.updated_at,
    CASE WHEN v_q IS NULL THEN NULL
         WHEN strpos(lower(t.title), lower(v_q)) > 0 THEN NULL
         ELSE left(m.content, 240) END,
    CASE WHEN v_q IS NULL THEN NULL
         WHEN strpos(lower(t.title), lower(v_q)) > 0 THEN 'title'
         ELSE 'message' END
  FROM public.chat_threads t
  LEFT JOIN LATERAL (
    SELECT cm.content FROM public.chat_messages cm
    WHERE v_q IS NOT NULL AND cm.thread_id = t.id AND cm.organization_id = t.organization_id
      AND cm.role IN ('user','assistant')
      AND (to_tsvector('simple'::regconfig, cm.content) @@ v_tsq
           OR strpos(lower(cm.content), lower(v_q)) > 0)
    ORDER BY cm.created_at DESC LIMIT 1) m ON true
  WHERE t.organization_id = p_organization_id
    AND t.owner_user_id = auth.uid()
    AND (CASE WHEN p_archived THEN t.archived_at IS NOT NULL ELSE t.archived_at IS NULL END)
    AND (p_folder_id IS NULL OR t.folder_id = p_folder_id)
    AND (NOT p_unfiled OR t.folder_id IS NULL)
    AND (p_before IS NULL
         OR (p_before_id IS NULL AND t.updated_at < p_before)
         OR (p_before_id IS NOT NULL AND (t.updated_at, t.id) < (p_before, p_before_id)))
    AND (v_q IS NULL OR strpos(lower(t.title), lower(v_q)) > 0 OR m.content IS NOT NULL)
  ORDER BY t.updated_at DESC, t.id DESC
  LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.search_chat_threads(UUID,TEXT,BOOLEAN,UUID,BOOLEAN,INTEGER,TIMESTAMPTZ,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_chat_threads(UUID,TEXT,BOOLEAN,UUID,BOOLEAN,INTEGER,TIMESTAMPTZ,UUID) TO authenticated;

COMMIT;
