-- OPTIONAL SEPARATE APPROVAL. Future objects only; preserves service defaults.
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE public.security_default_probe(id bigint);
CREATE SEQUENCE public.security_sequence_probe;
CREATE FUNCTION public.security_function_probe() RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
DO $$
BEGIN
 IF has_table_privilege('anon','public.security_default_probe','SELECT') OR has_table_privilege('authenticated','public.security_default_probe','MAINTAIN')
 OR has_sequence_privilege('anon','public.security_sequence_probe','USAGE') OR has_sequence_privilege('authenticated','public.security_sequence_probe','UPDATE')
 OR has_function_privilege('anon','public.security_function_probe()','EXECUTE') OR has_function_privilege('authenticated','public.security_function_probe()','EXECUTE') THEN
 RAISE EXCEPTION 'Browser defaults remain'; END IF;
 IF NOT has_table_privilege('service_role','public.security_default_probe','SELECT') OR NOT has_sequence_privilege('service_role','public.security_sequence_probe','USAGE') OR NOT has_function_privilege('service_role','public.security_function_probe()','EXECUTE') THEN
 RAISE EXCEPTION 'Service defaults lost'; END IF;
END; $$;
ROLLBACK;
