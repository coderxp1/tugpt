-- Microsoft 365 Connect: reconcile scope to the modern short form used by the
-- v2 flow (Calendars.ReadBasic). The workspace_chat migration seeded the legacy
-- full URI (https://graph.microsoft.com/Calendars.ReadBasic), which would make
-- list_chat_capabilities()' `a.scopes @> pc.required_scopes` never match the
-- short-form scope the v2 flow stores.
INSERT INTO public.integration_providers (key, display_name, auth_kind, supports_user_connections, supports_org_connections)
VALUES ('microsoft', 'Microsoft 365', 'oauth2', true, true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.integration_provider_capabilities (provider_key, capability_key, required_scopes)
VALUES ('microsoft', 'calendar.find_availability', ARRAY['Calendars.ReadBasic'])
ON CONFLICT (provider_key, capability_key) DO UPDATE SET required_scopes = EXCLUDED.required_scopes;