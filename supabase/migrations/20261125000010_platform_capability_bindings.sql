-- B6: platform capability bindings (ADR-022 D4/D6).
--
-- A binding ties one TuGPT-defined capability (e.g. 'video.generate') to one
-- platform endpoint + remote tool, with operator-held execution config
-- (argument template, polling shape). Org-facing surfaces only ever see the
-- TuGPT capability definition — never the endpoint, provider or tool name
-- stored here. Disabled by default: a binding does nothing until an operator
-- enables it, and the org still needs the capability's entitlement flag.

CREATE TABLE public.platform_capability_bindings (
  capability_key TEXT PRIMARY KEY CHECK (capability_key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  endpoint_id UUID NOT NULL REFERENCES public.platform_tool_endpoints(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL CHECK (tool_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_capability_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_capability_bindings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_capability_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_capability_bindings TO service_role;
