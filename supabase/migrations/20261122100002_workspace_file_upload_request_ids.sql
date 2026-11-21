-- 20261122100002_workspace_file_upload_request_ids.sql — Q-13: idempotent file uploads.
--
-- POST /api/v1/files created a new file on every successful call, so a client
-- that lost the response and uploaded again ended with two copies. The client
-- may now send an Idempotency-Key (a UUID it keeps until the upload settles).
-- workspace_files.upload_request_id stores it, unique per (organization, owner).
-- (Not named *_key: workspace_files.test.sql guards that no column matching
-- key|path|url|bucket exists, so no storage locator is ever stored.)
-- The value is the client's key;
-- the same key can never create a second live file for that user, even when
-- two uploads race. The app answers a repeat with the existing file.
--
-- - Per owner: another user (or tenant) using the same key gets their own
--   file; keys never collide across users and never reveal another file.
-- - 'failed' rows do not hold the key, so a key is never burned for good.
-- - Not updatable: UPDATE on workspace_files is column-scoped
--   (20261119100003) and upload_request_id is not in that list.
-- - Additive (expand step): existing rows and key-less uploads keep NULL.
--   The table-level SELECT/INSERT grants of 20261119100003 already cover
--   the new column; the RLS policies are unchanged (owner inserts only).
BEGIN;

ALTER TABLE public.workspace_files ADD COLUMN upload_request_id UUID NULL;

CREATE UNIQUE INDEX workspace_files_upload_request_id_unique
  ON public.workspace_files (organization_id, owner_user_id, upload_request_id)
  WHERE upload_request_id IS NOT NULL AND status <> 'failed';

COMMIT;
