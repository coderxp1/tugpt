-- Workspace Library (Agent 4): knowledge collections, indexed documents,
-- full-text search, and links from conversations to collections.
--
-- Separate from the older public.knowledge_entries FAQ table
-- (/api/v1/knowledge), which is not changed.
--
-- Authorization:
--   read collection   active member AND (creator OR visibility = 'organization')
--   write collection  active non-viewer member AND (creator OR
--                     (visibility = 'organization' AND owner/admin))
--   org visibility    only owners/admins may create or switch a collection to
--                     'organization' (it publishes content to every member).
--   documents/chunks  inherit from their collection; chunks are written only
--                     through replace_document_chunks(), never directly.
--   adding a document the caller must be able to read the file (files RLS).
-- Retrieval (search_knowledge) is SECURITY INVOKER, so RLS decides per chunk at
-- query time: revoking membership or making a collection private takes effect
-- on the very next search.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.knowledge_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','organization')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX knowledge_collections_org ON public.knowledge_collections (organization_id, updated_at DESC);

CREATE OR REPLACE FUNCTION private.can_read_collection(p_collection UUID, p_user UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.knowledge_collections c
    WHERE c.id = p_collection AND p_user IS NOT NULL
      AND private.is_org_member(c.organization_id, p_user)
      AND (c.owner_user_id = p_user OR c.visibility = 'organization'))
$$;
CREATE OR REPLACE FUNCTION private.can_write_collection(p_collection UUID, p_user UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.knowledge_collections c
    WHERE c.id = p_collection AND p_user IS NOT NULL
      AND private.is_org_member(c.organization_id, p_user)
      AND NOT private.has_org_role(c.organization_id, p_user, ARRAY['viewer']::public.organization_role[])
      AND (c.owner_user_id = p_user
           OR (c.visibility = 'organization'
               AND private.has_org_role(c.organization_id, p_user, ARRAY['owner','admin']::public.organization_role[]))))
$$;
REVOKE ALL ON FUNCTION private.can_read_collection(UUID,UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.can_write_collection(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_read_collection(UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_write_collection(UUID,UUID) TO authenticated;

ALTER TABLE public.knowledge_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_collections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.knowledge_collections TO authenticated;
GRANT UPDATE (name, description, visibility, updated_at) ON public.knowledge_collections TO authenticated;

CREATE POLICY collections_read ON public.knowledge_collections FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND (owner_user_id = auth.uid() OR visibility = 'organization'));
CREATE POLICY collections_insert ON public.knowledge_collections FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid()
    AND private.is_org_member(organization_id, auth.uid())
    AND NOT private.has_org_role(organization_id, auth.uid(), ARRAY['viewer']::public.organization_role[])
    AND (visibility = 'private'
         OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));
CREATE POLICY collections_update ON public.knowledge_collections FOR UPDATE TO authenticated
  USING (private.can_write_collection(id, auth.uid()))
  WITH CHECK (private.is_org_member(organization_id, auth.uid())
    AND (visibility = 'private'
         OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));
CREATE POLICY collections_delete ON public.knowledge_collections FOR DELETE TO authenticated
  USING (private.can_write_collection(id, auth.uid()));

CREATE TABLE public.knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  file_id UUID NOT NULL,
  added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexing','ready','failed','unsupported')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,64}$'),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (collection_id, file_id),
  FOREIGN KEY (collection_id, organization_id) REFERENCES public.knowledge_collections (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id, organization_id) REFERENCES public.workspace_files (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_documents_collection ON public.knowledge_documents (collection_id, created_at DESC);
CREATE INDEX knowledge_documents_file ON public.knowledge_documents (file_id);

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.knowledge_documents TO authenticated;

CREATE POLICY documents_read ON public.knowledge_documents FOR SELECT TO authenticated
  USING (private.can_read_collection(collection_id, auth.uid()));
CREATE POLICY documents_insert ON public.knowledge_documents FOR INSERT TO authenticated
  WITH CHECK (added_by = auth.uid() AND status = 'pending' AND chunk_count = 0
    AND private.can_write_collection(collection_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.workspace_files f
                WHERE f.id = file_id AND f.organization_id = knowledge_documents.organization_id AND f.status = 'ready'));
CREATE POLICY documents_delete ON public.knowledge_documents FOR DELETE TO authenticated
  USING (private.can_write_collection(collection_id, auth.uid()));

CREATE TABLE public.knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  document_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (document_id, organization_id) REFERENCES public.knowledge_documents (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, organization_id) REFERENCES public.knowledge_collections (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunks_tsv ON public.knowledge_chunks USING gin (tsv);
CREATE INDEX knowledge_chunks_collection ON public.knowledge_chunks (collection_id);

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.knowledge_chunks TO authenticated;
CREATE POLICY chunks_read ON public.knowledge_chunks FOR SELECT TO authenticated
  USING (private.can_read_collection(collection_id, auth.uid()));

-- Indexing result writer. Replaces all chunks of a document atomically and
-- sets its status. Caller must be able to write the collection.
CREATE OR REPLACE FUNCTION public.replace_document_chunks(
  p_organization_id UUID, p_document_id UUID, p_status TEXT, p_chunks TEXT[] DEFAULT '{}', p_error_code TEXT DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  d public.knowledge_documents%ROWTYPE;
  v_n INTEGER := COALESCE(array_length(p_chunks, 1), 0);
BEGIN
  SELECT * INTO d FROM public.knowledge_documents k
  WHERE k.id = p_document_id AND k.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT private.can_write_collection(d.collection_id, auth.uid()) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_status NOT IN ('indexing','ready','failed','unsupported') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_status <> 'ready' AND v_n > 0 THEN
    RAISE EXCEPTION 'CHUNKS_REQUIRE_READY' USING ERRCODE = '22023';
  END IF;
  IF v_n > 2000 THEN RAISE EXCEPTION 'TOO_MANY_CHUNKS' USING ERRCODE = '54000'; END IF;
  IF p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z_]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.knowledge_chunks c WHERE c.document_id = d.id;
  IF v_n > 0 THEN
    INSERT INTO public.knowledge_chunks (organization_id, collection_id, document_id, ordinal, content)
    SELECT d.organization_id, d.collection_id, d.id, u.ord - 1, u.chunk
    FROM unnest(p_chunks) WITH ORDINALITY AS u(chunk, ord);
  END IF;
  UPDATE public.knowledge_documents k SET status = p_status, chunk_count = v_n,
    error_code = CASE WHEN p_status IN ('failed','unsupported') THEN p_error_code ELSE NULL END,
    indexed_at = CASE WHEN p_status = 'ready' THEN now() ELSE k.indexed_at END,
    updated_at = now()
  WHERE k.id = d.id;
  UPDATE public.knowledge_collections c SET updated_at = now() WHERE c.id = d.collection_id;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.replace_document_chunks(UUID,UUID,TEXT,TEXT[],TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_document_chunks(UUID,UUID,TEXT,TEXT[],TEXT) TO authenticated;

-- Full-text search over chunks the caller may read. Snippets are plain text
-- (no markup) so the UI never has to render HTML from document content.
CREATE OR REPLACE FUNCTION public.search_knowledge(
  p_organization_id UUID, p_query TEXT, p_collection_ids UUID[] DEFAULT NULL, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (chunk_id UUID, document_id UUID, collection_id UUID, file_id UUID, title TEXT,
               ordinal INTEGER, snippet TEXT, rank REAL)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_q TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_tsq tsquery;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
BEGIN
  IF v_q IS NULL THEN RAISE EXCEPTION 'QUERY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF char_length(v_q) > 200 THEN RAISE EXCEPTION 'QUERY_TOO_LONG' USING ERRCODE = '22023'; END IF;
  IF p_collection_ids IS NOT NULL AND array_length(p_collection_ids, 1) > 50 THEN
    RAISE EXCEPTION 'TOO_MANY_COLLECTIONS' USING ERRCODE = '22023';
  END IF;
  v_tsq := websearch_to_tsquery('simple'::regconfig, v_q);
  IF numnode(v_tsq) = 0 THEN RETURN; END IF;
  RETURN QUERY
  SELECT c.id, c.document_id, c.collection_id, d.file_id, d.title, c.ordinal,
    ts_headline('simple'::regconfig, c.content, v_tsq,
      'StartSel="",StopSel="",MaxWords=40,MinWords=15,MaxFragments=2,FragmentDelimiter=" … "'),
    ts_rank(c.tsv, v_tsq)
  FROM public.knowledge_chunks c
  JOIN public.knowledge_documents d ON d.id = c.document_id AND d.organization_id = c.organization_id
  WHERE c.organization_id = p_organization_id
    AND c.tsv @@ v_tsq
    AND (p_collection_ids IS NULL OR c.collection_id = ANY (p_collection_ids))
    AND d.status = 'ready'
  ORDER BY ts_rank(c.tsv, v_tsq) DESC, c.id
  LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.search_knowledge(UUID,TEXT,UUID[],INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge(UUID,TEXT,UUID[],INTEGER) TO authenticated;

-- Conversation <-> collection links (which knowledge a chat may cite).
CREATE TABLE public.chat_thread_collections (
  thread_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  linked_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, collection_id),
  FOREIGN KEY (thread_id, organization_id) REFERENCES public.chat_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, organization_id) REFERENCES public.knowledge_collections (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX chat_thread_collections_collection ON public.chat_thread_collections (collection_id);
ALTER TABLE public.chat_thread_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_thread_collections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_thread_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_thread_collections TO authenticated;
CREATE POLICY thread_collections_read ON public.chat_thread_collections FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id
                  AND t.organization_id = chat_thread_collections.organization_id AND t.owner_user_id = auth.uid()));
CREATE POLICY thread_collections_insert ON public.chat_thread_collections FOR INSERT TO authenticated
  WITH CHECK (linked_by = auth.uid() AND private.is_org_member(organization_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id
                  AND t.organization_id = chat_thread_collections.organization_id
                  AND t.owner_user_id = auth.uid() AND t.archived_at IS NULL)
    AND private.can_read_collection(collection_id, auth.uid()));
CREATE POLICY thread_collections_delete ON public.chat_thread_collections FOR DELETE TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id
                  AND t.organization_id = chat_thread_collections.organization_id AND t.owner_user_id = auth.uid()));

CREATE OR REPLACE FUNCTION private.workspace_library_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_org UUID; v_action TEXT; v_details JSONB;
BEGIN
  IF TG_TABLE_NAME = 'knowledge_collections' THEN
    IF TG_OP = 'INSERT' THEN
      v_org := NEW.organization_id; v_action := 'workspace.collection.created';
      v_details := jsonb_build_object('collection_id', NEW.id, 'visibility', NEW.visibility);
    ELSIF TG_OP = 'DELETE' THEN
      v_org := OLD.organization_id; v_action := 'workspace.collection.deleted';
      v_details := jsonb_build_object('collection_id', OLD.id);
    ELSIF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      v_org := NEW.organization_id; v_action := 'workspace.collection.visibility_changed';
      v_details := jsonb_build_object('collection_id', NEW.id, 'from', OLD.visibility, 'to', NEW.visibility);
    ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_documents' THEN
    IF TG_OP = 'INSERT' THEN
      v_org := NEW.organization_id; v_action := 'workspace.document.added';
      v_details := jsonb_build_object('document_id', NEW.id, 'collection_id', NEW.collection_id, 'file_id', NEW.file_id);
    ELSE
      v_org := OLD.organization_id; v_action := 'workspace.document.removed';
      v_details := jsonb_build_object('document_id', OLD.id, 'collection_id', OLD.collection_id, 'file_id', OLD.file_id);
    END IF;
  ELSE -- chat_thread_collections
    IF TG_OP = 'INSERT' THEN
      v_org := NEW.organization_id; v_action := 'workspace.thread_collection.linked';
      v_details := jsonb_build_object('thread_id', NEW.thread_id, 'collection_id', NEW.collection_id);
    ELSE
      v_org := OLD.organization_id; v_action := 'workspace.thread_collection.unlinked';
      v_details := jsonb_build_object('thread_id', OLD.thread_id, 'collection_id', OLD.collection_id);
    END IF;
  END IF;
  PERFORM private.workspace_audit(v_org, v_action, TG_TABLE_NAME, v_details);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.workspace_library_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER knowledge_collections_workspace_audit AFTER INSERT OR DELETE OR UPDATE OF visibility
  ON public.knowledge_collections FOR EACH ROW EXECUTE FUNCTION private.workspace_library_audit();
CREATE TRIGGER knowledge_documents_workspace_audit AFTER INSERT OR DELETE
  ON public.knowledge_documents FOR EACH ROW EXECUTE FUNCTION private.workspace_library_audit();
CREATE TRIGGER chat_thread_collections_workspace_audit AFTER INSERT OR DELETE
  ON public.chat_thread_collections FOR EACH ROW EXECUTE FUNCTION private.workspace_library_audit();

COMMIT;
