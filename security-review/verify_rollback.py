import json,re,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
query="""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f'),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgname='trigger_prevent_last_owner_removal'),'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'));"""
r=subprocess.run(['docker','exec','tugpt-security-remediation-pg17','psql','-X','-U','postgres','-d','security_review','-Atc',query],text=True,capture_output=True,check=True)
a=json.loads((root/'evidence/baseline-rollback-catalog.json').read_text());b=json.loads(r.stdout)
def acl(s):return sorted(re.findall(r'([^=,{}]*)=([^/,{}]*)/([^,{}]+)',s or ''))
checks=[]
for category,key in [('functions','signature'),('relations','name')]:
 am={x[key]:x for x in a[category]};bm={x[key]:x for x in b[category]}
 checks.append(dict(name=category+' object set restored',passed=set(am)==set(bm)))
 for name,x in am.items():
  y=bm.get(name,{})
  checks.append(dict(name=category+' '+name,passed=all(acl(x[k])==acl(y.get(k)) if k=='acl' else x[k]==y.get(k) for k in x)))
checks.append(dict(name='original owner trigger restored',passed=a['triggers']==b['triggers']))
q="SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN ('public.conversations'::regclass,'public.profiles'::regclass) AND attacl IS NOT NULL) AND to_regclass('private.membership_write_locks') IS NULL;"
r=subprocess.run(['docker','exec','tugpt-security-remediation-pg17','psql','-X','-U','postgres','-d','security_review','-Atc',q],text=True,capture_output=True,check=True)
checks.append(dict(name='candidate columns and guard table removed',passed=r.stdout.strip()=='t'))
(root/'evidence/rollback-catalog-verification.json').write_text(json.dumps(checks,indent=2))
print('Rollback catalog checks:',sum(t['passed'] for t in checks),'/',len(checks))
for c in checks:
 if not c['passed']:print('FAIL',c['name'])
if not all(t['passed'] for t in checks):raise SystemExit(1)
