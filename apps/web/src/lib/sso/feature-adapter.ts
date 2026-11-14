import type { TypedSupabaseClient } from '@tugpt/database';
import { bridgeToken, dbUrl, SsoError, UUID, type AppSession } from './core';
/** No tables, vault, writes, or arbitrary RPCs: current-member feature reads only. */
export function scopedFeatureAdapter(session:AppSession,organizationId:string,fetcher:typeof fetch=fetch):TypedSupabaseClient {
 if(!session?.mapped||!UUID.test(organizationId))throw new SsoError(401,'session_invalid');
 return {async rpc(fn:string,args:Record<string,unknown>){
  if(fn!=='is_feature_enabled'||args.p_organization_id!==organizationId||!['ai_draft_generation','media_generation','google_calendar_freebusy'].includes(String(args.p_flag_key)))return {data:null,error:{code:'42501',message:'Forbidden'}};
  const response=await fetcher(dbUrl()+'/rpc/feature_enabled',{method:'POST',headers:{Authorization:'Bearer '+bridgeToken('authenticated',session),'Content-Type':'application/json','Content-Profile':'sso','Accept-Profile':'sso'},body:JSON.stringify({p_organization_id:organizationId,p_flag_key:args.p_flag_key}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)return {data:null,error:{code:'42501',message:'Feature unavailable'}};
  const data=await response.json();return typeof data==='boolean'?{data,error:null}:{data:null,error:{code:'42501',message:'Feature unavailable'}};
 }} as unknown as TypedSupabaseClient;
}
