#!/usr/bin/env python3
"""Only the named disposable container. No URLs, credentials, or production connection accepted."""
import json,re,subprocess,sys,time,concurrent.futures
from pathlib import Path
C='tugpt-security-remediation-pg17'
ROOT=Path(__file__).resolve().parent

def uid(n):return '00000000-0000-0000-0000-'+str(n).zfill(12)
A=uid(101); B=uid(102); CONV=uid(401)
def q(n):return "'"+uid(n)+"'"
def psql(sql):
 return subprocess.run(['docker','exec','-i',C,'psql','-X','-U','postgres','-d','security_review','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At'],input=sql,text=True,capture_output=True)
def session(n,role='authenticated'):
 return f"SET LOCAL request.jwt.claims='{{\"sub\":\"{uid(n)}\",\"role\":\"{role}\"}}'; SET LOCAL ROLE {role};"
def assertion(expr):return "DO $assert$ BEGIN IF NOT coalesce(("+expr+"),false) THEN RAISE EXCEPTION 'test assertion failed'; END IF; END $assert$;"
fixture="INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES "+','.join(f"({q(n)},'user{n}@security-test.invalid',"+('NULL' if n==8 else 'now()')+",'{}')" for n in range(1,13))+';\n'
fixture+=f"INSERT INTO public.organizations(id,name,slug) VALUES('{A}','Synthetic A','security-a'),('{B}','Synthetic B','security-b');\n"
fixture+='INSERT INTO public.organization_members(organization_id,user_id,role) VALUES '+','.join(f"('{org}',{q(n)},'{role}')" for org,n,role in [(A,1,'owner'),(A,2,'admin'),(A,3,'agent'),(A,4,'viewer'),(A,10,'manager'),(B,6,'owner'),(B,5,'agent')])+';\n'
fixture+=f"INSERT INTO public.business_profiles(id,organization_id,display_name) VALUES({q(201)},'{A}','Synthetic A'),({q(202)},'{B}','Synthetic B');\n"
fixture+=f"INSERT INTO public.whatsapp_connections(id,organization_id,business_profile_id,phone_number,provider_phone_number_id,status) VALUES({q(301)},'{A}',{q(201)},'+15550000001','synthetic-1','active'),({q(302)},'{B}',{q(202)},'+15550000002','synthetic-2','active');\n"
fixture+=f"INSERT INTO public.conversations(id,organization_id,whatsapp_connection_id,contact_phone) VALUES('{CONV}','{A}',{q(301)},'+15551111111'),({q(402)},'{B}',{q(302)},'+15552222222');\n"
fixture+=f"INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('{A}','user7@security-test.invalid','agent',private.hash_invitation_token('good-token'),{q(1)},now()+interval '1 day'),('{A}','other@security-test.invalid','agent',private.hash_invitation_token('spoof-token'),{q(1)},now()+interval '1 day'),('{A}','user8@security-test.invalid','agent',private.hash_invitation_token('unverified-token'),{q(1)},now()+interval '1 day');\n"
(ROOT/'synthetic-fixtures.sql').write_text(fixture)
results=[]
def case(name,user,sql,expected='00000',setup='',role='authenticated'):
 r=psql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s';\n"+fixture+setup+session(user,role)+sql+'\nROLLBACK;')
 m=re.search(r'ERROR:\s+([0-9A-Z]{5}):',r.stderr); actual=m.group(1) if m else ('00000' if r.returncode==0 else 'UNKNOWN')
 ok=actual==expected
 results.append(dict(name=name,passed=ok,expected=expected,actual=actual,detail='' if ok else r.stderr[-2500:]))
 print(('PASS ' if ok else 'FAIL ')+name,flush=True)
def manage(n,action,role=None):return f"SELECT public.manage_organization_member('{A}',{q(n)},'{action}',"+("NULL" if role is None else "'"+role+"'")+");"

def main():
 info=json.loads(subprocess.check_output(['docker','inspect',C],text=True))[0]
 assert info['HostConfig']['NetworkMode']=='none' and not info['HostConfig']['PortBindings']
 assert info['Config']['Labels']['tugpt.purpose']=='disposable-security-review'
 phase=sys.argv[1]
 if phase=='baseline':
  case('F1 baseline admin can become owner',2,f"UPDATE public.organization_members SET role='owner' WHERE organization_id='{A}' AND user_id={q(2)};"+assertion(f"(SELECT role='owner' FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(2)})"))
  case('F2 baseline editable profile bypasses recipient binding',7,"UPDATE public.profiles SET email='other@security-test.invalid' WHERE id="+q(7)+"; SELECT public.accept_invitation('spoof-token');")
  case('F3 baseline agent can forge audit actor',3,f"INSERT INTO public.audit_logs(organization_id,user_id,action,resource) VALUES('{A}',{q(1)},'forged.owner.action','organization');")
  case('F4 baseline admin can assign outsider directly',2,f"UPDATE public.conversations SET assigned_to={q(5)} WHERE id='{CONV}';"+assertion(f"(SELECT assigned_to={q(5)} FROM public.conversations WHERE id='{CONV}')"))
 else:
  case('F1 direct admin escalation denied',2,f"UPDATE public.organization_members SET role='owner' WHERE organization_id='{A}' AND user_id={q(2)};",'42501')
  case('F1 direct owner insert denied too',1,f"INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('{A}',{q(9)},'owner');",'42501')
  case('F1 admin RPC self-promotion denied',2,manage(2,'set_role','owner'),'P3S02')
  case('F1 admin cannot create owner',2,manage(9,'add','owner'),'P3S02')
  case('F1 admin cannot demote owner',2,manage(1,'set_role','agent'),'P3S02')
  case('F1 admin cannot remove owner',2,manage(1,'remove'),'P3S02')
  case('F1 viewer cannot manage others',4,manage(3,'set_role','admin'),'P3S02')
  case('F1 cross-tenant management denied',5,manage(3,'set_role','admin'),'P3S01')
  case('F1 admin can add known user below ceiling',2,manage(9,'add','agent')+assertion(f"(SELECT role='agent' FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(9)})"))
  case('F1 admin can change lower member role',2,manage(3,'set_role','manager'))
  case('F1 admin can remove ordinary member',2,manage(3,'remove'))
  case('F1 viewer can leave',4,manage(4,'remove'))
  case('F1 last owner cannot leave',1,manage(1,'remove'),'P3S05')
  case('F1 last owner cannot demote self',1,manage(1,'set_role','admin'),'P3S05')
  case('F1 owner transfer atomic and audited',1,f"SELECT public.transfer_organization_ownership('{A}',{q(2)});"+assertion(f"(SELECT role='admin' FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(1)})")+assertion(f"(SELECT role='owner' FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(2)})")+assertion("EXISTS(SELECT 1 FROM public.audit_logs WHERE action='organization.transfer_ownership' AND user_id="+q(1)+")"))
  case('F1 admin transfer denied',2,f"SELECT public.transfer_organization_ownership('{A}',{q(3)});",'P3S02')
  case('F1 transfer to outsider denied',1,f"SELECT public.transfer_organization_ownership('{A}',{q(5)});",'P3S03')
  case('F1 privileged identity mutation rejected',1,f"UPDATE public.organization_members SET user_id={q(9)} WHERE organization_id='{A}' AND user_id={q(3)};",'P3S04',role='service_role')
  case('F1 new organization creation still works',7,f"SELECT public.create_organization_with_owner('Synthetic New','synthetic-new',{q(7)});")
  case('F1 owner invitation still works',1,f"SELECT public.create_invitation('{A}','new@security-test.invalid','owner');")
  case('F1 admin invitation below ceiling works',2,f"SELECT public.create_invitation('{A}','new@security-test.invalid','agent');")
  case('F1 admin owner invitation remains denied',2,f"SELECT public.create_invitation('{A}','new@security-test.invalid','owner');",'P3D08')
  case('F2 verified invitee can accept',7,"SELECT public.accept_invitation('good-token');")
  case('F2 mismatched identity denied',7,"SELECT public.accept_invitation('spoof-token');",'P3D06')
  case('F2 unverified identity denied',8,"SELECT public.accept_invitation('unverified-token');",'P3D10')
  case('F2 profile email write denied',7,"UPDATE public.profiles SET email='other@security-test.invalid' WHERE id="+q(7)+';','42501')
  case('F2 stale malicious profile ignored',7,"SELECT public.accept_invitation('spoof-token');",'P3D06',setup="UPDATE public.profiles SET email='other@security-test.invalid' WHERE id="+q(7)+';')
  case('F2 legitimate Auth identity ignores stale profile',7,"SELECT public.accept_invitation('good-token');",setup="UPDATE public.profiles SET email='stale@security-test.invalid' WHERE id="+q(7)+';')
  case('F2 profile display and locale update works',7,"UPDATE public.profiles SET full_name='Synthetic Updated',avatar_url='https://example.invalid/avatar',preferred_locale='en' WHERE id="+q(7)+';'+assertion('(SELECT full_name=\'Synthetic Updated\' FROM public.profiles WHERE id='+q(7)+')'))
  case('F2 profile identity fields denied',7,'UPDATE public.profiles SET deleted_at=now() WHERE id='+q(7)+';','42501')
  case('F2 invitation replay denied',7,"SELECT public.accept_invitation('good-token'); SELECT public.accept_invitation('good-token');",'P3D04')
  case('F2 revoked invitation denied',7,"SELECT public.accept_invitation('good-token');",'P3D04',setup="UPDATE public.organization_invitations SET status='revoked' WHERE token_hash=private.hash_invitation_token('good-token');")
  case('F2 expired invitation denied',7,"SELECT public.accept_invitation('good-token');",'P3D05',setup="UPDATE public.organization_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE token_hash=private.hash_invitation_token('good-token');")
  case('F2 deleted organization invitation denied',7,"SELECT public.accept_invitation('good-token');",'P3D01',setup=f"UPDATE public.organizations SET deleted_at=now() WHERE id='{A}';")
  case('F2 existing membership preserved',7,"SELECT public.accept_invitation('good-token');"+assertion(f"(SELECT role='viewer' FROM public.organization_members WHERE organization_id='{A}' AND user_id={q(7)})"),setup=f"INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('{A}',{q(7)},'viewer');")
  case('F3 agent audit forgery denied',3,f"INSERT INTO public.audit_logs(organization_id,user_id,action,resource) VALUES('{A}',{q(1)},'forged','organization');",'42501')
  case('F3 owner audit forgery denied',1,f"INSERT INTO public.audit_logs(organization_id,user_id,action,resource) VALUES('{A}',{q(2)},'forged','organization');",'42501')
  case('F3 trusted RPC emits actual actor',2,manage(3,'set_role','manager')+assertion(f"EXISTS(SELECT 1 FROM public.audit_logs WHERE user_id={q(2)} AND action='membership.set_role')"))
  case('F3 service audit insert works',1,f"INSERT INTO public.audit_logs(organization_id,user_id,action,resource) VALUES('{A}',NULL,'system.test','synthetic');",role='service_role')
  case('F4 direct outsider assignment denied',2,f"UPDATE public.conversations SET assigned_to={q(5)} WHERE id='{CONV}';",'42501')
  case('F4 direct valid assignment also must use RPC',2,f"UPDATE public.conversations SET assigned_to={q(3)} WHERE id='{CONV}';",'42501')
  case('F4 member assignment RPC works and logs',3,f"SELECT public.assign_conversation('{CONV}',{q(3)},NULL);"+assertion(f"EXISTS(SELECT 1 FROM public.conversation_events WHERE conversation_id='{CONV}' AND action='assign' AND actor_id={q(3)})"))
  case('F4 outsider RPC assignment denied',2,f"SELECT public.assign_conversation('{CONV}',{q(5)},NULL);",'P3C03')
  case('F4 viewer assignment denied',4,f"SELECT public.assign_conversation('{CONV}',{q(3)},NULL);",'P3C02')
  case('F4 stale compare-and-set rejected',2,f"SELECT public.assign_conversation('{CONV}',{q(3)},{q(2)});",'P3C04')
  case('F4 service invalid assignee denied at table',1,f"UPDATE public.conversations SET assigned_to={q(5)} WHERE id='{CONV}';",'P3C03',role='service_role')
  case('F4 normal conversation edits work',2,f"UPDATE public.conversations SET status='closed' WHERE id='{CONV}';")
  case('F4 normal conversation creation works',2,f"INSERT INTO public.conversations(organization_id,whatsapp_connection_id,contact_phone) VALUES('{A}',{q(301)},'+15553333333');")
  case('F4 creation with assigned_to cannot bypass RPC',2,f"INSERT INTO public.conversations(organization_id,whatsapp_connection_id,contact_phone,assigned_to) VALUES('{A}',{q(301)},'+15553333333',{q(5)});",'42501')
  case('F4 member removal clears assignment',2,manage(3,'remove')+assertion(f"(SELECT assigned_to IS NULL FROM public.conversations WHERE id='{CONV}')"),setup=f"UPDATE public.conversations SET assigned_to={q(3)} WHERE id='{CONV}';")
  case('Tenant read isolation preserved',3,assertion(f"NOT EXISTS(SELECT 1 FROM public.conversations WHERE organization_id='{B}')"))
  case('Soft delete still retains organization',1,f"DELETE FROM public.organizations WHERE id='{A}'; RESET ROLE;"+assertion(f"EXISTS(SELECT 1 FROM public.organizations WHERE id='{A}' AND deleted_at IS NOT NULL)"))
  case('Cleanup anon invitation cannot execute',7,"SELECT public.accept_invitation('good-token');",'42501',role='anon')
  case('Cleanup nonce browser access denied',1,'SELECT * FROM public.oauth_state_nonces;','42501')
  case('Nonce service insert default works',1,f"INSERT INTO public.oauth_state_nonces(state_hash,organization_id,user_id,expires_at) VALUES('synthetic-state','{A}',{q(1)},now()+interval '5 minutes');",role='service_role')
  case('Nonce duplicate remains rejected',1,f"INSERT INTO public.oauth_state_nonces(state_hash,organization_id,user_id,expires_at) VALUES('synthetic-state','{A}',{q(1)},now()+interval '5 minutes'),('synthetic-state','{A}',{q(1)},now()+interval '5 minutes');",'23505',role='service_role')
  case('F4 unassign RPC preserves CAS and event',2,f"SELECT public.assign_conversation('{CONV}',NULL,{q(3)});"+assertion(f"EXISTS(SELECT 1 FROM public.conversation_events WHERE conversation_id='{CONV}' AND action='unassign' AND actor_id={q(2)})"),setup=f"UPDATE public.conversations SET assigned_to={q(3)} WHERE id='{CONV}';")
  case('F4 cross-tenant assignment RPC hides existence',5,f"SELECT public.assign_conversation('{CONV}',{q(5)},NULL);",'P3C01')
  case('Invitation revoke RPC works',1,f"SELECT public.revoke_invitation((SELECT id FROM public.organization_invitations WHERE email='user7@security-test.invalid'));"+assertion("(SELECT status='revoked' FROM public.organization_invitations WHERE email='user7@security-test.invalid')"))
  case('Invitation revoke cross-tenant denied',5,"SELECT public.revoke_invitation('00000000-0000-0000-0000-000000000999');",'P3D01')
  signatures=['accept_invitation(text)','create_invitation(uuid,text,public.organization_role)','revoke_invitation(uuid)','approve_and_enqueue_draft(uuid,integer)','approve_draft(uuid,integer)','edit_draft(uuid,integer,text)','reject_draft(uuid,integer)']
  for sig in signatures:
   case('Cleanup anonymous denied, authenticated retained '+sig,1,assertion(f"NOT has_function_privilege('anon','public.{sig}','EXECUTE') AND has_function_privilege('authenticated','public.{sig}','EXECUTE') AND NOT EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.{sig}'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')"))
  for role in ['anon','authenticated']:
   case('Cleanup no MAINTAIN '+role,1,assertion(f"NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND has_table_privilege('{role}',c.oid,'MAINTAIN'))"))
 (ROOT/'evidence'/f'{phase}-security-tests.json').write_text(json.dumps(results,indent=2))
 print(json.dumps({'phase':phase,'passed':sum(r['passed'] for r in results),'total':len(results)}))
 if not all(r['passed'] for r in results):sys.exit(1)
if __name__=='__main__':main()
