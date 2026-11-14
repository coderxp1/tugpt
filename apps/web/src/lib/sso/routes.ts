import {readSmallJson,isRecord} from '@/lib/http/mutations';
import {SsoError,verifyCanonical,opaque,digest,control,cookieValue,cookie,loadSession,origins,safeHeaders,TICKET_COOKIE,SESSION_COOKIE} from './core';
function headers(request:Request,website=false){const h=new Headers(safeHeaders);if(website){h.set('Vary','Origin');if(request.headers.get('origin')===origins().site){h.set('Access-Control-Allow-Origin',origins().site);h.set('Access-Control-Allow-Credentials','true');h.set('Access-Control-Allow-Methods','POST, OPTIONS');h.set('Access-Control-Allow-Headers','content-type');}}return h;}
function json(request:Request,status:number,value:unknown,website=false){const h=headers(request,website);h.set('Content-Type','application/json');return new Response(JSON.stringify(value),{status,headers:h});}
// The reverse proxy must overwrite Host and X-Forwarded-Proto; Next's internal URL hostname can be loopback.
function dashboardRequest(request:Request){return request.headers.get('host')===new URL(origins().dashboard).host && request.headers.get('x-forwarded-proto')==='https';}
function origin(request:Request,website:boolean){if(!dashboardRequest(request)||request.headers.get('origin')!==(website?origins().site:origins().dashboard)||request.headers.get('sec-fetch-site')==='cross-site')throw new SsoError(403,'origin_denied');}
async function identity(request:Request){
 origin(request,true);
 if(new URL(request.url).search)throw new SsoError(400,'invalid_request');
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new SsoError(415,'json_required');
 // Global shared limit before Auth I/O; per-session shared limit after verified identity.
 if(!await control<boolean>('limit_request',{p_bucket:'handoff:global',p_limit:120}))throw new SsoError(429,'rate_limited');
 let body;try{body=await readSmallJson(request);}catch{throw new SsoError(400,'invalid_request');}
 if(!isRecord(body)||Object.keys(body).length!==1||typeof body.access_token!=='string')throw new SsoError(400,'invalid_request');
 return verifyCanonical(body.access_token);
}
export function options(request:Request){try{origin(request,true);if(request.headers.get('access-control-request-method')!=='POST'||(request.headers.get('access-control-request-headers')||'').split(',').some(h=>h.trim()&&h.trim().toLowerCase()!=='content-type'))throw Error();return new Response(null,{status:204,headers:headers(request,true)});}catch{return new Response(null,{status:403,headers:headers(request,true)});}}
export async function handoff(request:Request){try{
 const id=await identity(request);
 if(!await control<boolean>('limit_request',{p_bucket:'handoff:'+id.subject+':'+id.auth_session,p_limit:10}))throw new SsoError(429,'rate_limited');
 const ticket=opaque();if(!await control<boolean>('issue_verified_ticket',{p_hash:digest(ticket),p_subject:id.subject,p_auth_session:id.auth_session,p_token_exp:id.exp,p_token_iat:id.iat,p_canonical_email:id.canonical_email??null}))throw new SsoError(401,'identity_invalid');
 const response=json(request,200,{ok:true,complete_url:origins().dashboard+'/auth/complete'},true);response.headers.append('Set-Cookie',cookie(TICKET_COOKIE,ticket,30));return response;
 }catch(e){return failure(request,e,true);}}
export async function complete(request:Request){try{
 if(!dashboardRequest(request)||request.headers.get('sec-fetch-site')==='cross-site')throw new SsoError(403,'origin_denied');
 if(new URL(request.url).search)throw new SsoError(400,'invalid_request');
 const ticket=cookieValue(request.headers.get('cookie'),TICKET_COOKIE);if(!ticket)throw new SsoError(401,'ticket_invalid');
 const raw=opaque();const row=await control<{expires_at:string}|null>('consume_ticket',{p_ticket_hash:digest(ticket),p_session_hash:digest(raw)});
 if(!row)throw new SsoError(401,'ticket_invalid');
 const h=headers(request);h.append('Set-Cookie',cookie(TICKET_COOKIE,'',0));h.append('Set-Cookie',cookie(SESSION_COOKIE,raw,(Date.parse(row.expires_at)-Date.now())/1000));h.set('Location','/dashboard');return new Response(null,{status:303,headers:h});
 }catch(e){const r=failure(request,e);r.headers.append('Set-Cookie',cookie(TICKET_COOKIE,'',0));return r;}}
export async function revoke(request:Request){try{const id=await identity(request);await control('revoke_auth_session',{p_subject:id.subject,p_auth_session:id.auth_session});return json(request,200,{revoked:true},true);}catch(e){return failure(request,e,true);}}
export async function logout(request:Request){try{
 origin(request,false);if(request.headers.get('x-tugpt-csrf')!=='1')throw new SsoError(403,'csrf_required');
 const raw=cookieValue(request.headers.get('cookie'),SESSION_COOKIE),ticket=cookieValue(request.headers.get('cookie'),TICKET_COOKIE);
 await control('logout_session',{p_hash:raw?digest(raw):'',p_ticket_hash:ticket?digest(ticket):null});
 const r=json(request,200,{signed_out:true});r.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));r.headers.append('Set-Cookie',cookie(TICKET_COOKIE,'',0));return r;
 }catch(e){return failure(request,e);}}
export async function sessionInfo(request:Request){try{const s=await loadSession(request.headers.get('cookie'));return s?json(request,200,{authenticated:true,expires_at:s.expires_at,mapped:s.mapped}):json(request,401,{error:'session_invalid',renew_url:origins().site+'/login.html?dashboard=1'});}catch(e){return failure(request,e);}}
function failure(request:Request,e:unknown,website=false){const err=e instanceof SsoError?e:new SsoError(503,'temporarily_unavailable');return json(request,err.status,{error:err.code},website);}
