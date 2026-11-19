-- Workspace conversation management (Agent 4): folders, folder placement,
-- search over titles and message text, and an audit trail for archive,
-- restore, rename, move and delete.
--
-- Authorization model (docs/workspace/backend-api.md):
--   * chat_threads stay owner-only (20261115000001). Nothing here widens that.
--   * A folder belongs to exactly one (organization, user). Only that user, while
--     an active member of the organization, can see or change it.
--   * A thread can only be placed in a folder of the SAME owner and organization.
--     This is a composite foreign key, not an application check, so no client
--     can file a thread into somebody else's folder or another tenant's folder.
--   * Audit rows are written by triggers (SECURITY DEFINER, actor = auth.uid()),
--     so they cannot be skipped by calling the table directly and cannot be
--     forged: authenticated still has no INSERT on audit_logs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.chat_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, owner_user_id)
);
CREATE UNIQUE INDEX chat_folders_owner_name
  ON public.chat_folders (organization_id, owner_user_id, lower(btrim(name)));

ALTER TABLE public.chat_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_folders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_folders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_folders TO authenticated;
GRANT UPDATE (name, updated_at) ON public.chat_folders TO authenticated;
CREATE POLICY folders_owner ON public.chat_folders FOR ALL TO authenticated
  USING (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()))
  WITH CHECK (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()));

-- Placement. ON DELETE SET NULL (folder_id): deleting a folder un-files its
-- threads instead of deleting conversations.
ALTER TABLE public.chat_threads ADD COLUMN folder_id UUID;
ALTER TABLE public.chat_threads ADD CONSTRAINT chat_threads_folder_same_owner
  FOREIGN KEY (folder_id, organization_id, owner_user_id)
  REFERENCES public.chat_folders (id, organization_id, owner_user_id) ON DELETE SET NULL (folder_id);
CREATE INDEX chat_threads_folder ON public.chat_threads (folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX chat_threads_owner_archived
  ON public.chat_threads (organization_id, owner_user_id, updated_at DESC) WHERE archived_at IS NOT NULL;
GRANT UPDATE (folder_id) ON public.chat_threads TO authenticated;

-- Search support. 'simple' configuration: no language-specific stemming, so
-- German, Spanish and English text and technical terms all match as written.
CREATE INDEX chat_messages_content_fts ON public.chat_messages
  USING gin (to_tsvector('simple'::regconfig, content));

-- List and search the caller's own threads. SECURITY INVOKER: RLS on
-- chat_threads/chat_messages is the authorization layer; the explicit owner and
-- organization filters only narrow it further.
CREATE OR REPLACE FUNCTION public.search_chat_threads(
  p_organization_id UUID,
  p_query TEXT DEFAULT NULL,
  p_archived BOOLEAN DEFAULT false,
  p_folder_id UUID DEFAULT NULL,
  p_unfiled BOOLEAN DEFAULT false,
  p_limit INTEGER DEFAULT 50,
  p_before TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (id UUID, title TEXT, model_key TEXT, folder_id UUID, archived_at TIMESTAMPTZ,
               created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, snippet TEXT, match_source TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_q TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_tsq tsquery;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF v_q IS NOT NULL AND char_length(v_q) > 200 THEN
    RAISE EXCEPTION 'QUERY_TOO_LONG' USING ERRCODE = '22023';
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
    AND (p_before IS NULL OR t.updated_at < p_before)
    AND (v_q IS NULL OR strpos(lower(t.title), lower(v_q)) > 0 OR m.content IS NOT NULL)
  ORDER BY t.updated_at DESC, t.id DESC
  LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.search_chat_threads(UUID,TEXT,BOOLEAN,UUID,BOOLEAN,INTEGER,TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_chat_threads(UUID,TEXT,BOOLEAN,UUID,BOOLEAN,INTEGER,TIMESTAMPTZ) TO authenticated;

-- Shared audit writer for Workspace triggers. Not callable by any API role:
-- it is only reachable through the triggers below, which pass real row data.
-- Skips the write while the organization itself is being deleted (cascade),
-- because the audit row would reference a row that no longer exists.
CREATE OR REPLACE FUNCTION private.workspace_audit(p_org UUID, p_action TEXT, p_resource TEXT, p_details JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_actor UUID := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN RETURN; END IF;
  IF v_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor) THEN v_actor := NULL; END IF;
  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (p_org, v_actor, p_action, p_resource, COALESCE(p_details, '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION private.workspace_audit(UUID,TEXT,TEXT,JSONB) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.chat_threads_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM private.workspace_audit(OLD.organization_id, 'workspace.conversation.deleted', 'chat_thread',
      jsonb_build_object('thread_id', OLD.id, 'owner_user_id', OLD.owner_user_id));
    RETURN OLD;
  END IF;
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    PERFORM private.workspace_audit(NEW.organization_id,
      CASE WHEN NEW.archived_at IS NULL THEN 'workspace.conversation.restored' ELSE 'workspace.conversation.archived' END,
      'chat_thread', jsonb_build_object('thread_id', NEW.id));
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    -- Titles are user content: the audit records that a rename happened, not the text.
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.conversation.renamed', 'chat_thread',
      jsonb_build_object('thread_id', NEW.id));
  END IF;
  IF NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.conversation.moved', 'chat_thread',
      jsonb_build_object('thread_id', NEW.id, 'folder_id', NEW.folder_id));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_threads_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER chat_threads_workspace_audit
  AFTER UPDATE OF archived_at, title, folder_id OR DELETE ON public.chat_threads
  FOR EACH ROW EXECUTE FUNCTION private.chat_threads_audit();

CREATE OR REPLACE FUNCTION private.chat_folders_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM private.workspace_audit(OLD.organization_id, 'workspace.folder.deleted', 'chat_folder', jsonb_build_object('folder_id', OLD.id));
    RETURN OLD;
  END IF;
  PERFORM private.workspace_audit(NEW.organization_id, 'workspace.folder.created', 'chat_folder', jsonb_build_object('folder_id', NEW.id));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_folders_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER chat_folders_workspace_audit
  AFTER INSERT OR DELETE ON public.chat_folders
  FOR EACH ROW EXECUTE FUNCTION private.chat_folders_audit();

COMMIT;
