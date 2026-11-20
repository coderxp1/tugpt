#!/usr/bin/env python3
"""Route-level idempotency / timeout regression for the MCP snapshot routes (M9).

Runs against a REAL stack on a DISPOSABLE database only: Next (apps/web) -> PostgREST -> Postgres. Never point this at
shared or production data: it deletes and re-creates the endpoint row SNAP_ENDPOINT_ID (cascading to its snapshots and
idempotency records) and may create and drop a temporary trigger scoped to that endpoint.

Usage: snapshot-idempotency.py CASE [ARGS...]      (prints one JSON line; exit 1 if the case fails)
  slow-timeout SECS     a write that takes SECS (6 or 9) > the 5 s app timeout: 503, replays while it runs get
                        409 IN_PROGRESS, it rolls back (deadline 3 s / statement_timeout), a later replay creates
                        exactly one snapshot and the replay after that returns it (200, same id)
  lost-response         the client gives up after 0.5 s on a 1.5 s write that commits: the replay returns the
                        ORIGINAL snapshot (200, same id and version), no duplicate
  in-progress           replay while a 2 s write is running -> 409 IN_PROGRESS; the original -> 201
  same-key N            N concurrent POSTs with one key (1 s write) -> exactly one snapshot; others 200 replay / 409
  diff-keys N ROUNDS    N concurrent POSTs with different keys, ROUNDS times -> all 201, contiguous versions
  lock MODE SECS        MODE row (endpoint row FOR UPDATE) | tools-ddl (external_tools ACCESS EXCLUSIVE) held SECS
                        after the request is sent: < 2 s -> 201; >= 2 s -> 503 ENDPOINT_BUSY / SNAPSHOT_STORE_BUSY,
                        nothing written; a replay with the same key afterwards creates exactly one
  slow-write SECS       a write that takes SECS: <= 2.5 s -> 201; > 3 s -> 503 SNAPSHOT_DEADLINE_EXCEEDED before the
                        5 s app timeout, rolled back; a replay afterwards creates exactly one
  replay-under-ddl      replay of a committed key while external_tools is DDL-locked -> 503 SNAPSHOT_STORE_BUSY
                        (never 500); after the lock, 200 with the original
  read-timeout SECS     GET /snapshots/{id}/tools while external_tool_snapshots is ACCESS EXCLUSIVE locked SECS:
                        expected 503 DATABASE_TIMEOUT within ~5 s and exactly ONE database attempt (no client retries)
After every case: no idle-in-transaction sessions, no ungranted locks, no running snapshot call, contiguous versions,
no partial snapshots, one idempotency record per snapshot, no 500, no 40001 in the Postgres log since the case started.

Environment (all required; nothing secret is printed):
  SNAP_BASE_URL, SNAP_ORIGIN, SNAP_ORG_ID, SNAP_ENDPOINT_ID, SNAP_ENDPOINT_URL,
  SNAP_COOKIE_FILE (holds the __Host-tugpt_session value), SNAP_PG_CONTAINER, SNAP_PG_PW_FILE
"""
import datetime, json, os, socket, subprocess, sys, threading, time, urllib.error, urllib.request, uuid

def env(k):
    v = os.environ.get(k)
    if not v: sys.exit(f'missing environment variable {k}')
    return v

CASE, ARGS = sys.argv[1], sys.argv[2:]
PW = open(env('SNAP_PG_PW_FILE')).read().strip(); B = env('SNAP_BASE_URL').rstrip('/'); O = env('SNAP_ORIGIN')
ORG = env('SNAP_ORG_ID'); EP = env('SNAP_ENDPOINT_ID'); EP_URL = env('SNAP_ENDPOINT_URL'); PGC = env('SNAP_PG_CONTAINER')
COOKIE = '__Host-tugpt_session=' + open(env('SNAP_COOKIE_FILE')).read().strip()
H = {'origin': O, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cookie': COOKIE, 'x-tenant-id': ORG}
PSQL = ['docker', 'exec', '-i', '-e', 'PGPASSWORD', PGC, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres']
ENV = {**os.environ, 'PGPASSWORD': PW}
TRIG = 'regression_snapshot_slow_write'
T0 = time.monotonic()
STARTED = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
ALL = []  # every HTTP response in this case (for the no-500 check)

def sql(q):
    r = subprocess.run(PSQL + ['-c', q], capture_output=True, text=True, env=ENV)
    if r.returncode: raise RuntimeError('psql failed: ' + r.stderr.strip()[:200])
    return r.stdout.strip()

def new_key(): return 'reg-' + uuid.uuid4().hex

def call(method, path, key=None, timeout=60):
    h = dict(H)
    if key is not None and method == 'POST': h['idempotency-key'] = key
    rq = urllib.request.Request(B + path, data=b'{}' if method == 'POST' else None, method=method, headers=h)
    t = time.monotonic(); at = round(t - T0, 2)
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as x:
            b = json.loads(x.read().decode())
            r = {'status': x.status, 'code': '', 'snapshot_id': b.get('snapshotId'), 'version': b.get('version'),
                 'replayed': b.get('replayed'), 'state': b.get('state'), 'replayed_header': x.headers.get('idempotent-replayed')}
    except urllib.error.HTTPError as e:
        try: c = json.loads(e.read().decode()).get('error', {}).get('code')
        except Exception: c = '?'
        r = {'status': e.code, 'code': c, 'retry_after': e.headers.get('retry-after')}
    except (socket.timeout, TimeoutError, urllib.error.URLError) as e:
        if isinstance(e, urllib.error.URLError) and not isinstance(getattr(e, 'reason', None), (socket.timeout, TimeoutError)): raise
        r = {'status': 'client-timeout', 'code': ''}
    r['sent_at_s'] = at; r['latency_s'] = round(time.monotonic() - t, 2)
    ALL.append(r); return r

def post(key, timeout=60): return call('POST', f'/api/v1/connect/mcp/endpoints/{EP}/snapshot', key, timeout)

def versions(): return [int(x) for x in sql(f"SELECT COALESCE(string_agg(version::text,',' ORDER BY version),'') FROM public.external_tool_snapshots WHERE endpoint_id='{EP}'").split(',') if x]

def key_snapshots(key):
    """Snapshots recorded for this key (GREEN) -- the idempotency record is written in the same transaction."""
    return int(sql(f"SELECT count(*) FROM public.external_tool_snapshot_requests WHERE endpoint_id='{EP}' AND idempotency_key='{key}'"))

def key_snapshot_id(key):
    return sql(f"SELECT COALESCE(snapshot_id::text,'') FROM public.external_tool_snapshot_requests WHERE endpoint_id='{EP}' AND idempotency_key='{key}'")

def running():
    return int(sql("SELECT count(*) FROM pg_stat_activity WHERE state<>'idle' AND query ILIKE '%create_mcp_snapshot%' AND query NOT ILIKE '%pg_stat_activity%' AND pid<>pg_backend_pid()"))

def wait_idle(limit=20.0):
    t = time.monotonic()
    while running() and time.monotonic() - t < limit: time.sleep(0.2)
    return round(time.monotonic() - t, 2)

def drop_trigger():
    sql(f"DROP TRIGGER IF EXISTS {TRIG} ON public.external_tool_snapshots; DROP FUNCTION IF EXISTS public.{TRIG}();")

def slow_trigger(secs):
    sql(f"CREATE FUNCTION public.{TRIG}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_sleep({secs}); RETURN NEW; END $f$; "
        f"REVOKE ALL ON FUNCTION public.{TRIG}() FROM PUBLIC; "
        f"CREATE TRIGGER {TRIG} BEFORE INSERT ON public.external_tool_snapshots FOR EACH ROW WHEN (NEW.endpoint_id = '{EP}') EXECUTE FUNCTION public.{TRIG}();")

class Holder:
    """A separate session holding a lock until release()."""
    def __init__(self, lock_sql):
        self.p = subprocess.Popen(PSQL + ['-c', "SET application_name='regression_lock_holder'", '-f', '-'], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=ENV)
        self.p.stdin.write(f"BEGIN; {lock_sql}\nSELECT pg_sleep(0);\n"); self.p.stdin.flush()
        self.held = 0
        for _ in range(100):
            self.held = int(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='regression_lock_holder' AND state LIKE 'idle in transaction%'"))
            if self.held: break
            time.sleep(0.05)
    def release(self):
        if self.p.poll() is None:
            self.p.stdin.write("COMMIT;\n"); self.p.stdin.close(); self.p.wait(timeout=30)
    def kill(self):
        if self.p.poll() is None: self.p.kill()

def bg(fn, *a):
    out = {}; th = threading.Thread(target=lambda: out.update(fn(*a))); th.start(); return th, out

LOCKS = {'row': f"SELECT 1 FROM public.external_tool_endpoints WHERE id='{EP}' FOR UPDATE;",
         'tools-ddl': "LOCK TABLE public.external_tools IN ACCESS EXCLUSIVE MODE;",
         'snap-read': "LOCK TABLE public.external_tool_snapshots IN ACCESS EXCLUSIVE MODE;"}

# ---- setup: fresh endpoint + one seed snapshot through the route ----
drop_trigger()
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'; INSERT INTO public.external_tool_endpoints (id,organization_id,kind,url,display_name,status) VALUES ('{EP}','{ORG}','mcp','{EP_URL}','idempotency regression','pending');")
seed = post(new_key())
TOOLS_PER = int(sql(f"SELECT count(*) FROM public.external_tools t JOIN public.external_tool_snapshots s ON s.id=t.snapshot_id WHERE s.endpoint_id='{EP}'")) or 1
N0 = len(versions())
detail = {}; checks = {}; holder = None
try:
    if CASE == 'slow-timeout':
        secs = float(ARGS[0]); k = new_key(); slow_trigger(secs)
        th, first = bg(post, k)
        time.sleep(3.0); during = post(k)               # replay while the original is running
        th.join(); after_503 = post(k)                    # replay right after the 503, original still running
        waited = wait_idle(); rows_after_original = versions()
        drop_trigger()
        replay = post(k); again = post(k)
        detail = {'first': first, 'replay_during': during, 'replay_after_503': after_503, 'waited_for_original_s': waited,
                  'versions_after_original_finished': rows_after_original, 'replay': replay, 'replay_again': again,
                  'snapshots_for_key': key_snapshots(k)}
        checks = {'first_is_503_database_timeout': (first['status'], first['code']) == (503, 'DATABASE_TIMEOUT'),
                  'first_within_app_timeout': first['latency_s'] < 6.5,
                  'replay_while_running_is_409_in_progress': (during['status'], during['code']) == (409, 'IN_PROGRESS'),
                  'replay_after_503_is_409_in_progress': (after_503['status'], after_503['code']) == (409, 'IN_PROGRESS'),
                  'original_rolled_back': len(rows_after_original) == N0,
                  'replay_creates_exactly_one': replay['status'] == 201 and key_snapshots(k) == 1 and len(versions()) == N0 + 1,
                  'second_replay_returns_it': again['status'] == 200 and again.get('replayed') is True and again.get('snapshot_id') == replay.get('snapshot_id') and again.get('version') == replay.get('version')}
    elif CASE == 'lost-response':
        k = new_key(); slow_trigger(1.5)
        first = post(k, timeout=0.5)
        waited = wait_idle(); time.sleep(0.5)
        committed_id = key_snapshot_id(k); committed_v = sql(f"SELECT COALESCE(version::text,'') FROM public.external_tool_snapshot_requests WHERE endpoint_id='{EP}' AND idempotency_key='{k}'")
        drop_trigger()
        status = call('GET', f'/api/v1/connect/mcp/endpoints/{EP}/snapshot?idempotencyKey={k}')
        replay = post(k)
        detail = {'first': first, 'waited_s': waited, 'committed_snapshot_id': committed_id, 'committed_version': committed_v,
                  'status_lookup': status, 'replay': replay, 'snapshots_for_key': key_snapshots(k)}
        checks = {'client_gave_up': first['status'] == 'client-timeout',
                  'database_committed_the_original': committed_id != '' and len(versions()) == N0 + 1,
                  'status_lookup_reports_committed': status['status'] == 200 and status.get('state') == 'committed' and status.get('snapshot_id') == committed_id,
                  'replay_returns_original': replay['status'] == 200 and replay.get('replayed') is True and replay.get('snapshot_id') == committed_id and str(replay.get('version')) == committed_v and replay.get('replayed_header') == 'true',
                  'no_duplicate': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'in-progress':
        k = new_key(); slow_trigger(2.0)
        th, first = bg(post, k); time.sleep(0.8); during = post(k); th.join()
        drop_trigger(); again = post(k)
        detail = {'first': first, 'replay_during': during, 'replay_after': again}
        checks = {'replay_during_is_409_in_progress': (during['status'], during['code']) == (409, 'IN_PROGRESS') and during.get('retry_after') == '2',
                  'original_201': first['status'] == 201 and first.get('version') == N0 + 1,
                  'replay_after_returns_original': again['status'] == 200 and again.get('snapshot_id') == first.get('snapshot_id'),
                  'exactly_one': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'same-key':
        n = int(ARGS[0]); k = new_key(); slow_trigger(1.0)
        bar = threading.Barrier(n); outs = [None] * n
        def worker(i): bar.wait(); outs[i] = post(k)
        ts = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        [t.start() for t in ts]; [t.join() for t in ts]
        wait_idle(); drop_trigger(); final = post(k)
        created = [o for o in outs if o['status'] == 201]
        ids = {o.get('snapshot_id') for o in outs if o['status'] in (200, 201)}
        detail = {'n': n, 'responses': sorted([(o['status'], o['code'], o.get('version'), o['latency_s']) for o in outs], key=str), 'final_replay': final}
        checks = {'exactly_one_201': len(created) == 1,
                  'others_replay_or_in_progress': all((o['status'] == 200 and o.get('replayed') is True) or (o['status'], o['code']) == (409, 'IN_PROGRESS') for o in outs if o['status'] != 201),
                  'all_successes_same_snapshot': len(ids) == 1,
                  'final_replay_returns_it': final['status'] == 200 and final.get('snapshot_id') in ids,
                  'exactly_one_snapshot': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'diff-keys':
        n, rounds = int(ARGS[0]), int(ARGS[1]); per_round = []
        for _ in range(rounds):
            bar = threading.Barrier(n); outs = [None] * n; keys = [new_key() for _ in range(n)]
            def worker(i): bar.wait(); outs[i] = post(keys[i])
            ts = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            [t.start() for t in ts]; [t.join() for t in ts]
            per_round.append({'statuses': sorted(o['status'] for o in outs), 'codes': sorted({o['code'] for o in outs}),
                              'versions': sorted(o.get('version') or 0 for o in outs), 'max_latency_s': max(o['latency_s'] for o in outs),
                              'one_record_per_key': all(key_snapshots(x) == 1 for x in keys)})
        detail = {'n': n, 'rounds': per_round}
        checks = {'all_201': all(set(r['statuses']) == {201} for r in per_round),
                  'distinct_contiguous_versions_per_round': all(r['versions'] == list(range(r['versions'][0], r['versions'][0] + n)) for r in per_round),
                  'one_snapshot_per_key': all(r['one_record_per_key'] for r in per_round),
                  'total_is_seed_plus_n_rounds': len(versions()) == N0 + n * rounds}
    elif CASE == 'lock':
        mode, secs = ARGS[0], float(ARGS[1]); k = new_key()
        holder = Holder(LOCKS[mode]); held = holder.held
        th, first = bg(post, k); time.sleep(secs); holder.release(); released = round(time.monotonic() - T0, 2); th.join()
        rows_after = versions(); time.sleep(1.0); rows_late = versions()
        replay = post(k)
        reject = secs >= 2.0
        exp = ((503, 'ENDPOINT_BUSY') if mode == 'row' else (503, 'SNAPSHOT_STORE_BUSY')) if reject else (201, '')
        detail = {'mode': mode, 'seconds': secs, 'holder_lock_held': held, 'lock_released_at_s': released, 'expected': list(exp),
                  'first': first, 'versions_after': rows_after, 'replay': replay}
        checks = {'status_as_expected': (first['status'], first['code']) == exp,
                  'rejected_within_lock_timeout': first['latency_s'] < 3.0 if reject else True,
                  'nothing_written_on_rejection': (rows_after == rows_late and len(rows_after) == N0) if reject else True,
                  'replay_status': replay['status'] == (201 if reject else 200),
                  'exactly_one': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'slow-write':
        secs = float(ARGS[0]); k = new_key(); slow_trigger(secs)
        first = post(k); wait_idle(); rows_after = versions(); drop_trigger(); replay = post(k)
        late = secs > 3.0
        exp = (503, 'SNAPSHOT_DEADLINE_EXCEEDED') if late else (201, '')
        detail = {'seconds': secs, 'expected': list(exp), 'first': first, 'versions_after': rows_after, 'replay': replay}
        checks = {'status_as_expected': (first['status'], first['code']) == exp,
                  'answered_before_app_timeout': first['latency_s'] < 5.0,
                  'rolled_back_when_late': len(rows_after) == N0 if late else len(rows_after) == N0 + 1,
                  'replay_status': replay['status'] == (201 if late else 200),
                  'exactly_one': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'replay-under-ddl':
        k = new_key(); first = post(k)
        holder = Holder(LOCKS['tools-ddl'])
        during = post(k); holder.release(); after = post(k)
        detail = {'first': first, 'replay_during_ddl': during, 'replay_after': after}
        checks = {'first_201': first['status'] == 201,
                  'replay_during_ddl_is_503_store_busy': (during['status'], during['code']) == (503, 'SNAPSHOT_STORE_BUSY') and during['latency_s'] < 3.0,
                  'replay_after_returns_original': after['status'] == 200 and after.get('snapshot_id') == first.get('snapshot_id'),
                  'exactly_one': key_snapshots(k) == 1 and len(versions()) == N0 + 1}
    elif CASE == 'read-timeout':
        secs = float(ARGS[0]); sid = sql(f"SELECT id FROM public.external_tool_snapshots WHERE endpoint_id='{EP}' ORDER BY version DESC LIMIT 1")
        holder = Holder(LOCKS['snap-read'])
        attempts = set(); stop = threading.Event()
        def sample():
            while not stop.is_set():
                for line in sql("SELECT a.pid||'@'||a.query_start FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND l.relation='public.external_tool_snapshots'::regclass").splitlines():
                    if line: attempts.add(line)
                time.sleep(0.1)
        st = threading.Thread(target=sample); st.start()
        th, res = bg(call, 'GET', f'/api/v1/connect/mcp/snapshots/{sid}/tools')
        time.sleep(secs); holder.release()          # the lock is held SECS after the GET was sent
        th.join(timeout=60); stop.set(); st.join()
        detail = {'seconds_locked_at_least': secs, 'snapshot_id': sid, 'response': res, 'database_attempts': len(attempts)}
        checks = {'is_503_database_timeout': (res.get('status'), res.get('code')) == (503, 'DATABASE_TIMEOUT'),
                  'answered_within_app_timeout': (res.get('latency_s') or 99) < 6.0,
                  'exactly_one_database_attempt': len(attempts) == 1}
    else:
        sys.exit(f'unknown case {CASE}')
finally:
    drop_trigger()
    if holder: holder.kill()

wait_idle()
vs = versions()
partial = int(sql(f"SELECT count(*) FROM public.external_tool_snapshots s WHERE s.endpoint_id='{EP}' AND (SELECT count(*) FROM public.external_tools t WHERE t.snapshot_id=s.id) <> {TOOLS_PER}"))
records = int(sql(f"SELECT count(*) FROM public.external_tool_snapshot_requests WHERE endpoint_id='{EP}'"))
pglog = subprocess.run(['docker', 'logs', '--since', STARTED, PGC], capture_output=True, text=True)
serialization = sum(1 for l in (pglog.stdout + pglog.stderr).splitlines() if '40001' in l or 'could not serialize' in l)
state = {'idle_in_transaction': int(sql("SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()")),
         'ungranted_locks': int(sql("SELECT count(*) FROM pg_locks WHERE NOT granted")),
         'running_snapshot_calls': running(), 'versions': vs, 'partial_snapshots': partial,
         'idempotency_records': records, 'snapshots': len(vs), 'pg_log_40001_lines': serialization}
checks.update({'no_500': all(r['status'] != 500 for r in ALL), 'no_idle_in_transaction': state['idle_in_transaction'] == 0,
               'no_ungranted_locks': state['ungranted_locks'] == 0, 'no_running_snapshot_call': state['running_snapshot_calls'] == 0,
               'versions_contiguous': vs == list(range(1, len(vs) + 1)), 'no_partial_snapshots': partial == 0,
               'one_record_per_snapshot': records == len(vs), 'no_40001_in_pg_log': serialization == 0})
print(json.dumps({'case': CASE, 'args': ARGS, 'seed': seed, **detail, 'db_state': state, 'checks': checks, 'pass': all(checks.values())}))
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'")
sys.exit(0 if all(checks.values()) else 1)
