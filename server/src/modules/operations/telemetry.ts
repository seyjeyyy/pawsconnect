import type { RequestHandler } from 'express';
import { waitUntil } from '@vercel/functions';
import { configured } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { serviceForPath } from './maintenance.js';

// The response is sent first; the write is handed to the platform so a serverless
// instance stays alive until it finishes. No caller waits on telemetry.
// Only fixed service names and numbers leave the request. No raw messages or URLs.
export const telemetry: RequestHandler = (req,res,next) => {
 if (!configured || !req.path.startsWith('/api/') || req.path.startsWith('/api/operations')) { next(); return; }
 const started=performance.now();
 const end=res.end.bind(res);
 let ending=false;
 res.end = ((...args: Parameters<typeof res.end>) => {
  if(ending) return res;
  ending=true;
  const duration=Math.round(performance.now()-started);
  const record=async()=> {
   try {
    const result=await db().rpc('record_operations_telemetry',{p_service:serviceForPath(req.originalUrl.split('?')[0],req.body?.resource_type),p_status:Math.min(5,Math.max(2,Math.floor(res.statusCode/100))),p_duration:duration,p_slow:duration>=(res.locals.slowRequestMs||2000)}).abortSignal(AbortSignal.timeout(1500));
    if(result.error) console.error('Telemetry persistence failed:',result.error.code);
   } catch { console.error('Telemetry persistence unavailable'); }
  };
  waitUntil(record());
  return end(...args);
 }) as typeof res.end;
 next();
};
