-- Workspace files (Agent 4): metadata, ownership, visibility and conversation
-- attachments. File BYTES live in a vendor-neutral blob store (filesystem or
-- S3-compatible, see apps/web/src/lib/workspace-data/storage.ts). The storage
-- key is derived from (organization_id, id) on the server and is never stored
-- here, returned by the API, or shown to the browser.
--
-- Authorization:
--   read    uploader always; any active member when visibility = 'organization'
--           (status 'ready' only). Owners/admins do NOT read other users'
--           private files.
--   create  any active member, as themselves, status 'uploading' only.
--   update  uploader only: status uploading -> ready/failed and filename.
--   delete  uploader; owner/admin for organization-visible files.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.workspace_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255
    AND filename !~ '[[:cntrl:]/\\]' AND filename NOT IN ('.', '..')),
  media_type TEXT NOT NULL CHECK (media_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$' AND char_length(media_type) <= 127),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 0 AND 52428800),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','organization')),
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  CHECK (status <> 'ready' OR sha256 IS NOT NULL)
);
CREATE INDEX workspace_files_owner ON public.workspace_files (organization_id, owner_user_id, created_at DESC);
CREATE INDEX workspace_files_org_visible ON public.workspace_files (organization_id, created_at DESC)
  WHERE visibility = 'organization' AND status = 'ready';

ALTER TABLE public.workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_files FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_files FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.workspace_files TO authenticated;
GRANT UPDATE (filename, status, sha256, size_bytes, updated_at) ON public.workspace_files TO authenticated;

CREATE POLICY files_read ON public.workspace_files FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND (owner_user_id = auth.uid() OR (visibility = 'organization' AND status = 'ready')));
CREATE POLICY files_insert ON public.workspace_files FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid() AND status = 'uploading'
    AND private.is_org_member(organization_id, auth.uid())
    -- viewers are read-only members
    AND NOT private.has_org_role(organization_id, auth.uid(), ARRAY['viewer']::public.organization_role[]));
CREATE POLICY files_update ON public.workspace_files FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()))
  WITH CHECK (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()));
CREATE POLICY files_delete ON public.workspace_files FOR DELETE TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()) AND (owner_user_id = auth.uid()
    OR (visibility = 'organization'
        AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]))));

-- Status may only move forward: uploading -> ready | failed. A ready file's
-- content (size/hash) is immutable, so a download can never change silently.
CREATE OR REPLACE FUNCTION private.workspace_files_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'uploading' AND NEW.status IN ('ready','failed')) THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'uploading' AND (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes) THEN
    RAISE EXCEPTION 'FILE_CONTENT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.workspace_files_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER workspace_files_guard BEFORE UPDATE ON public.workspace_files
  FOR EACH ROW EXECUTE FUNCTION private.workspace_files_guard();

-- Attachments: a ready file the caller can read, on a thread the caller owns,
-- in the same organization (composite FKs make cross-tenant links impossible).
CREATE TABLE public.chat_thread_attachments (
  thread_id UUID NOT NULL,
  file_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  attached_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, file_id),
  FOREIGN KEY (thread_id, organization_id) REFERENCES public.chat_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id, organization_id) REFERENCES public.workspace_files (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX chat_thread_attachments_file ON public.chat_thread_attachments (file_id);
ALTER TABLE public.chat_thread_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_thread_attachments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_thread_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_thread_attachments TO authenticated;

CREATE POLICY attachments_owner ON public.chat_thread_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id AND t.organization_id = chat_thread_attachments.organization_id
                   AND t.owner_user_id = auth.uid())
         AND private.is_org_member(organization_id, auth.uid()));
CREATE POLICY attachments_insert ON public.chat_thread_attachments FOR INSERT TO authenticated
  WITH CHECK (attached_by = auth.uid() AND private.is_org_member(organization_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id AND t.organization_id = chat_thread_attachments.organization_id
                  AND t.owner_user_id = auth.uid() AND t.archived_at IS NULL)
    -- the file must be visible to the caller under files_read (RLS applies inside the subquery)
    AND EXISTS (SELECT 1 FROM public.workspace_files f WHERE f.id = file_id AND f.organization_id = chat_thread_attachments.organization_id
                  AND f.status = 'ready'));
CREATE POLICY attachments_delete ON public.chat_thread_attachments FOR DELETE TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id AND t.organization_id = chat_thread_attachments.organization_id
                  AND t.owner_user_id = auth.uid()));

CREATE OR REPLACE FUNCTION private.workspace_files_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM private.workspace_audit(OLD.organization_id, 'workspace.file.deleted', 'workspace_file',
      jsonb_build_object('file_id', OLD.id, 'owner_user_id', OLD.owner_user_id, 'size_bytes', OLD.size_bytes, 'visibility', OLD.visibility));
    RETURN OLD;
  END IF;
  IF NEW.status = 'ready' AND OLD.status IS DISTINCT FROM 'ready' THEN
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.file.uploaded', 'workspace_file',
      jsonb_build_object('file_id', NEW.id, 'media_type', NEW.media_type, 'size_bytes', NEW.size_bytes,
                         'sha256', NEW.sha256, 'visibility', NEW.visibility));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.workspace_files_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER workspace_files_workspace_audit AFTER UPDATE OF status OR DELETE ON public.workspace_files
  FOR EACH ROW EXECUTE FUNCTION private.workspace_files_audit();

CREATE OR REPLACE FUNCTION private.chat_thread_attachments_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM private.workspace_audit(OLD.organization_id, 'workspace.attachment.removed', 'chat_thread',
      jsonb_build_object('thread_id', OLD.thread_id, 'file_id', OLD.file_id));
    RETURN OLD;
  END IF;
  PERFORM private.workspace_audit(NEW.organization_id, 'workspace.attachment.added', 'chat_thread',
    jsonb_build_object('thread_id', NEW.thread_id, 'file_id', NEW.file_id));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_thread_attachments_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER chat_thread_attachments_workspace_audit AFTER INSERT OR DELETE ON public.chat_thread_attachments
  FOR EACH ROW EXECUTE FUNCTION private.chat_thread_attachments_audit();

COMMIT;
