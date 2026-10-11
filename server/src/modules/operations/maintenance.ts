import type { RequestHandler } from 'express';
import { configured } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { ApiError, assertDb } from '../../utils/errors.js';

export type OperationsConfig = {
 version: number; mode: 'normal'|'read_only'|'partial'|'full'|'lockdown'; modules: string[];
 starts_at: string|null; ends_at: string|null; public_notice: string; disabled_features: string[];
 slow_request_ms: number; [key: string]: unknown;
};
export const serviceForPath = (path: string, resourceType?: unknown) => {
 const section = path.replace(/^\/api\//, '').replace(/^\//,'').replace(/^admin\//, '').split('/')[0];
 if(section==='payments') {
  if(resourceType==='donation')return 'donations';
  if(resourceType==='transport')return 'transport';
  if(resourceType==='adoption')return 'adoption';
 }
 if (['products','categories','cart','orders','wishlist','reviews','inventory','payments','shipments'].includes(section)) return 'shop';
 if (['pets','adoption-applications','adoptions','matchmaking','favorite-pets','health','intake'].includes(section)) return 'adoption';
 if (['stray-reports','rescue'].includes(section)) return 'rescue';
 if (['transport','alternatives','vehicles','drivers'].includes(section)) return 'transport';
 if (['donations','volunteers'].includes(section)) return section;
 if (['uploads','files'].includes(section)) return 'uploads';
 if (path.includes('/webhooks/')) return 'webhooks';
 return 'account';
};
export function effectiveMaintenance(config: OperationsConfig, now = Date.now()) {
 return config.mode !== 'normal' && !!config.starts_at && !!config.ends_at && Date.parse(config.starts_at)<=now && Date.parse(config.ends_at)>now;
}
export function maintenanceBlocks(config: OperationsConfig, method: string, path: string, now = Date.now(), resourceType?: unknown) {
 // Auth, system recovery and signature-verified payment settlement remain reachable.
 if (/^\/(?:api\/)?(?:health(?:\/|$)|operations(?:\/|$)|auth(?:\/|$)|admin\/operations(?:\/|$)|webhooks(?:\/|$))/.test(path)) return false;
 const write = !['GET','HEAD','OPTIONS'].includes(method);
 const service = serviceForPath(path, resourceType);
 if (write && config.disabled_features.includes(service)) return true;
 if (!effectiveMaintenance(config, now)) return false;
 if (config.mode === 'read_only') return write;
 if (config.mode === 'partial') return config.modules.includes(service);
 return true;
}
export async function readOperationsConfig() {
 return assertDb<OperationsConfig>(await db().from('operations_config').select('*').eq('id',true).single());
}
export const maintenanceGuard: RequestHandler = async (req,res,next) => {
 if (!configured || /^\/(health(?:\/|$)|auth(?:\/|$)|operations(?:\/|$)|admin\/operations(?:\/|$))/.test(req.path)) { next(); return; }
 // Read on every request: a new lockdown must not wait for a process-local cache.
 const config = await readOperationsConfig();
 res.locals.slowRequestMs=config.slow_request_ms;
 if (maintenanceBlocks(config,req.method,req.path,Date.now(),req.body?.resource_type)) {
  res.set('Retry-After','60');
  throw new ApiError(503,'MAINTENANCE',config.public_notice || 'This service is temporarily paused for maintenance. Please try again later.');
 }
 next();
};
