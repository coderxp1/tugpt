-- 20261121700002_usage_accounting.sql — Dashboard backend M2 (Agent 6): usage & cost accounting.
-- Forward-only. Extends provider_usage_events (no parallel ledger) and keeps three things apart:
--   * quantities (requests, tokens) with how they were obtained: usage_basis reported|estimated|unavailable
--   * ESTIMATED internal cost   = cost_micros / accounting_cost_micros, priced from provider_prices (unchanged)
--   * ACTUAL internal cost      = actual_cost_* , NULL until an invoice/provider reconciliation writes it
-- Nothing here invents a price: an unknown price or unknown usage leaves cost NULL ("unavailable").
--
-- Customer visibility: public.org_usage_report returns features, requests and tokens only — never
-- provider, model, endpoint, price or cost. provider_usage_events stays service_role-only. The old
-- member-callable public.org_usage_summary (provider/model/cost per row) is revoked from authenticated.
--
-- Chat recording: public.record_chat_usage is sso_control/service_role only (the web chat route already
-- authors assistant messages through sso_control). Idempotent per (organization, 'chat:<turn>:<call>').

-- 1. Columns ---------------------------------------------------------------------------------------
ALTER TABLE public.provider_usage_events
  ADD COLUMN user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN feature TEXT,
  ADD COLUMN outcome TEXT NOT NULL DEFAULT 'succeeded',
  ADD COLUMN usage_basis TEXT NOT NULL DEFAULT 'reported',
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN chat_thread_id UUID,
  ADD COLUMN chat_turn_id UUID,
  ADD COLUMN actual_cost_micros BIGINT,
  ADD COLUMN actual_cost_currency CHAR(3),
  ADD COLUMN actual_cost_source TEXT,
  ADD COLUMN actual_cost_recorded_at TIMESTAMPTZ;

ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_feature_known
    CHECK (feature IS NULL OR feature IN ('chat', 'agents', 'drafts', 'transcription', 'images')),
  ADD CONSTRAINT provider_usage_events_outcome_known
    CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT provider_usage_events_usage_basis_known
    CHECK (usage_basis IN ('reported', 'estimated', 'unavailable')),
  ADD CONSTRAINT provider_usage_events_idempotency_key_shape
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[a-z]{2,16}:[A-Za-z0-9:_-]{1,190}$'),
  ADD CONSTRAINT provider_usage_events_actual_cost_nonneg
    CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  ADD CONSTRAINT provider_usage_events_actual_cost_complete
    CHECK ((actual_cost_micros IS NULL) = (actual_cost_currency IS NULL)
       AND (actual_cost_micros IS NULL) = (actual_cost_source IS NULL)
       AND (actual_cost_micros IS NULL) = (actual_cost_recorded_at IS NULL)),
  ADD CONSTRAINT provider_usage_events_actual_cost_currency
    CHECK (actual_cost_currency IS NULL OR actual_cost_currency IN ('USD', 'EUR')),
  ADD CONSTRAINT provider_usage_events_actual_cost_source_len
    CHECK (actual_cost_source IS NULL OR char_length(actual_cost_source) BETWEEN 8 AND 300),
  ADD CONSTRAINT provider_usage_events_unavailable_is_unpriced
    CHECK (usage_basis <> 'unavailable' OR cost_micros IS NULL),
  -- A thread reference never crosses tenants; deleting a thread keeps the usage row (PG15 column list).
  ADD CONSTRAINT provider_usage_events_chat_thread_fk
    FOREIGN KEY (chat_thread_id, organization_id)
    REFERENCES public.chat_threads (id, organization_id) ON DELETE SET NULL (chat_thread_id);

CREATE UNIQUE INDEX provider_usage_events_idempotency
  ON public.provider_usage_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_provider_usage_events_org_user_time
  ON public.provider_usage_events (organization_id, user_id, occurred_at DESC);

COMMENT ON COLUMN public.provider_usage_events.cost_micros IS
  'ESTIMATED internal cost from provider_prices at call time; NULL when a price or the usage is unknown.';
COMMENT ON COLUMN public.provider_usage_events.actual_cost_micros IS
  'ACTUAL internal cost from a provider invoice/report reconciliation; NULL until reconciled. Never derived from cost_micros.';
COMMENT ON COLUMN public.provider_usage_events.usage_basis IS
  'reported = quantities returned by the provider; estimated = computed by TuGPT; unavailable = no usage known (cost NULL).';
COMMENT ON COLUMN public.provider_usage_events.feature IS
  'Customer-facing feature key. Legacy rows are NULL and are classified at read time (drafts/transcription/other).';

-- 2. Recorder for chat / agent turns (server only) ---------------------------------------------------
CREATE FUNCTION public.record_chat_usage(
  p_organization_id UUID,
  p_user_id UUID,
  p_thread_id UUID,
  p_turn_id UUID,
  p_call_index INTEGER,
  p_feature TEXT,
  p_provider TEXT,
  p_model TEXT,
  p_input_tokens BIGINT,
  p_output_tokens BIGINT,
  p_usage_basis TEXT,
  p_outcome TEXT,
  p_request_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_key TEXT;
  v_id UUID;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_thread_id IS NULL OR p_turn_id IS NULL
     OR p_call_index IS NULL OR p_call_index < 0 OR p_call_index > 63 THEN
    RAISE EXCEPTION 'Invalid usage reference' USING ERRCODE = 'P3U01';
  END IF;
  IF p_feature IS NULL OR p_feature NOT IN ('chat', 'agents')
     OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'cancelled')
     OR p_usage_basis IS NULL OR p_usage_basis NOT IN ('reported', 'estimated', 'unavailable') THEN
    RAISE EXCEPTION 'Invalid usage classification' USING ERRCODE = 'P3U01';
  END IF;
  IF p_provider IS NULL OR p_provider !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     OR (p_model IS NOT NULL AND (char_length(p_model) NOT BETWEEN 1 AND 200))
     OR (p_request_id IS NOT NULL AND char_length(p_request_id) > 200) THEN
    RAISE EXCEPTION 'Invalid usage attribution' USING ERRCODE = 'P3U01';
  END IF;
  IF p_usage_basis = 'unavailable' THEN
    IF p_input_tokens IS NOT NULL OR p_output_tokens IS NOT NULL THEN
      RAISE EXCEPTION 'Unavailable usage carries no quantities' USING ERRCODE = 'P3U01';
    END IF;
  ELSIF p_input_tokens IS NULL OR p_output_tokens IS NULL
     OR p_input_tokens NOT BETWEEN 0 AND 10000000 OR p_output_tokens NOT BETWEEN 0 AND 10000000 THEN
    RAISE EXCEPTION 'Invalid token quantities' USING ERRCODE = 'P3U01';
  END IF;

  -- Tenant binding: the thread belongs to this organization and to this user, who is a member.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                 WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id)
     OR NOT EXISTS (SELECT 1 FROM public.chat_threads t
                    WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
                      AND t.owner_user_id = p_user_id) THEN
    RAISE EXCEPTION 'Usage target not found' USING ERRCODE = 'P3U02';
  END IF;

  v_key := 'chat:' || p_turn_id::text || ':' || p_call_index::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text || '|' || v_key, 0));
  SELECT e.id INTO v_id FROM public.provider_usage_events e
   WHERE e.organization_id = p_organization_id AND e.idempotency_key = v_key;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('event_id', v_id, 'duplicate', true);
  END IF;

  v_id := private.record_provider_usage(
    p_organization_id, 'text', p_provider, p_model,
    pg_catalog.jsonb_build_object('input_tokens', COALESCE(p_input_tokens, 0),
                                  'output_tokens', COALESCE(p_output_tokens, 0)),
    NULL, p_request_id, NULL, NULL,
    pg_catalog.jsonb_build_object('source', 'chat'));

  IF p_usage_basis = 'unavailable' THEN
    -- Unknown usage must not look like a known zero cost.
    UPDATE public.provider_usage_components SET unit_price = NULL, cost_micros = NULL WHERE event_id = v_id;
    UPDATE public.provider_usage_events
       SET cost_micros = NULL, currency = NULL, accounting_cost_micros = NULL, accounting_currency = NULL,
           fx_rate = NULL, fx_rate_date = NULL
     WHERE id = v_id;
  END IF;

  UPDATE public.provider_usage_events
     SET user_id = p_user_id, feature = p_feature, outcome = p_outcome, usage_basis = p_usage_basis,
         idempotency_key = v_key, chat_thread_id = p_thread_id, chat_turn_id = p_turn_id
   WHERE id = v_id;

  RETURN pg_catalog.jsonb_build_object('event_id', v_id, 'duplicate', false);
END;
$$;

COMMENT ON FUNCTION public.record_chat_usage(UUID, UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT) IS
  'Server-only (sso_control/service_role): records one model call of a chat/agent turn. Idempotent per '
  '(organization, chat:<turn>:<call_index>) so retries never double-count. Failed/cancelled calls are recorded '
  'with outcome and, when the provider returned no usage, usage_basis=unavailable and NULL cost.';

REVOKE ALL ON FUNCTION public.record_chat_usage(UUID, UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chat_usage(UUID, UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT)
  TO sso_control, service_role;

-- 3. Customer-facing usage report (no provider/model/cost) -------------------------------------------
CREATE FUNCTION public.org_usage_report(
  p_organization_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_scope TEXT DEFAULT 'self'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_role public.organization_role;
  v_tz TEXT;
  v_result JSONB;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = 'P3J01';
  END IF;
  SELECT m.role, COALESCE(o.time_zone, 'UTC') INTO v_role, v_tz
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id AND o.deleted_at IS NULL
   WHERE m.organization_id = p_organization_id AND m.user_id = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P3J02';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'Invalid time window' USING ERRCODE = 'P3J03';
  END IF;
  IF p_to - p_from > INTERVAL '366 days' THEN
    RAISE EXCEPTION 'Time window too large' USING ERRCODE = 'P3J04';
  END IF;
  IF p_bucket IS NULL OR p_bucket NOT IN ('day', 'month') OR p_scope IS NULL OR p_scope NOT IN ('organization', 'self') THEN
    RAISE EXCEPTION 'Invalid report parameters' USING ERRCODE = 'P3U03';
  END IF;
  IF p_scope = 'organization' AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Organization-wide usage requires owner or admin' USING ERRCODE = 'P3S02';
  END IF;

  WITH e AS (
    SELECT ev.id, ev.user_id, ev.occurred_at, ev.outcome, ev.usage_basis,
           COALESCE(ev.feature,
                    CASE WHEN ev.draft_generation_job_id IS NOT NULL THEN 'drafts'
                         WHEN ev.modality = 'audio' THEN 'transcription'
                         ELSE 'other' END) AS feature
      FROM public.provider_usage_events ev
     WHERE ev.organization_id = p_organization_id
       AND ev.occurred_at >= p_from AND ev.occurred_at < p_to
       AND (p_scope = 'organization' OR ev.user_id = v_actor)
  ),
  q AS (
    SELECT c.event_id,
           sum(c.quantity) FILTER (WHERE c.dimension = 'input_tokens')  AS input_tokens,
           sum(c.quantity) FILTER (WHERE c.dimension = 'output_tokens') AS output_tokens,
           sum(c.quantity) FILTER (WHERE c.dimension = 'audio_seconds') AS audio_seconds
      FROM public.provider_usage_components c
      JOIN e ON e.id = c.event_id
     GROUP BY c.event_id
  ),
  j AS (
    SELECT e.*,
           CASE WHEN e.usage_basis = 'unavailable' THEN 0 ELSE COALESCE(q.input_tokens, 0) END AS input_tokens,
           CASE WHEN e.usage_basis = 'unavailable' THEN 0 ELSE COALESCE(q.output_tokens, 0) END AS output_tokens,
           COALESCE(q.audio_seconds, 0) AS audio_seconds,
           to_char(date_trunc(p_bucket, e.occurred_at AT TIME ZONE v_tz), 'YYYY-MM-DD') AS bucket_start
      FROM e LEFT JOIN q ON q.event_id = e.id
  )
  SELECT jsonb_build_object(
    'scope', p_scope,
    'bucket', p_bucket,
    'time_zone', v_tz,
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', (
      SELECT jsonb_build_object(
        'requests', count(*),
        'succeeded', count(*) FILTER (WHERE outcome = 'succeeded'),
        'failed', count(*) FILTER (WHERE outcome = 'failed'),
        'cancelled', count(*) FILTER (WHERE outcome = 'cancelled'),
        'input_tokens', COALESCE(sum(input_tokens), 0),
        'output_tokens', COALESCE(sum(output_tokens), 0),
        'audio_seconds', COALESCE(sum(audio_seconds), 0),
        'unmetered_requests', count(*) FILTER (WHERE usage_basis = 'unavailable'),
        'estimated_usage_requests', count(*) FILTER (WHERE usage_basis = 'estimated'))
      FROM j),
    'by_feature', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'feature', feature, 'requests', n, 'failed', f,
               'input_tokens', it, 'output_tokens', ot, 'audio_seconds', au) ORDER BY feature)
        FROM (SELECT feature, count(*) n, count(*) FILTER (WHERE outcome <> 'succeeded') f,
                     sum(input_tokens) it, sum(output_tokens) ot, sum(audio_seconds) au
                FROM j GROUP BY feature) s), '[]'::jsonb),
    'series', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'bucket_start', bucket_start, 'requests', n, 'failed', f,
               'input_tokens', it, 'output_tokens', ot) ORDER BY bucket_start)
        FROM (SELECT bucket_start, count(*) n, count(*) FILTER (WHERE outcome <> 'succeeded') f,
                     sum(input_tokens) it, sum(output_tokens) ot
                FROM j GROUP BY bucket_start) s), '[]'::jsonb),
    'by_user', CASE WHEN p_scope = 'organization' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', s.user_id, 'name', p.full_name, 'email', p.email,
               'is_member', (mm.user_id IS NOT NULL),
               'requests', s.n, 'input_tokens', s.it, 'output_tokens', s.ot)
             ORDER BY s.n DESC, s.user_id)
        FROM (SELECT user_id, count(*) n, sum(input_tokens) it, sum(output_tokens) ot
                FROM j WHERE user_id IS NOT NULL GROUP BY user_id) s
        LEFT JOIN public.profiles p ON p.id = s.user_id
        LEFT JOIN public.organization_members mm
               ON mm.organization_id = p_organization_id AND mm.user_id = s.user_id), '[]'::jsonb)
    ELSE NULL END,
    'unattributed_requests', CASE WHEN p_scope = 'organization'
      THEN (SELECT count(*) FROM j WHERE user_id IS NULL) ELSE NULL END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.org_usage_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) IS
  'Customer usage report: features, requests, tokens; scope=self for any member, scope=organization for '
  'owner/admin. Never returns provider, model, price or cost. Buckets in the organization time zone.';

REVOKE ALL ON FUNCTION public.org_usage_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_usage_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO authenticated, service_role;

-- 4. Close the provider/model/cost leak to customers -------------------------------------------------
-- public.org_usage_summary returned provider, model and cost per group to any member. It stays for
-- service_role (internal cost reporting); customers use org_usage_report.
REVOKE EXECUTE ON FUNCTION public.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
