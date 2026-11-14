import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,exportPKCS8,jwtVerify,decodeJwt} from 'jose';
import {verifyCanonical,canonicalConfig,opaque,digest,cookie,cookieValue,bridgeToken,dbUrl,SESSION_COOKIE,type AppSession} from './core';
// Unit-test-only issuer. No network or real provider identity is used.
const TEST_REF='abcdefghijklmnopqrst',ISSUER='https://'+TEST_REF+'.supabase.co/auth/v1';
beforeEach(()=>{vi.stubEnv('TUGPT_AUTH_ENVIRONMENT','nonproduction');vi.stubEnv('TUGPT_NONPROD_PROJECT_REF',TEST_REF);vi.stubEnv('TUGPT_CANONICAL_AUTH_URL','https://'+TEST_REF+'.supabase.co');});
let pair:Awaited<ReturnType<typeof generateKeyPair>>,keys:ReturnType<typeof createLocalJWKSet>;
const subject='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222';
beforeAll(async()=>{pair=await generateKeyPair('ES256');keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'synthetic',alg:'ES256'}]});});
afterEach(()=>vi.unstubAllEnvs());
async function token(patch:Record<string,unknown>={},head:Record<string,unknown>={}){const now=Math.floor(Date.now()/1000);return new SignJWT({iss:ISSUER,aud:'authenticated',sub:subject,session_id:sid,role:'authenticated',iat:now,exp:now+3600,...patch}).setProtectedHeader({alg:'ES256',kid:'synthetic',...head}).sign(pair.privateKey);}
function user(body:unknown={id:subject},status=200){return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body),{status}));}
it('strict ES256 canonical verification preserves only signed identity, never the token',async()=>{vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic-public-key');const f=user();const result=await verifyCanonical(await token(),f,keys);expect(Object.keys(result).sort()).toEqual(['auth_session','exp','iat','subject']);expect(result.subject).toBe(subject);expect(result.auth_session).toBe(sid);expect(f).toHaveBeenCalledTimes(1);});
for(const [name,patch] of Object.entries({issuer:{iss:'https://wrong.invalid'},audience:{aud:'other'},audienceArray:{aud:['authenticated']},expired:{exp:1},futureNbf:{nbf:4102444800},futureIat:{iat:4102444800},role:{role:'service_role'},subject:{sub:'not-a-uuid'},missingSubject:{sub:undefined},session:{session_id:'bad'},missingSession:{session_id:undefined},missingIat:{iat:undefined},missingExp:{exp:undefined}}))it('rejects canonical '+name,async()=>{vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic');const f=user();await expect(verifyCanonical(await token(patch),f,keys)).rejects.toMatchObject({status:401});expect(f).not.toHaveBeenCalled();});
for(const [name,head] of Object.entries({unknownKid:{kid:'unknown'},missingKid:{kid:undefined},remoteJku:{jku:'https://wrong.invalid/key'},embeddedJwk:{jwk:{}},remoteX5u:{x5u:'https://wrong.invalid/cert'}}))it('rejects canonical header '+name,async()=>{await expect(verifyCanonical(await token({},head),user(),keys)).rejects.toMatchObject({status:401});});
it('rejects HS256 even if caller presents an apparently valid UUID',async()=>{const t=await new SignJWT({sub:subject}).setProtectedHeader({alg:'HS256',kid:'synthetic'}).sign(new Uint8Array(32));await expect(verifyCanonical(t,user(),keys)).rejects.toMatchObject({status:401});});
it('rejects signature tampering',async()=>{const t=await token();const a=t.split('.');a[2]=(a[2][0]==='A'?'B':'A')+a[2].slice(1);await expect(verifyCanonical(a.join('.'),user(),keys)).rejects.toMatchObject({status:401});});
for(const [name,body,status] of [['unknown',{},401],['mismatched user',{id:sid},200],['deleted',{id:subject,deleted_at:'2026-01-01'},200],['banned',{id:subject,banned_until:'2100-01-01'},200],['mismatched session',{id:subject,session_id:subject},200]] as const)it('rejects Auth '+name,async()=>{vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic');await expect(verifyCanonical(await token(),user(body,status),keys)).rejects.toMatchObject({status:401});});
it('Auth outage fails closed with generic unavailable response',async()=>{vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic');await expect(verifyCanonical(await token(),user({},503),keys)).rejects.toMatchObject({status:503});});
it('opaque values are random 256-bit values and hash-only storage inputs',()=>{const a=opaque(),b=opaque();expect(a).toHaveLength(43);expect(a).not.toBe(b);expect(digest(a)).toMatch(/^[a-f0-9]{64}$/);});
it('cookie is host-only, Secure, HttpOnly and Lax; duplicates/malformed values fail closed',()=>{const a=opaque();const c=cookie(SESSION_COOKIE,a,900);expect(c).toContain('; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax');expect(c).not.toContain('Domain');expect(cookieValue(SESSION_COOKIE+'='+a,SESSION_COOKIE)).toBe(a);expect(cookieValue(SESSION_COOKIE+'='+a+'; '+SESSION_COOKIE+'='+a,SESSION_COOKIE)).toBeNull();expect(cookieValue(SESSION_COOKIE+'=bad',SESSION_COOKIE)).toBeNull();});
it('DB assertion is RS256, narrowly scoped, short-lived and session-bound',async()=>{const rsa=await generateKeyPair('RS256',{extractable:true});vi.stubEnv('TUGPT_DB_SIGNING_KID','test');vi.stubEnv('TUGPT_DB_SIGNING_PRIVATE_KEY',await exportPKCS8(rsa.privateKey));const s:AppSession={subject,auth_session:sid,exp:Math.floor(Date.now()/1000)+900,iat:Math.floor(Date.now()/1000),hash:digest(opaque()),expires_at:new Date(Date.now()+900000).toISOString(),mapped:true};const t=bridgeToken('authenticated',s);const {payload}=await jwtVerify(t,rsa.publicKey,{issuer:'urn:tugpt:dashboard:bridge',audience:'tugpt-dashboard-db',algorithms:['RS256']});expect(payload.sub).toBe(subject);expect(payload.dash_session).toBe(s.hash);expect(payload.role).toBe('authenticated');expect(payload.exp!-payload.iat!).toBeLessThanOrEqual(30);expect(()=>bridgeToken('authenticated',{...s,mapped:false})).toThrow();expect(()=>bridgeToken('authenticated',{...s,expires_at:new Date(0).toISOString()})).toThrow();expect(decodeJwt(t)).not.toHaveProperty('refresh_token');});
for(const url of ['http://external.invalid','https://good.invalid/path','https://user:password@good.invalid','https://good.invalid/?key=x'])it('rejects unsafe DB transport '+url,()=>{vi.stubEnv('TUGPT_DASHBOARD_POSTGREST_URL',url);expect(()=>dbUrl()).toThrow();});

it('canonical email evidence comes only from confirmed server Auth user',async()=>{vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic');const t=await token({email:'forged@example.invalid',email_verified:true});expect((await verifyCanonical(t,user({id:subject,email:'real@example.invalid',email_confirmed_at:'2020-01-01T00:00:00Z'}),keys)).canonical_email).toBe('real@example.invalid');expect((await verifyCanonical(t,user({id:subject,email:'unverified@example.invalid'}),keys)).canonical_email).toBeUndefined();});

it('binds both JWT issuer and online user validation to the configured non-production project', async()=>{
 vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic-public-key'); const f=user();
 await verifyCanonical(await token(),f,keys);
 expect(f).toHaveBeenCalledWith('https://'+TEST_REF+'.supabase.co/auth/v1/user',expect.objectContaining({redirect:'error',cache:'no-store'}));
 expect(canonicalConfig().issuer).toBe(ISSUER);
});
it.each([
 {},
 {TUGPT_AUTH_ENVIRONMENT:'production',TUGPT_NONPROD_PROJECT_REF:TEST_REF,TUGPT_CANONICAL_AUTH_URL:'https://'+TEST_REF+'.supabase.co'},
 {TUGPT_AUTH_ENVIRONMENT:'nonproduction',TUGPT_NONPROD_PROJECT_REF:'rbiumegrwtavmljxbknp',TUGPT_CANONICAL_AUTH_URL:'https://rbiumegrwtavmljxbknp.supabase.co'},
 ...['http://'+TEST_REF+'.supabase.co','https://evil.invalid','https://'+TEST_REF+'.supabase.co/','https://user@'+TEST_REF+'.supabase.co','https://'+TEST_REF+'.supabase.co?x=1','https://'+TEST_REF+'.supabase.co/auth/v1','https://'+TEST_REF+'.supabase.co.evil.invalid'].map(url=>({TUGPT_AUTH_ENVIRONMENT:'nonproduction',TUGPT_NONPROD_PROJECT_REF:TEST_REF,TUGPT_CANONICAL_AUTH_URL:url}))
])('rejects missing, production or non-exact Auth configuration %#', env=>{
 expect(()=>canonicalConfig(env)).toThrowError('configuration_unavailable');
});
it('rejects a production-issued JWT before online user validation',async()=>{
 vi.stubEnv('TUGPT_CANONICAL_PUBLIC_KEY','synthetic-public-key');const f=user();
 await expect(verifyCanonical(await token({iss:'https://rbiumegrwtavmljxbknp.supabase.co/auth/v1'}),f,keys)).rejects.toMatchObject({status:401});
 expect(f).not.toHaveBeenCalled();
});
