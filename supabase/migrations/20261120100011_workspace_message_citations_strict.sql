-- Workspace chat: close the NULL hole in the citation validator (Agent 4, Q-9b).
--
-- Defect in 20261120100010 (found by Agent 3's independent validation):
--   SELECT private.valid_message_citations('[{}]');  -- returned true
-- For an empty object every per-key test is NULL (jsonb_object_keys yields
-- no rows, so the key array is NULL; c->'n' is NULL, ...). The AND chain was
-- therefore NULL, `WHERE NOT (NULL)` dropped the element, and NOT EXISTS
-- reported the array as valid. A CHECK also passes on NULL, so the same class
-- of bug could let a malformed row in whenever the function returns NULL.
--
-- Fix (forward-only; 20261120100010 is frozen and stays as committed):
-- * The function never returns NULL: every branch is an explicit CASE that
--   ends in true/false, the per-element test uses IS NOT TRUE (NULL counts
--   as invalid), and the whole result is COALESCEd to false.
-- * SQL NULL -> false. JSON null (top level, as an element, or as a key's
--   value) -> false. Not STRICT on purpose: STRICT would return NULL for a
--   NULL argument, and NULL passes a CHECK.
-- * Exactly the seven contract keys: the object must have 7 keys AND contain
--   all of n, documentId, collectionId, fileId, title, ordinal, snippet.
-- * Value rules are unchanged from 20261120100010 (valid data stays valid):
--   n integer 1..999, ordinal integer 0..999999999, ids lowercase canonical
--   uuids, title string 1..255 chars, snippet string <= 2000 chars, array of
--   at most 20 objects.
-- * Same signature, owner, volatility, SECURITY INVOKER, pinned search_path;
--   CREATE OR REPLACE keeps the grants (authenticated, service_role only).
-- * Existing rows are re-validated: the CHECK is dropped and re-added in one
--   ALTER TABLE, which scans every row (independent of RLS, which is FORCEd on
--   chat_messages) under the new function. If any stored row is malformed,
--   this migration fails and rolls back as a whole; nothing is repaired or
--   deleted automatically (see docs/workspace/operations.md). The scan holds
--   an ACCESS EXCLUSIVE lock on chat_messages for its duration.
-- * chat_messages_citations_assistant_only is unchanged: role, citations and
--   knowledge_unavailable are NOT NULL (role also has a value CHECK), so that
--   CHECK cannot evaluate to NULL.
BEGIN;

CREATE OR REPLACE FUNCTION private.valid_message_citations(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    CASE
      WHEN p IS NULL THEN false
      WHEN jsonb_typeof(p) IS DISTINCT FROM 'array' THEN false
      WHEN jsonb_array_length(p) > 20 THEN false
      ELSE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p) AS e(c)
        WHERE (CASE
          WHEN c IS NULL THEN false
          WHEN jsonb_typeof(c) IS DISTINCT FROM 'object' THEN false
          WHEN (SELECT count(*) FROM jsonb_object_keys(c)) <> 7 THEN false
          WHEN NOT (c ?& ARRAY['n','documentId','collectionId','fileId','title','ordinal','snippet']::text[]) THEN false
          WHEN jsonb_typeof(c->'n') IS DISTINCT FROM 'number' THEN false
          WHEN jsonb_typeof(c->'ordinal') IS DISTINCT FROM 'number' THEN false
          WHEN jsonb_typeof(c->'documentId') IS DISTINCT FROM 'string' THEN false
          WHEN jsonb_typeof(c->'collectionId') IS DISTINCT FROM 'string' THEN false
          WHEN jsonb_typeof(c->'fileId') IS DISTINCT FROM 'string' THEN false
          WHEN jsonb_typeof(c->'title') IS DISTINCT FROM 'string' THEN false
          WHEN jsonb_typeof(c->'snippet') IS DISTINCT FROM 'string' THEN false
          ELSE COALESCE(
                (c->>'n') ~ '^[1-9][0-9]{0,2}$'
            AND (c->>'ordinal') ~ '^(0|[1-9][0-9]{0,8})$'
            AND (c->>'documentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND (c->>'collectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND (c->>'fileId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND char_length(c->>'title') BETWEEN 1 AND 255
            AND char_length(c->>'snippet') <= 2000,
            false)
        END) IS NOT TRUE)
    END,
    false)
$$;
-- Unchanged grants, restated so the intent is explicit in this migration too.
REVOKE ALL ON FUNCTION private.valid_message_citations(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.valid_message_citations(jsonb) TO authenticated, service_role;

-- Re-validate every stored row under the corrected function (same name, same definition text).
ALTER TABLE public.chat_messages
  DROP CONSTRAINT chat_messages_citations_valid,
  ADD CONSTRAINT chat_messages_citations_valid CHECK (private.valid_message_citations(citations));

COMMIT;
