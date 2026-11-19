-- Workspace chat: persisted citations on agent answers (Agent 4, Q-9).
--
-- Agent turns stream a 'citations' event (the knowledge excerpts the answer
-- was given), but until now nothing was stored, so a reloaded conversation
-- lost its sources. The assistant message now keeps a snapshot of exactly
-- what was streamed, plus whether knowledge was unavailable for that turn.
--
-- * Shape is enforced here, not only in the app: an array of at most 20
--   objects with exactly the keys n, documentId, collectionId, fileId,
--   title, ordinal, snippet (the existing Citation contract), ids as
--   lowercase uuids, title 1..255, snippet <= 2000 characters.
-- * Only assistant messages may carry citations or the flag.
-- * Messages stay append-only (no UPDATE grant), so a stored snapshot cannot
--   be edited afterwards. Read access is unchanged (thread owner only, see
--   messages_owner_read in 20261115000001).
-- * The snapshot is not an authorisation: the API re-checks every cited
--   document against the reader's current access when a thread is restored
--   and omits what the reader can no longer see (lib/chat/store.ts).
--
-- Existing rows get the defaults ('[]', false); the CHECK validation reads
-- the table once. 20261115000001 is frozen; this migration only adds columns.
BEGIN;

CREATE FUNCTION private.valid_message_citations(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 20
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) AS e(c)
      WHERE NOT (CASE WHEN jsonb_typeof(c) <> 'object' THEN false ELSE (
        (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(c) AS o(k))
          = ARRAY['collectionId','documentId','fileId','n','ordinal','snippet','title']::text[]
        AND jsonb_typeof(c->'n') = 'number' AND (c->>'n') ~ '^[1-9][0-9]{0,2}$'
        AND jsonb_typeof(c->'ordinal') = 'number' AND (c->>'ordinal') ~ '^(0|[1-9][0-9]{0,8})$'
        AND jsonb_typeof(c->'documentId') = 'string'
        AND (c->>'documentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(c->'collectionId') = 'string'
        AND (c->>'collectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(c->'fileId') = 'string'
        AND (c->>'fileId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(c->'title') = 'string' AND char_length(c->>'title') BETWEEN 1 AND 255
        AND jsonb_typeof(c->'snippet') = 'string' AND char_length(c->>'snippet') <= 2000
      ) END))
$$;
REVOKE ALL ON FUNCTION private.valid_message_citations(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.valid_message_citations(jsonb) TO authenticated, service_role;

ALTER TABLE public.chat_messages
  ADD COLUMN citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN knowledge_unavailable BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT chat_messages_citations_valid CHECK (private.valid_message_citations(citations)),
  ADD CONSTRAINT chat_messages_citations_assistant_only
    CHECK (role = 'assistant' OR (citations = '[]'::jsonb AND NOT knowledge_unavailable));

COMMENT ON COLUMN public.chat_messages.citations IS
  'Snapshot of the citations streamed with this assistant turn; re-authorised against the reader on restore.';
COMMENT ON COLUMN public.chat_messages.knowledge_unavailable IS
  'True when the agent''s knowledge could not be searched for this assistant turn.';

COMMIT;
