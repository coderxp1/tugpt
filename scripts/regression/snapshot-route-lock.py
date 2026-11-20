#!/usr/bin/env python3
"""Route-level lock / slow-operation regression for POST /api/v1/connect/mcp/endpoints/{EP}/snapshot.

Runs against a REAL stack on a DISPOSABLE database only: Next (apps/web) -> PostgREST -> Postgres. Never point this at
shared or production data: it deletes and re-creates the endpoint row SNAP_ENDPOINT_ID and, in slow-write mode, creates
and drops a temporary trigger scoped to that endpoint.

Usage: snapshot-route-lock.py MODE SECONDS LABEL        (prints one JSON line; exit 1 if the case fails)
  row        SECONDS = how long the endpoint row stays locked (SELECT ... FOR UPDATE) AFTER the request is sent
  tools-ddl  SECONDS = how long external_tools stays ACCESS EXCLUSIVE locked after the request is sent
  snap-read  SECONDS = how long external_tool_snapshots stays ACCESS EXCLUSIVE locked (blocks the plain version read)
  slow-write SECONDS = an ordinary slow operation, no lock: a temporary BEFORE INSERT trigger sleeps SECONDS per snapshot
Expected (create_mcp_snapshot lock_timeout=2s, app PostgREST timeout 5s), never 500:
  row        < 2 s -> 201 next version       >= 2 s -> 409 SNAPSHOT_VERSION_CONFLICT after ~2 s, nothing written
  tools-ddl  < 2 s -> 201 next version       >= 2 s -> 503 SNAPSHOT_STORE_BUSY after ~2 s, nothing written
  snap-read  < 5 s -> 201 next version (the read simply waits)
  slow-write < 5 s -> 201 next version       >  5 s -> 503 DATABASE_TIMEOUT after ~5 s; outcome unknown to the app, so
             the snapshot may still commit late, but only complete (all tool rows), never partial, never a gap
Every case checks afterwards: no idle-in-transaction sessions, no ungranted locks, no running create_mcp_snapshot,
contiguous versions 1..n, every snapshot has its tool rows, and a follow-up request gets the next version.

Environment (all required; nothing secret is printed):
  SNAP_BASE_URL, SNAP_ORIGIN, SNAP_ORG_ID, SNAP_ENDPOINT_ID, SNAP_ENDPOINT_URL,
  SNAP_COOKIE_FILE (holds the __Host-tugpt_session value), SNAP_PG_CONTAINER, SNAP_PG_PW_FILE
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request

def env(k):
    v = os.environ.get(k)
    if not v: sys.exit(f'missing environment variable {k}')
    return v

MODE, SECS, LABEL = sys.argv[1], float(sys.argv[2]), sys.argv[3]
assert MODE in ('row', 'tools-ddl', 'snap-read', 'slow-write'), MODE
PW = open(env('SNAP_PG_PW_FILE')).read().strip(); B = env('SNAP_BASE_URL').rstrip('/'); O = env('SNAP_ORIGIN')
ORG = env('SNAP_ORG_ID'); EP = env('SNAP_ENDPOINT_ID'); EP_URL = env('SNAP_ENDPOINT_URL'); PGC = env('SNAP_PG_CONTAINER')
COOKIE = '__Host-tugpt_session=' + open(env('SNAP_COOKIE_FILE')).read().strip()
H = {'origin': O, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cookie': COOKIE, 'x-tenant-id': ORG}
PSQL = ['docker', 'exec', '-i', '-e', 'PGPASSWORD', PGC, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres']
ENV = {**os.environ, 'PGPASSWORD': PW}
TRIG = 'regression_snapshot_slow_write'

def sql(q):
    r = subprocess.run(PSQL + ['-c', q], capture_output=True, text=True, env=ENV)
    if r.returncode: raise RuntimeError('psql failed: ' + r.stderr.strip()[:200])
    return r.stdout.strip()

def post():
    rq = urllib.request.Request(B + f'/api/v1/connect/mcp/endpoints/{EP}/snapshot', data=b'{}', method='POST', headers=H); t = time.monotonic()
    try:
        with urllib.request.urlopen(rq, timeout=90) as x:
            b = json.loads(x.read().decode()); return {'status': x.status, 'code': '', 'version': b.get('version'), 'retry_after': x.headers.get('retry-after'), 'latency_s': round(time.monotonic() - t, 2)}
    except urllib.error.HTTPError as e:
        try: c = json.loads(e.read().decode()).get('error', {}).get('code')
        except Exception: c = '?'
        return {'status': e.code, 'code': c, 'version': None, 'retry_after': e.headers.get('retry-after'), 'latency_s': round(time.monotonic() - t, 2)}

def rows():
    v = sql(f"SELECT COALESCE(string_agg(version::text,',' ORDER BY version),'') FROM public.external_tool_snapshots WHERE endpoint_id='{EP}'")
    t = sql(f"SELECT count(*) FROM public.external_tools t JOIN public.external_tool_snapshots s ON s.id=t.snapshot_id WHERE s.endpoint_id='{EP}'")
    return {'versions': v, 'tool_rows': int(t)}

def db_state(tools_per_snapshot):
    vs = [int(x) for x in rows()['versions'].split(',') if x]
    partial = int(sql(f"SELECT count(*) FROM public.external_tool_snapshots s WHERE s.endpoint_id='{EP}' AND (SELECT count(*) FROM public.external_tools t WHERE t.snapshot_id=s.id) <> {tools_per_snapshot}"))
    return {'idle_in_transaction': int(sql("SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()")),
            'ungranted_locks': int(sql("SELECT count(*) FROM pg_locks WHERE NOT granted")),
            'running_create_mcp_snapshot': int(sql("SELECT count(*) FROM pg_stat_activity WHERE state<>'idle' AND query ILIKE '%create_mcp_snapshot%' AND pid<>pg_backend_pid()")),
            'versions_contiguous': vs == list(range(1, len(vs) + 1)), 'partial_snapshots': partial}

def drop_trigger():
    sql(f"DROP TRIGGER IF EXISTS {TRIG} ON public.external_tool_snapshots; DROP FUNCTION IF EXISTS public.{TRIG}();")

drop_trigger()
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'; INSERT INTO public.external_tool_endpoints (id,organization_id,kind,url,display_name,status) VALUES ('{EP}','{ORG}','mcp','{EP_URL}','route lock regression','pending');")
seed = post(); before = rows(); n_before = len([x for x in before['versions'].split(',') if x])
tools_per = before['tool_rows'] // max(n_before, 1)
holder = None; res = {}; held = None
try:
    if MODE == 'slow-write':
        sql(f"CREATE FUNCTION public.{TRIG}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_sleep({SECS}); RETURN NEW; END $f$; "
            f"REVOKE ALL ON FUNCTION public.{TRIG}() FROM PUBLIC; "
            f"CREATE TRIGGER {TRIG} BEFORE INSERT ON public.external_tool_snapshots FOR EACH ROW WHEN (NEW.endpoint_id = '{EP}') EXECUTE FUNCTION public.{TRIG}();")
        res = post()
    else:
        lock = {'row': f"SELECT 1 FROM public.external_tool_endpoints WHERE id='{EP}' FOR UPDATE;",
                'tools-ddl': "LOCK TABLE public.external_tools IN ACCESS EXCLUSIVE MODE;",
                'snap-read': "LOCK TABLE public.external_tool_snapshots IN ACCESS EXCLUSIVE MODE;"}[MODE]
        holder = subprocess.Popen(PSQL + ['-c', "SET application_name='regression_lock_holder'", '-f', '-'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=ENV)
        holder.stdin.write(f"BEGIN; {lock}\nSELECT pg_sleep(0);\n"); holder.stdin.flush()
        for _ in range(100):
            held = int(sql("SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()"))
            if held: break
            time.sleep(0.05)
        out = {}
        th = threading.Thread(target=lambda: out.update(post())); t0 = time.monotonic(); th.start()
        time.sleep(SECS); holder.stdin.write("COMMIT;\n"); holder.stdin.close(); released_at = round(time.monotonic() - t0, 2)
        th.join(); res = out; res['lock_released_at_s'] = released_at
        holder.wait(timeout=30)
    after = rows(); time.sleep(4.0); late = rows()
finally:
    drop_trigger()
    if holder and holder.poll() is None: holder.kill()
follow = post(); final = rows(); state = db_state(tools_per)

late_n = len([x for x in late['versions'].split(',') if x])
if MODE in ('row', 'tools-ddl') and SECS >= 2.0:
    exp = (409, 'SNAPSHOT_VERSION_CONFLICT') if MODE == 'row' else (503, 'SNAPSHOT_STORE_BUSY'); must_not_write = True
elif MODE == 'slow-write' and SECS > 5.0:
    exp = (503, 'DATABASE_TIMEOUT'); must_not_write = False
else:
    exp = (201, ''); must_not_write = False
checks = {'status_as_expected': (res.get('status'), res.get('code')) == exp, 'not_500': res.get('status') != 500,
          'nothing_written_on_rejection': (before == after == late) if must_not_write else True,
          'created_version_is_next': res.get('version') == n_before + 1 if exp[0] == 201 else True,
          'follow_up_is_next_version': follow.get('version') == late_n + 1,
          'no_idle_in_transaction': state['idle_in_transaction'] == 0, 'no_ungranted_locks': state['ungranted_locks'] == 0,
          'no_running_snapshot_call': state['running_create_mcp_snapshot'] == 0,
          'versions_contiguous': state['versions_contiguous'], 'no_partial_snapshots': state['partial_snapshots'] == 0}
print(json.dumps({'label': LABEL, 'mode': MODE, 'seconds': SECS, 'holder_lock_held': held, 'expected': list(exp),
                  'proconfig': sql("SELECT array_to_string(proconfig,' ') FROM pg_proc WHERE oid='public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure"),
                  'seed': seed, 'rows_before': before, 'request': res, 'rows_right_after': after, 'rows_4s_later': late,
                  'late_commit': late != before and res.get('status') != 201, 'follow_up': follow, 'rows_final': final, 'db_state': state,
                  'checks': checks, 'pass': all(checks.values())}))
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'")
sys.exit(0 if all(checks.values()) else 1)
