#!/usr/bin/env python3
"""Route-level lock regression for POST /api/v1/connect/mcp/endpoints/{EP}/snapshot (Agent 2 M7).

Runs against a REAL stack on a DISPOSABLE database only: Next (apps/web) -> PostgREST -> Postgres. A real psql
session holds a lock for HOLD seconds while ONE route request arrives. Never point this at shared or production data:
it deletes and re-creates the endpoint row ENDPOINT_ID.

  MODE row       : SELECT ... FROM external_tool_endpoints WHERE id=EP FOR UPDATE  -> expect 409 SNAPSHOT_VERSION_CONFLICT ~2 s
  MODE tools-ddl : LOCK TABLE external_tools IN ACCESS EXCLUSIVE MODE               -> expect 503 SNAPSHOT_STORE_BUSY ~2 s
  MODE snap-read : LOCK TABLE external_tool_snapshots IN ACCESS EXCLUSIVE MODE      -> 201 if released in time, else 503 DATABASE_TIMEOUT
Never 500. Seeds v1 through the route, then checks that the locked request consumed no snapshot version or tool rows
(right after, and 4 s after the holder ends, to catch a late commit) and that a follow-up request gets the next version.

Environment (all required; nothing secret is printed):
  SNAP_BASE_URL      Next base URL, e.g. http://127.0.0.1:32790
  SNAP_ORIGIN        allowed app origin (TUGPT_APP_ORIGIN), e.g. https://app.test
  SNAP_ORG_ID        organization id the session is owner/admin of
  SNAP_ENDPOINT_ID   endpoint id to (re)create; its URL must be reachable through the egress proxy
  SNAP_ENDPOINT_URL  https URL stored for the endpoint
  SNAP_COOKIE_FILE   file holding the __Host-tugpt_session cookie value
  SNAP_PG_CONTAINER  docker container running the disposable Postgres
  SNAP_PG_PW_FILE    file holding that Postgres superuser password
Usage: snapshot-route-lock.py MODE HOLD_SECONDS LABEL   (prints one JSON line)
"""

import json, os, subprocess, sys, threading, time, urllib.request, urllib.error
MODE, HOLD, LABEL = sys.argv[1], float(sys.argv[2]), sys.argv[3]
def env(k):
    v=os.environ.get(k)
    if not v: sys.exit(f'missing environment variable {k}')
    return v
PW=open(env('SNAP_PG_PW_FILE')).read().strip(); B=env('SNAP_BASE_URL').rstrip('/'); O=env('SNAP_ORIGIN')
ORG=env('SNAP_ORG_ID'); EP=env('SNAP_ENDPOINT_ID'); EP_URL=env('SNAP_ENDPOINT_URL'); PGC=env('SNAP_PG_CONTAINER')
COOKIE='__Host-tugpt_session='+open(env('SNAP_COOKIE_FILE')).read().strip()
H={'origin':O,'x-tugpt-csrf':'1','content-type':'application/json','sec-fetch-site':'same-origin','cookie':COOKIE,'x-tenant-id':ORG}
PSQL=['docker','exec','-i','-e','PGPASSWORD',PGC,'psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-U','postgres','-d','postgres']
ENV={**os.environ,'PGPASSWORD':PW}
def sql(q):
    r=subprocess.run(PSQL+['-c',q],capture_output=True,text=True,env=ENV)
    if r.returncode: raise RuntimeError('psql failed: '+r.stderr.strip()[:200])
    return r.stdout.strip()
def post():
    rq=urllib.request.Request(B+f'/api/v1/connect/mcp/endpoints/{EP}/snapshot',data=b'{}',method='POST',headers=H); t=time.monotonic()
    try:
        with urllib.request.urlopen(rq,timeout=60) as x: b=json.loads(x.read().decode()); return {'status':x.status,'code':'','version':b.get('version'),'latency_s':round(time.monotonic()-t,2)}
    except urllib.error.HTTPError as e:
        try: c=json.loads(e.read().decode()).get('error',{}).get('code')
        except Exception: c='?'
        return {'status':e.code,'code':c,'version':None,'latency_s':round(time.monotonic()-t,2)}
def rows():
    v=sql(f"SELECT COALESCE(string_agg(version::text,',' ORDER BY version),'') FROM public.external_tool_snapshots WHERE endpoint_id='{EP}'")
    t=sql(f"SELECT count(*) FROM public.external_tools t JOIN public.external_tool_snapshots s ON s.id=t.snapshot_id WHERE s.endpoint_id='{EP}'")
    return {'versions':v,'tool_rows':int(t)}
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'; INSERT INTO public.external_tool_endpoints (id,organization_id,kind,url,display_name,status) VALUES ('{EP}','{ORG}','mcp','{EP_URL}','route lock regression','pending');")
seed=post(); before=rows()
lock={'row':f"SELECT 1 FROM public.external_tool_endpoints WHERE id='{EP}' FOR UPDATE;",
      'tools-ddl':"LOCK TABLE public.external_tools IN ACCESS EXCLUSIVE MODE;",
      'snap-read':"LOCK TABLE public.external_tool_snapshots IN ACCESS EXCLUSIVE MODE;"}[MODE]
holder=subprocess.Popen(PSQL,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,env=ENV)
holder.stdin.write(f"BEGIN; {lock} SELECT pg_sleep({HOLD}); COMMIT;\n"); holder.stdin.close()
time.sleep(1.0); held=int(sql(f"SELECT count(*) FROM pg_stat_activity WHERE query ILIKE '%pg_sleep({HOLD})%' AND state='active' AND pid<>pg_backend_pid()"))
t0=time.monotonic(); res=post(); res['holder_elapsed_at_response_s']=round(time.monotonic()-t0+1.0,2)
after=rows(); holder.wait(timeout=HOLD+30); time.sleep(4.0); late=rows()
waiting=int(sql("SELECT count(*) FROM pg_stat_activity WHERE state<>'idle' AND query ILIKE '%create_mcp_snapshot%' AND pid<>pg_backend_pid()"))
follow=post(); final=rows()
print(json.dumps({'label':LABEL,'mode':MODE,'hold_s':HOLD,'holder_lock_held':held,
  'proconfig':sql("SELECT array_to_string(proconfig,' ') FROM pg_proc WHERE oid='public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure"),
  'seed':seed,'rows_before':before,'locked_request':res,'is_500':res['status']==500,'rows_right_after':after,'rows_4s_after_holder_end':late,
  'no_rows_consumed':before==after==late,'snapshot_backends_left':waiting,'follow_up':follow,'rows_final':final,
  'follow_up_got_next_version':follow.get('version')==len(before['versions'].split(','))+1}))
sql(f"DELETE FROM public.external_tool_endpoints WHERE id='{EP}'")
