-- Workspace storage maintenance (Agent 4).
--
--  * Blob deletion outbox: deleting a workspace_files row (by a user, by a
--    cascade, by expiry or by an organization purge) records the blob to delete.
--    The worker drains it; a crash between DB delete and blob delete no longer
--    leaves an orphan behind. The in-request best-effort delete stays as is.
--  * Stale uploads: rows stuck in 'uploading' (the request died between insert
--    and finalise) are removed after a grace period.
--  * Orphan sweep support: the worker lists blob keys and asks which file ids
--    still exist.
--  * Organization purge: once an organization has been soft-deleted
--    (organizations.deleted_at) for longer than a grace period, its workspace
--    data (files, library, agents, folders, approval requests, rate counters)
--    is deleted and its whole blob prefix is queued for deletion. audit_logs are
--    kept; the purge itself is audited once instead of per row.
--
-- Everything here is service_role only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE private.workspace_blob_deletions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL,
  file_id UUID,               -- NULL: the organization's whole prefix
  reason TEXT NOT NULL CHECK (reason IN ('file_deleted','org_purged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_until TIMESTAMPTZ
);
CREATE INDEX workspace_blob_deletions_due ON private.workspace_blob_deletions (next_attempt_at);
REVOKE ALL ON private.workspace_blob_deletions FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.workspace_org_purges (
  organization_id UUID PRIMARY KEY,  -- no FK: the organizations row may go later
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts JSONB NOT NULL
);
REVOKE ALL ON private.workspace_org_purges FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.workspace_files_enqueue_blob_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- An organization purge queues one prefix deletion instead of one per file.
  IF current_setting('tugpt.workspace_purge_org', true) = OLD.organization_id::text THEN RETURN OLD; END IF;
  INSERT INTO private.workspace_blob_deletions (organization_id, file_id, reason)
  VALUES (OLD.organization_id, OLD.id, 'file_deleted');
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION private.workspace_files_enqueue_blob_deletion() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER workspace_files_blob_deletion AFTER DELETE ON public.workspace_files
  FOR EACH ROW EXECUTE FUNCTION private.workspace_files_enqueue_blob_deletion();

-- Per-row audit is skipped only while purging an organization that really is
-- soft-deleted, so the flag cannot be used to hide activity in a live tenant.
CREATE OR REPLACE FUNCTION private.workspace_audit(p_org UUID, p_action TEXT, p_resource TEXT, p_details JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_actor UUID := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN RETURN; END IF;
  IF current_setting('tugpt.workspace_purge_org', true) = p_org::text
     AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.deleted_at IS NOT NULL)
     AND p_action <> 'workspace.organization.purged' THEN
    RETURN;
  END IF;
  IF v_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor) THEN v_actor := NULL; END IF;
  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (p_org, v_actor, p_action, p_resource, COALESCE(p_details, '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION private.workspace_audit(UUID,TEXT,TEXT,JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- Worker: lease due deletions for 5 minutes.
CREATE OR REPLACE FUNCTION public.claim_blob_deletions(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (id BIGINT, organization_id UUID, file_id UUID, attempts INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT d.id FROM private.workspace_blob_deletions d
    WHERE d.next_attempt_at <= now() AND (d.claimed_until IS NULL OR d.claimed_until < now())
    ORDER BY d.next_attempt_at, d.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    FOR UPDATE SKIP LOCKED)
  UPDATE private.workspace_blob_deletions d
     SET claimed_until = now() + interval '5 minutes', attempts = d.attempts + 1
    FROM due WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.file_id, d.attempts;
END $$;

-- Worker: report outcomes. Done rows are removed; failed rows back off
-- (1 min * 2^attempts, capped at 6 h) and are kept for operators to inspect.
CREATE OR REPLACE FUNCTION public.complete_blob_deletions(p_done BIGINT[], p_failed BIGINT[] DEFAULT '{}')
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n INTEGER;
BEGIN
  DELETE FROM private.workspace_blob_deletions d WHERE d.id = ANY(COALESCE(p_done, '{}'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE private.workspace_blob_deletions d
     SET claimed_until = NULL,
         next_attempt_at = now() + LEAST(interval '1 minute' * power(2, LEAST(d.attempts, 20)), interval '6 hours')
   WHERE d.id = ANY(COALESCE(p_failed, '{}'));
  RETURN v_n;
END $$;

-- Orphan sweep: which of these file ids still have a row (any organization).
CREATE OR REPLACE FUNCTION public.workspace_files_existing(p_file_ids UUID[])
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT f.id FROM public.workspace_files f
  WHERE f.id = ANY(p_file_ids[1:1000])
$$;

-- Remove uploads that never finished (minimum grace 15 minutes).
CREATE OR REPLACE FUNCTION public.expire_stale_uploads(p_older_than_minutes INTEGER DEFAULT 60)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n INTEGER;
BEGIN
  DELETE FROM public.workspace_files f
   WHERE f.status = 'uploading'
     AND f.created_at < now() - make_interval(mins => GREATEST(COALESCE(p_older_than_minutes, 60), 15));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.list_purgeable_organizations(p_grace_days INTEGER DEFAULT 30, p_limit INTEGER DEFAULT 20)
RETURNS TABLE (organization_id UUID, deleted_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT o.id, o.deleted_at FROM public.organizations o
  WHERE o.deleted_at IS NOT NULL
    AND o.deleted_at < now() - make_interval(days => GREATEST(COALESCE(p_grace_days, 30), 7))
    AND NOT EXISTS (SELECT 1 FROM private.workspace_org_purges p WHERE p.organization_id = o.id)
  ORDER BY o.deleted_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

-- Deletes the organization's workspace data. Refuses live organizations and
-- organizations inside the grace period (minimum 7 days). Idempotent: a second
-- call finds nothing to delete and returns the stored counts.
CREATE OR REPLACE FUNCTION public.purge_organization_workspace(p_organization_id UUID, p_grace_days INTEGER DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_deleted_at TIMESTAMPTZ;
  v_counts JSONB := '{}'::jsonb;
  v_n INTEGER;
BEGIN
  SELECT o.deleted_at INTO v_deleted_at FROM public.organizations o WHERE o.id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_deleted_at IS NULL OR v_deleted_at >= now() - make_interval(days => GREATEST(COALESCE(p_grace_days, 30), 7)) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_PURGEABLE' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM private.workspace_org_purges p WHERE p.organization_id = p_organization_id) THEN
    RETURN (SELECT p.counts FROM private.workspace_org_purges p WHERE p.organization_id = p_organization_id);
  END IF;

  PERFORM set_config('tugpt.workspace_purge_org', p_organization_id::text, true);

  DELETE FROM public.custom_agents WHERE organization_id = p_organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('custom_agents', v_n);
  DELETE FROM public.knowledge_collections WHERE organization_id = p_organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('knowledge_collections', v_n);
  DELETE FROM public.workspace_files WHERE organization_id = p_organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('workspace_files', v_n);
  DELETE FROM public.approval_requests WHERE organization_id = p_organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('approval_requests', v_n);
  DELETE FROM public.chat_folders WHERE organization_id = p_organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('chat_folders', v_n);
  DELETE FROM private.workspace_rate_limits WHERE bucket LIKE '%:' || p_organization_id::text || ':%';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('rate_limit_counters', v_n);

  INSERT INTO private.workspace_blob_deletions (organization_id, file_id, reason)
  VALUES (p_organization_id, NULL, 'org_purged');
  INSERT INTO private.workspace_org_purges (organization_id, counts) VALUES (p_organization_id, v_counts);
  PERFORM private.workspace_audit(p_organization_id, 'workspace.organization.purged', 'organization', v_counts);
  PERFORM set_config('tugpt.workspace_purge_org', '', true);
  RETURN v_counts;
END $$;

REVOKE ALL ON FUNCTION public.claim_blob_deletions(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_blob_deletions(BIGINT[],BIGINT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_files_existing(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_uploads(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_purgeable_organizations(INTEGER,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_organization_workspace(UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_blob_deletions(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_blob_deletions(BIGINT[],BIGINT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_files_existing(UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_stale_uploads(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_purgeable_organizations(INTEGER,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_organization_workspace(UUID,INTEGER) TO service_role;

COMMIT;
