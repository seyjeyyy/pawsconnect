// Read-only deployment preflight. Prints no credentials or customer records.
import dotenv from 'dotenv';
import {createClient} from '@supabase/supabase-js';
dotenv.config({path:'server/.env',quiet:true});
const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)throw Error('Supabase is not configured.');
const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}});
let failed=false;
for(const table of ['operations_config','account_access_controls','operations_signals']){
 // GET with limit zero preserves PostgREST error codes; HEAD can omit them.
 const {error}=await db.from(table).select('*').limit(0);
 console.info(JSON.stringify({check:table,ok:!error,code:error?.code}));failed ||= !!error;
}
const {data,error}=await db.rpc('account_session_allowed',{p_user_id:'00000000-0000-4000-8000-000000000000',p_session_id:'00000000-0000-4000-8000-000000000000'});
console.info(JSON.stringify({check:'account_session_allowed',ok:!error&&data===false,code:error?.code,message:error?.message,hint:error?.hint}));
const config=await db.from('operations_config').select('schema_version').eq('id',true).single();
console.info(JSON.stringify({check:'schema_version',version:config.data?.schema_version,code:config.error?.code}));
failed ||= !!config.error||config.data?.schema_version!=='016';
failed ||= !!error||data!==false;
if(failed)console.error('Deployment blocked: apply migrations 015–016 in the Supabase SQL editor, refresh the PostgREST schema cache, then rerun this check. No data was changed.');
else console.info('Operations schema preflight passed. This does not replace authenticated staging acceptance tests.');
process.exitCode=failed?1:0;
