-- READ ONLY. Run on the intended hosted production project and export the JSON result.
-- No row contents, sequence nextval/setval, maintenance commands, or DDL/DML.
-- External Data API configuration requires a separate dashboard/settings export.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog;
SELECT jsonb_build_object(
 'scope','supplemental authorization inventory; metadata only',
 'database',current_database(),
 'server_version',current_setting('server_version'),
 'transaction_read_only',current_setting('transaction_read_only'),
 'sequences',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'name',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,
   'dependencies',(SELECT jsonb_agg(jsonb_build_object('object',d.refobjid::regclass::text,'column_number',d.refobjsubid,'type',d.deptype)) FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass),
   'privileges',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'schema_usage',has_schema_privilege(r.oid,n.oid,'USAGE'),'select',has_sequence_privilege(r.oid,c.oid,'SELECT'),'update',has_sequence_privilege(r.oid,c.oid,'UPDATE'),'usage',has_sequence_privilege(r.oid,c.oid,'USAGE'))) FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role'))
 ) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),'[]'::jsonb),
 'extension_functions',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'extension',e.extname,'version',e.extversion,'schema',n.nspname,'signature',p.oid::regprocedure::text,
  'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'security_definer',p.prosecdef,'config',p.proconfig,
  'acl',p.proacl,'return_type',format_type(p.prorettype,NULL),'definition_md5',md5(pg_get_functiondef(p.oid)),
  'privileges',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'schema_usage',has_schema_privilege(r.oid,n.oid,'USAGE'),'execute',has_function_privilege(r.oid,p.oid,'EXECUTE'))) FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role'))
 ) ORDER BY e.extname,n.nspname,p.oid::regprocedure::text) FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_proc p ON p.oid=d.objid JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE d.classid='pg_proc'::regclass AND d.refclassid='pg_extension'::regclass AND d.deptype='e' AND p.prokind IN ('f','p')),'[]'::jsonb),
 'event_triggers',coalesce((SELECT jsonb_agg(jsonb_build_object('name',t.evtname,'event',t.evtevent,'enabled',t.evtenabled,'tags',t.evttags,'owner',pg_get_userbyid(t.evtowner),'function',t.evtfoid::regprocedure::text,'definition',pg_get_functiondef(t.evtfoid),'security_definer',p.prosecdef,'config',p.proconfig) ORDER BY t.evtname) FROM pg_event_trigger t JOIN pg_proc p ON p.oid=t.evtfoid),'[]'::jsonb),
 'database_role_api_settings',coalesce((SELECT jsonb_agg(jsonb_build_object('database',CASE WHEN s.setdatabase=0 THEN 'ALL' ELSE (SELECT datname FROM pg_database WHERE oid=s.setdatabase) END,'role',CASE WHEN s.setrole=0 THEN 'ALL' ELSE pg_get_userbyid(s.setrole) END,'setting',v.setting)) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) v(setting) WHERE split_part(v.setting,'=',1) IN ('pgrst.db_schemas','pgrst.db_extra_search_path','pgrst.db_pre_request','pgrst.db_root_spec','pgrst.db_anon_role')),'[]'::jsonb),
 'session_api_settings',jsonb_build_object('db_schemas',current_setting('pgrst.db_schemas',true),'db_extra_search_path',current_setting('pgrst.db_extra_search_path',true),'db_pre_request',current_setting('pgrst.db_pre_request',true),'db_anon_role',current_setting('pgrst.db_anon_role',true),'limitation','SQL session values do not establish external PostgREST runtime settings or whether Data API is enabled'),
 'auth_identity_preflight',jsonb_build_object(
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'acl',a.attacl)) FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('id','email','email_confirmed_at','deleted_at')),
  'accept_definer_owner',(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('private.accept_invitation(text)')),
  'definer_can_select_auth_users',(SELECT has_table_privilege(proowner,to_regclass('auth.users'),'SELECT') FROM pg_proc WHERE oid=to_regprocedure('private.accept_invitation(text)')),
  'auth_users_rls',(SELECT jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity) FROM pg_class WHERE oid=to_regclass('auth.users'))),
 'public_table_privileges',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'column_acls',(SELECT jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl)) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),'effective',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'maintain',has_table_privilege(r.oid,c.oid,'MAINTAIN'),'truncate',has_table_privilege(r.oid,c.oid,'TRUNCATE'),'trigger',has_table_privilege(r.oid,c.oid,'TRIGGER'),'references',has_table_privilege(r.oid,c.oid,'REFERENCES'))) FROM pg_roles r WHERE r.rolname IN ('anon','authenticated'))) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')),
 'new_object_name_collisions',jsonb_build_object('lock_table',to_regclass('private.membership_write_locks'),'lock_function',to_regprocedure('private.lock_organization_membership(uuid)'),'assignment_guard',to_regprocedure('private.enforce_conversation_assignment()'),'membership_rpc',to_regprocedure('public.manage_organization_member(uuid,uuid,text,public.organization_role)'),'transfer_rpc',to_regprocedure('public.transfer_organization_ownership(uuid,uuid)')),
 'external_settings_required',jsonb_build_object('project_ref','rbiumegrwtavmljxbknp','items',jsonb_build_array('Data API enabled/disabled','Configured exposed schemas','Extra search path','Pre-request function / API hooks','Runtime overrides, if managed outside database'),'warning','Do not export API keys, JWT secrets, passwords, or user records')
) AS supplemental_authorization_inventory;
ROLLBACK;
