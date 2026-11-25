-- S0.4 (usage-metering fix U6): unknown usage must not be stored as zero quantities.
-- record_chat_usage previously passed COALESCE(tokens, 0) to private.record_provider_usage
-- for every event, so 'unavailable' events carried input_tokens/output_tokens components
-- with quantity 0 — indistinguishable from a provider-reported 0 for any reader that sums
-- components without checking usage_basis (the basis-unaware org_usage_summary does).
-- The function now passes an empty quantities object for 'unavailable' events, so no token
-- components exist for them at all; the post-insert cost nulling is unchanged. A one-off
-- data cleanup removes the zero-quantity token components written by the old code.
-- Body otherwise verbatim from 20261121700002_usage_accounting.sql.

DELETE FROM public.provider_usage_components c
 USING public.provider_usage_events e
 WHERE c.event_id = e.id
   AND e.usage_basis = 'unavailable'
   AND c.dimension IN ('input_tokens', 'output_tokens')
   AND c.quantity = 0;

CREATE OR REPLACE FUNCTION public.record_chat_usage(
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
    CASE WHEN p_usage_basis = 'unavailable' THEN '{}'::pg_catalog.jsonb
         ELSE pg_catalog.jsonb_build_object('input_tokens', COALESCE(p_input_tokens, 0),
                                  'output_tokens', COALESCE(p_output_tokens, 0)) END,
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
