import { createHash, randomBytes, createPrivateKey, sign } from 'node:crypto';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
export const SESSION_COOKIE='__Host-tugpt_session';
export const TICKET_COOKIE='__Host-tugpt_handoff';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const opaque=()=>randomBytes(32).toString('base64url');
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export type Identity={subject:string;auth_session:string;exp:number;iat:number;canonical_email?:string};
export type AppSession=Identity & {hash:string;expires_at:string;mapped:boolean};
export class SsoError extends Error { constructor(public status:number,public code:string){super(code);} }
// Run-owned non-production derivative: no production default or token-selected issuer.
export function canonicalConfig(env:Readonly<Record<string,string|undefined>>=process.env) {
 const ref=env.TUGPT_NONPROD_PROJECT_REF;
 const canonical=env.TUGPT_CANONICAL_AUTH_URL;
 if(env.TUGPT_AUTH_ENVIRONMENT!=='nonproduction'||!ref||!/^[a-z]{20}$/.test(ref)||ref==='rbiumegrwtavmljxbknp'||canonical!==`https://${ref}.supabase.co`)throw new SsoError(503,'configuration_unavailable');
 return {canonical,issuer:canonical+'/auth/v1'};
}
let remote:{issuer:string;keys:JWTVerifyGetKey}|undefined;
function canonicalKeys(issuer:string):JWTVerifyGetKey {
 if(!remote||remote.issuer!==issuer)remote={issuer,keys:createRemoteJWKSet(new URL(issuer+'/.well-known/jwks.json'),{timeoutDuration:4000,cooldownDuration:5000,cacheMaxAge:300000})};
 return remote.keys;
}
export async function verifyCanonical(token:string, fetcher:typeof fetch=fetch, keys?:JWTVerifyGetKey):Promise<Identity> {
 const {canonical,issuer}=canonicalConfig();
 if(typeof token!=='string'||token.length>12000||token.split('.').length!==3)throw new SsoError(401,'identity_invalid');
 try {
  const header=decodeProtectedHeader(token);
  // ES256 remains mandatory. Verify the new provider JWKS before runtime; never relax to HS256.
  if(header.alg!=='ES256'||!header.kid||header.jku||header.jwk||header.x5u)throw Error();
  const {payload}=await jwtVerify(token,keys??canonicalKeys(issuer),{issuer,audience:'authenticated',algorithms:['ES256'],requiredClaims:['exp','iat','sub','session_id'],clockTolerance:0});
  const now=Math.floor(Date.now()/1000);
  if(payload.aud!=='authenticated'||payload.role!=='authenticated'||!UUID.test(payload.sub||'')||!UUID.test(String(payload.session_id))||typeof payload.iat!=='number'||payload.iat>now||typeof payload.exp!=='number'||payload.exp<=now)throw Error();
  const key=process.env.TUGPT_CANONICAL_PUBLIC_KEY;if(!key)throw new SsoError(503,'identity_unavailable');
  const response=await fetcher(canonical+'/auth/v1/user',{headers:{apikey:key,Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
  if(response.status>=500||response.status===429)throw new SsoError(503,'identity_unavailable');
  if(!response.ok)throw Error();
  const user=await response.json();
  if(user.id!==payload.sub||user.deleted_at||(user.banned_until&&Date.parse(user.banned_until)>Date.now())||(user.session_id&&user.session_id!==payload.session_id))throw Error();
  const email=typeof user.email==='string'&&user.email.length<=320&&/^[^\s@]+@[^\s@]+$/.test(user.email)&&typeof user.email_confirmed_at==='string'&&Number.isFinite(Date.parse(user.email_confirmed_at))&&Date.parse(user.email_confirmed_at)<=Date.now()?user.email:undefined;
  return {subject:payload.sub!,auth_session:String(payload.session_id),exp:payload.exp,iat:payload.iat,...(email?{canonical_email:email}:{})};
 }catch(e){if(e instanceof SsoError)throw e;throw new SsoError(401,'identity_invalid');}
}
export function bridgeToken(role:'sso_control'|'authenticated',session?:AppSession):string {
 if(role==='authenticated'&&(!session||!session.mapped||Date.parse(session.expires_at)<=Date.now()))throw new SsoError(401,'session_invalid');
 const now=Math.floor(Date.now()/1000),exp=Math.min(now+30,session?Math.floor(Date.parse(session.expires_at)/1000):now+30);
 const kid=process.env.TUGPT_DB_SIGNING_KID, pem=process.env.TUGPT_DB_SIGNING_PRIVATE_KEY;
 if(!kid||!pem)throw new SsoError(503,'configuration_unavailable');
 const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid})).toString('base64url');
 const c=Buffer.from(JSON.stringify({iss:'urn:tugpt:dashboard:bridge',aud:'tugpt-dashboard-db',role,iat:now,exp,
 ...(session?{sub:session.subject,session_id:session.auth_session,dash_session:session.hash}:{} )})).toString('base64url');
 return h+'.'+c+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+c),createPrivateKey(pem.replace(/\\n/g,'\n'))).toString('base64url');
}
export function dbUrl(){const raw=process.env.TUGPT_DASHBOARD_POSTGREST_URL;if(!raw)throw new SsoError(503,'configuration_unavailable');const u=new URL(raw);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname))))throw new SsoError(503,'configuration_unavailable');return u.origin;}
export async function control<T>(fn:string,args:Record<string,unknown>):Promise<T>{
 const response=await fetch(dbUrl()+'/rpc/'+fn,{method:'POST',headers:{Authorization:'Bearer '+bridgeToken('sso_control'),'Content-Type':'application/json','Content-Profile':'sso','Accept-Profile':'sso'},body:JSON.stringify(args),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new SsoError(503,'session_store_unavailable');
 return (response.status===204?null:await response.json()) as T;
}
export function cookieValue(header:string|null,name:string):string|null {
 const found=(header||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 if(found.length!==1)return null;const value=found[0].slice(name.length+1);return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
export async function loadSession(header:string|null):Promise<AppSession|null>{
 const value=cookieValue(header,SESSION_COOKIE);if(!value)return null;const hash=digest(value);
 const row=await control<Omit<AppSession,'hash'>|null>('load_session',{p_hash:hash});
 if(!row||Date.parse(row.expires_at)<=Date.now()||!UUID.test(row.subject)||!UUID.test(row.auth_session))return null;
 return {...row,hash};
}
export function origins(){return {site:'https://tugpt.pro',dashboard:'https://dashboard.tugpt.pro'};}
export const safeHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export function cookie(name:string,value:string,age:number){return `${name}=${value}; Path=/; Max-Age=${Math.max(0,Math.floor(age))}; Secure; HttpOnly; SameSite=Lax`;}
