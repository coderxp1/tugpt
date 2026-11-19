-- workspace_conversation_cursor.test.sql — 20261120100007: keyset pagination
-- of search_chat_threads on (updated_at DESC, id DESC) with an id
-- tie-breaker. Identical and microsecond-adjacent timestamps, page boundaries
-- inside a tie group, exact-multiple and empty final pages, filters combined
-- with the cursor, the legacy timestamp-only mode, bounds and isolation.
BEGIN;
SELECT plan(22);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f5111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_cur_member@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f5222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_cur_other@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f5333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_cur_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f5444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_cur_bulk@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('f5a00000-0000-4000-8000-00000000000a','Cursor A','ws-cur-a'),
 ('f5b00000-0000-4000-8000-00000000000b','Cursor B','ws-cur-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','agent'),
 ('f5a00000-0000-4000-8000-00000000000a','f5222222-2222-4222-8222-222222222222','owner'),
 ('f5a00000-0000-4000-8000-00000000000a','f5444444-4444-4444-8444-444444444444','agent'),
 ('f5b00000-0000-4000-8000-00000000000b','f5333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_folders (id, organization_id, owner_user_id, name) VALUES
 ('f5f00000-0000-4000-8000-0000000000a1','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Cursor folder');

-- Member's threads. Expected order (updated_at DESC, id DESC):
--   04, 03, 02, 01   all at T0 = 10:00:00.123456 (identical)
--   05               10:00:00.123455 (same millisecond, 1 microsecond earlier)
--   06               10:00:00.123000 (what the old ms-rounded cursor became)
--   08, 07           09:00:00 (identical)
-- 09 is archived at T0 (never in the default list). 01, 05 and 06 are filed;
-- 01, 03 and 08 have "report" in the title.
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key, folder_id, archived_at, updated_at) VALUES
 ('f5700000-0000-4000-8000-000000000001','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Report one','tugpt-scout','f5f00000-0000-4000-8000-0000000000a1',NULL,'2026-11-01 10:00:00.123456+00'),
 ('f5700000-0000-4000-8000-000000000002','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Two','tugpt-scout',NULL,NULL,'2026-11-01 10:00:00.123456+00'),
 ('f5700000-0000-4000-8000-000000000003','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Report three','tugpt-scout',NULL,NULL,'2026-11-01 10:00:00.123456+00'),
 ('f5700000-0000-4000-8000-000000000004','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Four','tugpt-scout',NULL,NULL,'2026-11-01 10:00:00.123456+00'),
 ('f5700000-0000-4000-8000-000000000005','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Five','tugpt-scout','f5f00000-0000-4000-8000-0000000000a1',NULL,'2026-11-01 10:00:00.123455+00'),
 ('f5700000-0000-4000-8000-000000000006','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Six','tugpt-scout','f5f00000-0000-4000-8000-0000000000a1',NULL,'2026-11-01 10:00:00.123+00'),
 ('f5700000-0000-4000-8000-000000000007','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Seven','tugpt-scout',NULL,NULL,'2026-11-01 09:00:00+00'),
 ('f5700000-0000-4000-8000-000000000008','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Report eight','tugpt-scout',NULL,NULL,'2026-11-01 09:00:00+00'),
 ('f5700000-0000-4000-8000-000000000009','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Archived','tugpt-scout',NULL,'2026-11-01 11:00:00+00','2026-11-01 10:00:00.123456+00'),
 -- Org owner's own thread with the same timestamp and a larger id; org B's thread likewise.
 ('f5700000-0000-4000-8000-0000000000a0','f5a00000-0000-4000-8000-00000000000a','f5222222-2222-4222-8222-222222222222','Owner report','tugpt-scout',NULL,NULL,'2026-11-01 10:00:00.123456+00'),
 ('f5700000-0000-4000-8000-0000000000b0','f5b00000-0000-4000-8000-00000000000b','f5333333-3333-4333-8333-333333333333','B report','tugpt-scout',NULL,NULL,'2026-11-01 10:00:00.123456+00');
-- 105 threads with one shared timestamp for the limit cap.
INSERT INTO public.chat_threads (organization_id, owner_user_id, title, model_key, updated_at)
SELECT 'f5a00000-0000-4000-8000-00000000000a','f5444444-4444-4444-8444-444444444444','Bulk '||g,'tugpt-scout','2026-11-01 08:00:00+00'
FROM generate_series(1,105) g;

CREATE FUNCTION pg_temp.page(p_limit int, p_before timestamptz, p_before_id uuid, p_q text DEFAULT NULL, p_folder uuid DEFAULT NULL, p_archived boolean DEFAULT false)
RETURNS text[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(right(s.id::text, 2) ORDER BY s.ord), '{}')
  FROM (SELECT f.id, row_number() OVER () AS ord
        FROM public.search_chat_threads('f5a00000-0000-4000-8000-00000000000a', p_q, p_archived, p_folder, false, p_limit, p_before, p_before_id) f) s $$;
GRANT EXECUTE ON FUNCTION pg_temp.page(int, timestamptz, uuid, text, uuid, boolean) TO authenticated;

SELECT ok(to_regprocedure('public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz)') IS NULL,
  'the 7-argument function is replaced, not overloaded'); -- 1
SELECT ok(has_function_privilege('authenticated','public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz,uuid)','EXECUTE')
  AND NOT has_function_privilege('public','public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz,uuid)','EXECUTE'),
  'authenticated may execute; anon and PUBLIC may not'); -- 2
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz,uuid)')),
  false, 'still SECURITY INVOKER (RLS applies)'); -- 3

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5111111-1111-4111-8111-111111111111","role":"authenticated"}',true);

SELECT is(pg_temp.page(50, NULL, NULL), ARRAY['04','03','02','01','05','06','08','07'], 'full list: deterministic (updated_at DESC, id DESC), own active threads only'); -- 4
-- limit 3: the first boundary falls inside the identical-timestamp group.
SELECT is(pg_temp.page(3, NULL, NULL), ARRAY['04','03','02'], 'page 1 of 3'); -- 5
SELECT is(pg_temp.page(3, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-000000000002'), ARRAY['01','05','06'],
  'page 2 continues inside the tie group and keeps the microsecond-adjacent rows'); -- 6
SELECT is(pg_temp.page(3, '2026-11-01 10:00:00.123+00', 'f5700000-0000-4000-8000-000000000006'), ARRAY['08','07'], 'page 3 (short final page)'); -- 7
SELECT is(pg_temp.page(3, '2026-11-01 09:00:00+00', 'f5700000-0000-4000-8000-000000000007'), '{}'::text[], 'past the last row: empty'); -- 8
-- limit 4: 8 rows are an exact multiple.
SELECT is(pg_temp.page(4, NULL, NULL), ARRAY['04','03','02','01'], 'exact multiple: page 1 is the whole tie group'); -- 9
SELECT is(pg_temp.page(4, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-000000000001'), ARRAY['05','06','08','07'], 'exact multiple: page 2'); -- 10
SELECT is(pg_temp.page(4, '2026-11-01 09:00:00+00', 'f5700000-0000-4000-8000-000000000007'), '{}'::text[], 'exact multiple: the page after is empty'); -- 11
-- limit 1 walks every row exactly once (also crosses the 1-microsecond gap).
SELECT is(pg_temp.page(1, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-000000000001'), ARRAY['05'], 'single-row step across the microsecond gap'); -- 12
SELECT is(pg_temp.page(1, '2026-11-01 10:00:00.123455+00', 'f5700000-0000-4000-8000-000000000005'), ARRAY['06'], 'single-row step to the millisecond row'); -- 13
-- Filters combined with the cursor.
SELECT is(pg_temp.page(2, NULL, NULL, 'report'), ARRAY['03','01'], 'search page 1'); -- 14
SELECT is(pg_temp.page(2, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-000000000001', 'report'), ARRAY['08'], 'search page 2'); -- 15
SELECT is(pg_temp.page(2, '2026-11-01 10:00:00.123455+00', 'f5700000-0000-4000-8000-000000000005', NULL, 'f5f00000-0000-4000-8000-0000000000a1'), ARRAY['06'],
  'folder filter with cursor'); -- 16
SELECT is(pg_temp.page(2, '2026-11-01 11:00:00+00', 'f5700000-0000-4000-8000-0000000000ff', NULL, NULL, true), ARRAY['09'], 'archived list paginates the same way'); -- 17
-- Legacy timestamp-only cursor keeps its old meaning (strictly before; ties skipped).
SELECT is(pg_temp.page(50, '2026-11-01 10:00:00.123456+00', NULL), ARRAY['05','06','08','07'], 'legacy timestamp-only cursor unchanged'); -- 18
SELECT throws_ok($$SELECT * FROM public.search_chat_threads('f5a00000-0000-4000-8000-00000000000a', NULL, false, NULL, false, 10, NULL, 'f5700000-0000-4000-8000-000000000001')$$,
  '22023', 'INVALID_CURSOR', 'an id without a timestamp is rejected'); -- 19

-- Isolation: a cursor is not a capability. The org owner using the member's
-- cursor sees only the owner's own threads (none sort after it here), and org
-- B's owner sees nothing in org A.
SELECT set_config('request.jwt.claims','{"sub":"f5222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is(pg_temp.page(50, NULL, NULL) || pg_temp.page(50, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-000000000002'),
  ARRAY['a0'], 'another member sees only their own threads, with or without the cursor'); -- 20
SELECT set_config('request.jwt.claims','{"sub":"f5333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is(pg_temp.page(50, '2026-11-01 10:00:00.123456+00', 'f5700000-0000-4000-8000-0000000000ff'), '{}'::text[], 'another tenant sees nothing in org A'); -- 21
-- The cap is 101 (the API asks for limit + 1 with limit <= 100).
SELECT set_config('request.jwt.claims','{"sub":"f5444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f5a00000-0000-4000-8000-00000000000a', NULL, false, NULL, false, 500)), 101, 'limit is capped at 101'); -- 22
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
