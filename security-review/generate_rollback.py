import json,re
from pathlib import Path
root=Path(__file__).resolve().parent
c=json.loads((root/'evidence/baseline-rollback-catalog.json').read_text())
out=['-- REVIEW ONLY: restores reviewed baseline and REOPENS F1-F4. Separate approval required.','BEGIN;',"SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='60s';",'DROP TRIGGER enforce_conversation_assignment ON public.conversations;','DROP FUNCTION private.enforce_conversation_assignment();','DROP FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role);','DROP FUNCTION public.transfer_organization_ownership(uuid,uuid);','DROP TRIGGER trigger_prevent_last_owner_removal ON public.organization_members;']
for name in ['private.prevent_last_owner_removal()','private.accept_invitation(text)','private.assign_conversation(uuid,uuid,uuid)']:
 f=next(f for f in c['functions'] if f['signature']==name);out.append(f['definition']+';')
out.extend(t+';' for t in c['triggers'])
out+=['DROP FUNCTION private.lock_organization_membership(uuid);','DROP TABLE private.membership_write_locks;']
# Undo newly added column-level privileges, then restore only reviewed browser ACLs.
out+=['REVOKE UPDATE(full_name,avatar_url,preferred_locale) ON public.profiles FROM authenticated;', 'REVOKE INSERT(id,organization_id,whatsapp_connection_id,contact_phone,status,last_message_at,created_at,updated_at,activity_at,contact_id) ON public.conversations FROM authenticated;', 'REVOKE UPDATE(whatsapp_connection_id,contact_phone,status,last_message_at,updated_at,activity_at,contact_id) ON public.conversations FROM authenticated;']
cols={'a':'INSERT','r':'SELECT','w':'UPDATE','d':'DELETE','D':'TRUNCATE','x':'REFERENCES','t':'TRIGGER','m':'MAINTAIN'}
names='ai_draft_configs ai_draft_review_events ai_draft_revisions ai_drafts audit_logs business_profiles conversation_events conversations feature_flags messages oauth_state_nonces organization_members organizations profiles whatsapp_connections'.split()
for r in c['relations']:
 if r['name'].split('.')[-1] not in names:continue
 table=r['name'] if '.' in r['name'] else 'public.'+r['name'];out.append(f'REVOKE ALL ON {table} FROM PUBLIC,anon,authenticated;')
 for role,priv in re.findall(r'([^=,{}]*)=([^/,{}]*)/[^,{}]+',r['acl'] or ''):
  if role not in ['','anon','authenticated']:continue
  assert '*' not in priv
  if priv:out.append(f"GRANT {','.join(cols[p] for p in priv)} ON {table} TO {role or 'PUBLIC'};")
sigs=['accept_invitation(text)','create_invitation(uuid,text,organization_role)','revoke_invitation(uuid)','approve_and_enqueue_draft(uuid,integer)','approve_draft(uuid,integer)','edit_draft(uuid,integer,text)','reject_draft(uuid,integer)']
for sig in sigs:
 f=next(f for f in c['functions'] if f['signature'].removeprefix('public.')==sig)
 out.append('REVOKE EXECUTE ON FUNCTION public.'+sig.replace('organization_role','public.organization_role')+' FROM PUBLIC,anon;')
 for role,priv in re.findall(r'([^=,{}]*)=([^/,{}]*)/[^,{}]+',f['acl'] or '{=X/postgres}'):
  if role in ['','anon'] and 'X' in priv:out.append('GRANT EXECUTE ON FUNCTION public.'+sig.replace('organization_role','public.organization_role')+' TO '+(role or 'PUBLIC')+';')
out.append('COMMIT;')
(root/'rollback/restore_reviewed_baseline.sql').write_text('\n'.join(out)+'\n')
print('Exact reviewed-baseline rollback generated.')
