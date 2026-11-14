"""Deterministic overlapping sessions in a disposable clone, never a connection URL."""
import subprocess,json,re,time,concurrent.futures
from pathlib import Path
from run_security_tests import C,fixture,session,uid,q,A,CONV,manage,assertion
ROOT=Path(__file__).resolve().parent
DB='security_concurrency'
args=['docker','exec','-i',C,'psql','-X','-U','postgres','-d',DB,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def run(sql):return subprocess.run(args,input=sql,text=True,capture_output=True,timeout=20)
def state(r):
 m=re.search(r'ERROR:\s+([0-9A-Z]{5}):',r.stderr)
 return m.group(1) if m else ('00000' if r.returncode==0 else 'UNKNOWN')
results=[]
def pair(name,u1,sql1,u2,sql2,expected,check,extra='',isolation='READ COMMITTED'):
 reset=run('TRUNCATE public.organizations,auth.users CASCADE;'+fixture+extra)
 if reset.returncode:raise RuntimeError(reset.stderr)
 a=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 a.stdin.write("BEGIN; SET LOCAL statement_timeout='10s';"+session(u1)+sql1+'\n\\echo READY\n');a.stdin.flush()
 while True:
  line=a.stdout.readline()
  if line.strip()=='READY':break
  if not line:raise RuntimeError(a.stderr.read())
 sqlb=f"BEGIN ISOLATION LEVEL {isolation}; SET LOCAL application_name='security-race-b'; SET LOCAL statement_timeout='10s';"+session(u2)+sql2+'COMMIT;'
 with concurrent.futures.ThreadPoolExecutor() as ex:
  b=ex.submit(run,sqlb);overlap=False
  for _ in range(60):
   r=run("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='security-race-b' AND wait_event_type='Lock');")
   if r.stdout.strip()=='t':overlap=True;break
   if b.done():break
   time.sleep(.02)
  a.stdin.write('COMMIT;\n');a.stdin.close();a.wait(timeout=15)
  br=b.result(timeout=15)
 arerr=a.stderr.read();checkr=run(assertion(check))
 ok=overlap and a.returncode==0 and state(br)==expected and checkr.returncode==0
 results.append(dict(name=name,isolation=isolation,overlap_observed=overlap,passed=ok,b_state=state(br),expected=expected,detail='' if ok else arerr+br.stderr+checkr.stderr))
 print(('PASS ' if ok else 'FAIL ')+name+' '+isolation,flush=True)
info=json.loads(subprocess.check_output(['docker','inspect',C],text=True))[0]
assert info['HostConfig']['NetworkMode']=='none' and not info['HostConfig']['PortBindings'] and info['Config']['Labels']['tugpt.purpose']=='disposable-security-review'
ownerextra=f"INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('{A}',{q(11)},'owner');"
ownercheck=f"(SELECT count(*)=1 FROM public.organization_members WHERE organization_id='{A}' AND role='owner')"
for i in range(3):
 for isolation in ['READ COMMITTED','REPEATABLE READ','SERIALIZABLE']:
  pair(f'owner demotion race #{i+1}',1,manage(1,'set_role','admin'),11,manage(11,'set_role','admin'),'P3S05' if isolation=='READ COMMITTED' else '40001',ownercheck,ownerextra,isolation)
 pair(f'owner deletion race #{i+1}',1,manage(1,'remove'),11,manage(11,'remove'),'P3S05',ownercheck,ownerextra)
 pair(f'transfer race #{i+1}',1,f"SELECT public.transfer_organization_ownership('{A}',{q(2)});",1,f"SELECT public.transfer_organization_ownership('{A}',{q(3)});",'P3S02',ownercheck)
 pair(f'invitation replay race #{i+1}',7,"SELECT public.accept_invitation('good-token');",7,"SELECT public.accept_invitation('good-token');",'P3D04',f"(SELECT count(*)=1 FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(7)})")
 pair(f'removal before assignment #{i+1}',2,manage(3,'remove'),2,f"SELECT public.assign_conversation('{CONV}',{q(3)},NULL);",'P3C03',f"(SELECT assigned_to IS NULL FROM public.conversations WHERE id='{CONV}')",f"UPDATE public.conversations SET assigned_to={q(3)} WHERE id='{CONV}';")
 pair(f'assignment before removal #{i+1}',2,f"SELECT public.assign_conversation('{CONV}',{q(3)},NULL);",2,manage(3,'remove'),'00000',f"(SELECT assigned_to IS NULL FROM public.conversations WHERE id='{CONV}') AND (SELECT count(*)=2 FROM public.conversation_events WHERE conversation_id='{CONV}')")
 pair(f'assignment CAS race #{i+1}',3,f"SELECT public.assign_conversation('{CONV}',{q(3)},NULL);",2,f"SELECT public.assign_conversation('{CONV}',{q(2)},NULL);",'P3C04',f"(SELECT assigned_to={q(3)} FROM public.conversations WHERE id='{CONV}')")
 pair(f'actor revocation race #{i+1}',1,manage(2,'remove'),2,manage(9,'add','agent'),'P3S01',f"NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(9)})")
(ROOT/'evidence/concurrency-tests.json').write_text(json.dumps(results,indent=2))
print('Concurrency:',sum(t['passed'] for t in results),'/',len(results))
if not all(t['passed'] for t in results):raise SystemExit(1)
