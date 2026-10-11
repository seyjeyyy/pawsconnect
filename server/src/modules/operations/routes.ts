import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env, integrations, configured } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { requireMfa, requireRecentMfa } from '../../middleware/mfa.js';
import { formLimiter, workerLimiter } from '../../middleware/rateLimit.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid, pagination } from '../../utils/validation.js';
import { effectiveMaintenance, readOperationsConfig } from './maintenance.js';

const modules=z.enum(['shop','adoption','rescue','transport','donations','volunteers','uploads','account']);
export const configInput=z.object({
 version:z.number().int().positive(),mode:z.enum(['normal','read_only','partial','full','lockdown']),modules:z.array(modules).max(8),
 starts_at:z.string().datetime({offset:true}).nullable(),ends_at:z.string().datetime({offset:true}).nullable(),
 public_notice:z.string().max(500),instructions:z.string().max(2000),reason:z.string().trim().min(10).max(2000),
 disabled_features:z.array(z.enum(['shop','adoption','rescue','transport','donations','volunteers','uploads'])).max(7),
 slow_request_ms:z.number().int().min(250).max(30000),backup_interval_hours:z.number().int().min(1).max(168).nullable(),
 retention_days:z.number().int().min(7).max(365),rpo_minutes:z.number().int().min(1).max(10080),rto_minutes:z.number().int().min(1).max(10080),
}).strict().superRefine((v,c)=>{
 if(v.mode!=='normal' && (!v.starts_at || !v.ends_at || Date.parse(v.ends_at)<=Date.parse(v.starts_at) || Date.parse(v.ends_at)<=Date.now() || Date.parse(v.ends_at)-Date.parse(v.starts_at)>86400000)) c.addIssue({code:'custom',message:'Maintenance needs a valid start and future end within 24 hours.',path:['ends_at']});
 if(v.mode==='partial' && !v.modules.length)c.addIssue({code:'custom',message:'Select at least one affected service.',path:['modules']});
});
const kind=z.enum(['backup','restore_drill','restore_production','deployment','rollback']);
export function configuredWorkerKinds() {
 if(!env.OPERATIONS_WORKER_SECRET || env.OPERATIONS_WORKER_SECRET.length<32)return [];
 // A restore of this database also rewinds its queue, access cutoffs and audit.
 // Production dispatch requires a durable coordinator outside the restored project.
 return (env.OPERATIONS_WORKER_KINDS || '').split(',').map(s=>s.trim()).filter(s=>s!=='restore_production' && kind.safeParse(s).success);
}
const publicRequestColumns='id,kind,target,reason,requested_by,approved_by,approved_at,status,recovery_point_id,pre_restore_backup_id,release_ref,created_at,started_at,finished_at,report,failure_code';
const withoutLease=(row:Record<string,unknown>|null)=>row && Object.fromEntries(Object.entries(row).filter(([key])=>!['lease_token','lease_expires_at','idempotency_key'].includes(key)));

export const operationsPublicRouter=Router();
operationsPublicRouter.get('/operations/status',async(_req,res)=>{
 if(!configured){res.json({data:{configured:false,active:false,mode:'normal',public_notice:''}});return;}
 const config=await readOperationsConfig();
 res.json({data:{configured:true,active:effectiveMaintenance(config),mode:config.mode,modules:config.modules,starts_at:config.starts_at,ends_at:config.ends_at,public_notice:config.public_notice,disabled_features:config.disabled_features}});
});
operationsPublicRouter.post('/operations/client-error',formLimiter,async(req,res)=>{
 const input=z.object({code:z.enum(['RENDER_ERROR','UNHANDLED_ERROR','UNHANDLED_REJECTION'])}).strict().parse(req.body);
 assertDb(await db().from('operations_signals').insert({source:'browser_untrusted',code:input.code,severity:'medium'}));
 res.status(202).json({data:{received:true}});
});
operationsPublicRouter.get('/operations/tour/:key',authenticate,async(req,res)=>{
 const key=z.string().regex(/^[a-z0-9_-]{3,100}$/).parse(req.params.key);
 res.json({data:assertDb(await db().from('tour_progress').select('step,status,updated_at').eq('user_id',req.actor!.id).eq('tour_key',key).maybeSingle())});
});
operationsPublicRouter.put('/operations/tour/:key',authenticate,async(req,res)=>{
 const key=z.string().regex(/^[a-z0-9_-]{3,100}$/).parse(req.params.key);
 const input=z.object({step:z.number().int().min(0).max(100),status:z.enum(['paused','completed','dismissed'])}).strict().parse(req.body);
 res.json({data:assertDb(await db().from('tour_progress').upsert({...input,tour_key:key,user_id:req.actor!.id,updated_at:new Date().toISOString()},{onConflict:'user_id,tour_key'}).select('step,status,updated_at').single())});
});

export const operationsRouter=Router();
operationsRouter.use(authenticate,authorize('super_administrator'),requireMfa);
operationsRouter.get('/overview',async(req,res)=>{
 const start=performance.now();
 const diagnostics=assertDb(await db().rpc('operations_diagnostics',{p_actor_id:req.actor!.id}));
 const databaseLatency=Math.round(performance.now()-start);
 const config=await readOperationsConfig();
 res.json({data:{checked_at:new Date().toISOString(),database:{status:'reachable',latency_ms:databaseLatency,...diagnostics},config,
  integrations:{supabase:'reachable',authentication:'verified for this session',stripe:integrations.stripe?'configured; connectivity not probed':'unconfigured',maps:'configured; connectivity not probed',email:'delivery worker not configured',notifications:'database + Realtime; delivery acknowledgments unavailable'},
  worker_kinds:configuredWorkerKinds(),
  deployment:{commit:env.RELEASE_COMMIT || env.VERCEL_GIT_COMMIT_SHA || null,date:env.RELEASE_DATE || null,environment:env.VERCEL_ENV || env.NODE_ENV,notes:env.RELEASE_NOTES || null,history_available:false,rollback:'Requires a tested release artifact and migration compatibility review'},
  unavailable:['Provider CPU and memory limits','Storage bytes and growth history','Auth provider sign-in events','Database query duration samples and index recommendations'],
 }});
});
operationsRouter.get('/config',async(_req,res)=>res.json({data:await readOperationsConfig()}));
operationsRouter.put('/config',requireRecentMfa,async(req,res)=>{
 const {version,...input}=configInput.parse(req.body);
 if(input.backup_interval_hours && !configuredWorkerKinds().includes('backup'))throw new ApiError(503,'WORKER_UNCONFIGURED','Configure and validate the backup worker before enabling a schedule.');
 res.json({data:assertDb(await db().rpc('change_operations_config',{p_actor_id:req.actor!.id,p_version:version,p_config:input}))});
});
operationsRouter.get('/responders',async(_req,res)=>{
 res.json({data:assertDb(await db().from('user_roles').select('user_id,profiles!user_roles_user_id_fkey(full_name)').eq('role_name','super_administrator').limit(100))});
});
operationsRouter.post('/accounts/:id/access',requireRecentMfa,async(req,res)=>{
 const input=z.object({action:z.enum(['suspend','reinstate','revoke_sessions']),reason:z.string().trim().min(10).max(2000)}).strict().parse(req.body);
 res.json({data:assertDb(await db().rpc('change_account_access',{p_actor_id:req.actor!.id,p_user_id:uuid.parse(req.params.id),p_action:input.action,p_reason:input.reason}))});
});
operationsRouter.post('/signals/:id/review',async(req,res)=>{
 const input=z.object({status:z.enum(['open','acknowledged','resolved']),assigned_to:uuid.nullable(),notes:z.string().trim().min(10).max(2000)}).strict().parse(req.body);
 res.json({data:assertDb(await db().rpc('review_operations_signal',{p_actor_id:req.actor!.id,p_id:uuid.parse(req.params.id),p_status:input.status,p_assignee:input.assigned_to,p_notes:input.notes}))});
});
const lists={incidents:'operations_incidents',signals:'operations_signals',jobs:'operations_jobs',requests:'operations_requests',telemetry:'operations_telemetry'} as const;
operationsRouter.get('/records/:kind',async(req,res)=>{
 const list=z.enum(['incidents','signals','jobs','requests','telemetry']).parse(req.params.kind);
 const {page,limit}=pagination.parse(req.query);
 const from=(page-1)*limit,to=from+limit-1;
 const order=list==='telemetry'?'bucket':list==='jobs'?'started_at':'created_at';
 let query=db().from(lists[list]).select(list==='requests'?publicRequestColumns:'*',{count:'exact'}).order(order,{ascending:false}).range(from,to);
 if(list==='telemetry')query=query.gte('bucket',new Date(Date.now()-86400000).toISOString());
 const result=await query;
 res.json({data:assertDb(result),meta:{page,limit,total:result.count}});
});
operationsRouter.get('/incidents/:id/timeline',async(req,res)=>{
 res.json({data:assertDb(await db().from('operations_incident_events').select('*').eq('incident_id',uuid.parse(req.params.id)).order('created_at').limit(200))});
});
const incidentInput=z.object({title:z.string().trim().min(5).max(200),severity:z.enum(['low','medium','high','critical']),service:z.enum(['api','database','auth','storage','stripe','maps','backups','deployment','other']),classification:z.enum(['availability','security','data_integrity','performance','change']),assigned_to:uuid.nullable(),notes:z.string().trim().min(10).max(5000)}).strict();
operationsRouter.post('/incidents',async(req,res)=>res.status(201).json({data:assertDb(await db().rpc('save_operations_incident',{p_actor_id:req.actor!.id,p_id:null,p_input:incidentInput.parse(req.body)}))}));
operationsRouter.patch('/incidents/:id',async(req,res)=>{
 const input=z.object({status:z.enum(['open','investigating','resolved']),assigned_to:uuid.nullable(),notes:z.string().trim().min(10).max(5000),resolution:z.string().max(5000).nullable(),postmortem:z.string().max(10000).nullable()}).strict().refine(v=>v.status!=='resolved'||(v.resolution?.trim().length || 0)>=10,'Resolution notes are required.').parse(req.body);
 res.json({data:assertDb(await db().rpc('save_operations_incident',{p_actor_id:req.actor!.id,p_id:uuid.parse(req.params.id),p_input:input}))});
});
operationsRouter.post('/jobs/run',requireRecentMfa,async(req,res)=>{
 const {kind}=z.object({kind:z.enum(['expire_order_reservations','expire_pet_reservations','retention'])}).strict().parse(req.body);
 res.json({data:assertDb(await db().rpc('run_operations_job',{p_kind:kind,p_actor_id:req.actor!.id}))});
});
operationsRouter.post('/requests',requireRecentMfa,async(req,res)=>{
 const input=z.object({idempotency_key:uuid,kind,target:z.enum(['staging','production']),reason:z.string().trim().min(10).max(2000),confirmation:z.string(),recovery_point_id:uuid.nullable(),pre_restore_backup_id:uuid.nullable(),release_ref:z.string().regex(/^[a-f0-9]{40}$/).nullable()}).strict().parse(req.body);
 if(!configuredWorkerKinds().includes(input.kind))throw new ApiError(503,'WORKER_UNCONFIGURED','A secure worker for this operation has not been configured. No job was started.');
 if(input.confirmation!==`PawsConnect ${input.target}`)throw new ApiError(400,'CONFIRMATION_REQUIRED','Type the exact target name to confirm.');
 if(['deployment','rollback'].includes(input.kind)&&!input.release_ref)throw new ApiError(400,'RELEASE_REQUIRED','A full immutable Git commit reference is required.');
 const result=assertDb(await db().rpc('record_operations_request',{p_actor_id:req.actor!.id,p_key:input.idempotency_key,p_kind:input.kind,p_target:input.target,p_reason:input.reason,p_recovery_point:input.recovery_point_id,p_pre_backup:input.pre_restore_backup_id,p_release_ref:input.release_ref}));
 res.status(201).json({data:withoutLease(result)});
});
operationsRouter.post('/requests/:id/decision',requireRecentMfa,async(req,res)=>{
 const input=z.object({approve:z.boolean(),notes:z.string().trim().min(10).max(2000)}).strict().parse(req.body);
 res.json({data:withoutLease(assertDb(await db().rpc('decide_operations_request',{p_actor_id:req.actor!.id,p_id:uuid.parse(req.params.id),p_approve:input.approve,p_notes:input.notes})))});
});
operationsRouter.get('/managed-backups',async(_req,res)=>{
 if(!env.SUPABASE_MANAGEMENT_TOKEN || !env.SUPABASE_PROJECT_REF){res.json({data:{configured:false,backups:[],note:'A project-scoped Management API token with backups_read is required. Database backups exclude Storage files.'}});return;}
 if(!/^[a-z0-9]+$/.test(env.SUPABASE_PROJECT_REF))throw new ApiError(503,'CONFIGURATION_ERROR','The configured project reference is invalid.');
 const response=await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/backups`,{headers:{Authorization:`Bearer ${env.SUPABASE_MANAGEMENT_TOKEN}`},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new ApiError(503,'BACKUP_PROVIDER_UNAVAILABLE','The backup provider did not return an authorized inventory.');
 const raw=z.object({pitr_enabled:z.boolean(),backups:z.array(z.object({id:z.number(),status:z.string(),inserted_at:z.string(),is_physical_backup:z.boolean()}))}).safeParse(await response.json());
 if(!raw.success)throw new ApiError(503,'BACKUP_PROVIDER_UNAVAILABLE','The backup provider returned an unexpected inventory format.');
 res.json({data:{configured:true,...raw.data,checked_at:new Date().toISOString(),note:'Provider inventory only. Restore integrity has not been tested by PawsConnect. Storage files are excluded.'}});
});

// Polling avoids network destinations controlled by a browser and survives serverless shutdown.
export const operationsWorkerRouter=Router();
operationsWorkerRouter.use(workerLimiter);
operationsWorkerRouter.use((req,_res,next)=>{
 const expected=env.OPERATIONS_WORKER_SECRET;
 const supplied=req.headers.authorization?.replace(/^Bearer /,'') || '';
 if(!expected || expected.length<32 || Buffer.byteLength(supplied)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new ApiError(401,'WORKER_AUTH_REQUIRED','Worker authentication required.');
 next();
});
operationsWorkerRouter.post('/claim',async(req,res)=>{
 z.object({}).strict().parse(req.body);
 const claimed=assertDb(await db().rpc('claim_operations_request',{p_kinds:configuredWorkerKinds()}));
 if(!claimed?.id){res.json({data:null});return;}
 const policy=await readOperationsConfig();
 const recoveryPoint=claimed.recovery_point_id?assertDb(await db().from('operations_requests').select(publicRequestColumns).eq('id',claimed.recovery_point_id).single()):null;
 res.json({data:{...claimed,recovery_point:recoveryPoint,policy:{retention_days:policy.retention_days,rpo_minutes:policy.rpo_minutes,rto_minutes:policy.rto_minutes}}});
});
const report=z.object({integrity_verified:z.boolean().optional(),database_covered:z.boolean().optional(),storage_covered:z.boolean().optional(),encrypted_offsite:z.boolean().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),artifact_ref:z.string().regex(/^[a-zA-Z0-9/_:.-]{1,300}$/).optional(),bytes:z.number().int().nonnegative().optional(),validation_passed:z.boolean().optional(),rpo_seconds:z.number().nonnegative().optional(),rto_seconds:z.number().nonnegative().optional(),release_ref:z.string().regex(/^[a-f0-9]{40}$/).optional()}).strict();
operationsWorkerRouter.post('/:id/complete',async(req,res)=>{
 const input=z.object({lease_token:uuid,succeeded:z.boolean(),report,failure_code:z.string().regex(/^[A-Z0-9_]{3,80}$/).nullable()}).strict().parse(req.body);
 res.json({data:withoutLease(assertDb(await db().rpc('complete_operations_request',{p_id:uuid.parse(req.params.id),p_lease:input.lease_token,p_succeeded:input.succeeded,p_report:input.report,p_failure:input.failure_code})))});
});
