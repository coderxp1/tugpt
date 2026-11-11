-- ADR-020 M1 — the tool registry: platform definitions, organization grants,
-- and read-only discovery.
--
-- WHAT THIS IS
--
-- The catalogue of actions TuGPT can perform, and the per-organization record
-- of which of them that organization has granted. Nothing here executes a
-- tool. There is no run, no step, no invocation, no queue and no customer-data
-- write. M1 is the part that can be reviewed and tested on its own: a
-- vocabulary, a permission record, and one read path.
--
-- WHY DEFINITIONS ARE PLATFORM DATA AND GRANTS ARE NOT
--
-- A tool is code plus a manifest. Every organization sees the same catalogue;
-- what differs per organization is whether it may use an entry. A definition
-- edited per customer is a definition nobody can review, version or test, and
-- the first divergence between two organizations' copies of
-- `calendar.find_availability` makes every bug report ambiguous.
--
-- WHY THE GRANT KEY IS (organization_id, tool_key) AND NOT (org, agent, tool)
--
-- ADR-015 D3 and ADR-020 D7 put trust per (org, agent, tool class). There is no
-- agent entity yet, so M1 implements the organization half — the grant an
-- agent will narrow later. The primary key below is deliberately the composite
-- target a child `agent_tool_grants` can foreign-key to, so adding the agent
-- dimension is an addition rather than a rewrite of this table.
--
-- WHY NOTHING IS GRANTED TO THE BROWSER ROLES ON THE CATALOGUE
--
-- Discovery goes through `list_available_tools`, a SECURITY DEFINER function
-- that checks membership first. A table-level SELECT on the catalogue would
-- make that function optional, and the day somebody queries the table directly
-- from a client they bypass the membership check and the RLS policy on the
-- grants in one step. The grant is the boundary, not the policy.

-- ---------------------------------------------------------------------------
-- 1. Platform tool definitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tool_definitions (
  -- Stable dotted identifier, e.g. `calendar.find_availability`. Renaming it
  -- is a migration and a grant rewrite, which is the point: agents, manifests
  -- and (later) the customer API all refer to this string.
  key TEXT PRIMARY KEY,

  -- Monotonic. A tool's input schema changing under a running agent is how a
  -- call that worked yesterday fails today with a validation error nobody can
  -- attribute. A version bump is recorded on the run when the runtime lands.
  version INTEGER NOT NULL CHECK (version >= 1),

  display_name TEXT NOT NULL,
  description TEXT NOT NULL,

  -- JSON Schema, as an object. Not validated against a schema engine here: the
  -- DB's job is to refuse a value that is not a schema at all, and the
  -- validator lands with the execution path that needs it.
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,

  -- Risk class, not a display label. Authorization and trust graduation key on
  -- it, and `irreversible`/`financial` are the two that will require a
  -- deliberate code change as well as a database row before autonomy.
  permission_class TEXT NOT NULL
    CHECK (permission_class IN ('read', 'write', 'irreversible', 'financial')),

  -- What a retried call may assume. `required`: the caller must supply a key
  -- from a source the AI cannot invent. `derived`: the runtime derives one from
  -- (run, step). `none`: the tool is safe to repeat.
  idempotency_mode TEXT NOT NULL
    CHECK (idempotency_mode IN ('required', 'derived', 'none')),

  -- The capability a provider must serve for this tool to be callable, e.g.
  -- `calendar.read`. Never a vendor name — that is ADR-020 D2.
  required_capability TEXT NOT NULL,

  max_runtime_seconds INTEGER NOT NULL
    CHECK (max_runtime_seconds BETWEEN 1 AND 600),

  -- Fail closed. A definition registered but not yet reviewed is invisible to
  -- every organization until somebody turns it on deliberately.
  is_available BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT tool_definitions_key_shape
    CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT tool_definitions_capability_shape
    CHECK (required_capability ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT tool_definitions_description_length
    CHECK (char_length(description) BETWEEN 8 AND 2000),
  CONSTRAINT tool_definitions_schemas_are_objects
    CHECK (jsonb_typeof(input_schema) = 'object' AND jsonb_typeof(output_schema) = 'object')
);

COMMENT ON TABLE public.tool_definitions IS
  'The platform catalogue of actions. Definitions are not tenant data; what an organization may call lives in organization_tool_grants.';

CREATE TRIGGER trigger_tool_definitions_updated_at
  BEFORE UPDATE ON public.tool_definitions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Organization grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organization_tool_grants (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- RESTRICT, not CASCADE: deleting a definition that organizations have
  -- granted should fail loudly rather than silently remove their permission.
  tool_key TEXT NOT NULL REFERENCES public.tool_definitions(key) ON DELETE RESTRICT,

  -- ADR-015 D3. Default is the draft-first state, which is also the safest
  -- interpretation of an unset value.
  trust_state TEXT NOT NULL DEFAULT 'draft_review'
    CHECK (trust_state IN ('draft_review', 'supervised', 'autonomous')),

  -- Caps, interpreted by the runtime that does not exist yet. NULL means no cap
  -- recorded, and the runtime will treat that as "draft_review only" rather
  -- than "unlimited".
  max_actions_per_period INTEGER
    CHECK (max_actions_per_period IS NULL OR max_actions_per_period > 0),
  max_value_per_action NUMERIC(14, 2)
    CHECK (max_value_per_action IS NULL OR max_value_per_action >= 0),

  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  -- Revocation is a timestamp, not a delete: "who had what, when" is the
  -- question an incident asks, and a deleted row cannot answer it.
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The composite primary key is also the target a future agent-scoped child
  -- table foreign-keys to, so tenant consistency is enforced by the schema
  -- rather than by a trigger.
  PRIMARY KEY (organization_id, tool_key),

  CONSTRAINT organization_tool_grants_revocation_shape
    CHECK ((revoked_at IS NULL AND revoked_by IS NULL)
        OR (revoked_at IS NOT NULL))
);

COMMENT ON TABLE public.organization_tool_grants IS
  'Which catalogue entries one organization has granted, under which trust state and caps. Revoked grants stay as evidence.';

CREATE INDEX IF NOT EXISTS idx_org_tool_grants_live
  ON public.organization_tool_grants (organization_id, tool_key)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Registration (service_role only)
-- ---------------------------------------------------------------------------

-- The only write path in M1, and it writes platform data, never customer data.
-- Refusing a version downgrade here means a stale deployment cannot silently
-- rewind a schema the rest of the system has already moved past.
CREATE OR REPLACE FUNCTION public.register_tool_definition(
  p_key TEXT,
  p_version INTEGER,
  p_display_name TEXT,
  p_description TEXT,
  p_input_schema JSONB,
  p_output_schema JSONB,
  p_permission_class TEXT,
  p_idempotency_mode TEXT,
  p_required_capability TEXT,
  p_max_runtime_seconds INTEGER,
  p_is_available BOOLEAN DEFAULT false
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_existing INTEGER;
BEGIN
  SELECT version INTO v_existing
  FROM public.tool_definitions
  WHERE key = p_key;

  IF v_existing IS NOT NULL AND p_version < v_existing THEN
    RAISE EXCEPTION 'tool definition version cannot move backwards: % < %',
      p_version, v_existing
      USING ERRCODE = 'P4T04';
  END IF;

  INSERT INTO public.tool_definitions (
    key, version, display_name, description, input_schema, output_schema,
    permission_class, idempotency_mode, required_capability,
    max_runtime_seconds, is_available
  ) VALUES (
    p_key, p_version, p_display_name, p_description, p_input_schema, p_output_schema,
    p_permission_class, p_idempotency_mode, p_required_capability,
    p_max_runtime_seconds, p_is_available
  )
  ON CONFLICT (key) DO UPDATE SET
    version = EXCLUDED.version,
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    permission_class = EXCLUDED.permission_class,
    idempotency_mode = EXCLUDED.idempotency_mode,
    required_capability = EXCLUDED.required_capability,
    max_runtime_seconds = EXCLUDED.max_runtime_seconds,
    is_available = EXCLUDED.is_available,
    updated_at = pg_catalog.now();

  RETURN p_key;
END;
$$;

REVOKE ALL ON FUNCTION public.register_tool_definition(
  TEXT, INTEGER, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_tool_definition(
  TEXT, INTEGER, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, INTEGER, BOOLEAN
) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Discovery (authenticated members, read-only)
-- ---------------------------------------------------------------------------

-- The one read path. It takes the organization as an argument because the
-- dashboard must be able to ask about the workspace it is displaying, and the
-- answer is gated on the caller being a member of it. The ID is not trusted:
-- a non-member gets P4T01, which is the same answer a nonexistent organization
-- gets, so ids cannot be probed.
CREATE OR REPLACE FUNCTION public.list_available_tools(p_organization_id UUID)
RETURNS TABLE (
  tool_key TEXT,
  version INTEGER,
  display_name TEXT,
  description TEXT,
  permission_class TEXT,
  required_capability TEXT,
  trust_state TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_ACCESSIBLE'
      USING ERRCODE = 'P4T01';
  END IF;

  RETURN QUERY
  SELECT d.key, d.version, d.display_name, d.description,
         d.permission_class, d.required_capability, g.trust_state
  FROM public.tool_definitions d
  JOIN public.organization_tool_grants g
    ON g.tool_key = d.key
   AND g.organization_id = p_organization_id
  WHERE d.is_available
    AND g.revoked_at IS NULL
  ORDER BY d.key;
END;
$$;

COMMENT ON FUNCTION public.list_available_tools(UUID) IS
  'Read-only discovery for one organization. Returns only available, non-revoked grants, and only to a member of that organization (P4T01 otherwise, indistinguishable from a nonexistent organization).';

REVOKE ALL ON FUNCTION public.list_available_tools(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_available_tools(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------

ALTER TABLE public.tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_tool_grants FORCE ROW LEVEL SECURITY;

-- REVOKE ALL first: Supabase's default privileges grant ALL on a new table to
-- anon and authenticated, and a later GRANT would leave TRUNCATE, TRIGGER and
-- REFERENCES behind (the defect 20260904000001 exists to clean up).
REVOKE ALL ON public.tool_definitions FROM anon, authenticated;
REVOKE ALL ON public.organization_tool_grants FROM anon, authenticated;

-- Members read their own organization's grants. No write policy: grants are
-- written by service_role in M1, and a write policy shipped "for later"
-- against an unaudited grant is how a permission table quietly becomes
-- self-service.
CREATE POLICY organization_tool_grants_select
  ON public.organization_tool_grants
  FOR SELECT
  TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

GRANT SELECT ON public.organization_tool_grants TO authenticated;

-- service_role administers the catalogue and the grants. No DELETE on either:
-- a tool is retired with is_available = false and a grant is retired with
-- revoked_at, so evidence is not destroyable by the identity that writes it.
GRANT SELECT, INSERT, UPDATE ON public.tool_definitions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.organization_tool_grants TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Rollback
-- ---------------------------------------------------------------------------
--
-- Forward-only, like every migration here. To reverse manually:
--
--   DROP FUNCTION IF EXISTS public.list_available_tools(UUID);
--   DROP FUNCTION IF EXISTS public.register_tool_definition(
--     TEXT, INTEGER, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, INTEGER, BOOLEAN);
--   DROP TABLE IF EXISTS public.organization_tool_grants;
--   DROP TABLE IF EXISTS public.tool_definitions;
