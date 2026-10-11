import type { RequestHandler } from 'express';
import { db } from '../config/supabase.js';
import { ApiError } from '../utils/errors.js';

export const requireMfa: RequestHandler = async (req,_res,next) => {
 const token=/^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
 if(!req.actor || !token) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
 const {data,error}=await db().auth.mfa.getAuthenticatorAssuranceLevel(token);
 if(error || data?.currentLevel!=='aal2') throw new ApiError(403,'MFA_REQUIRED','Verify your authenticator in Account settings before opening the workspace.');
 next();
};
export const requireRecentMfa: RequestHandler = (req,_res,next) => {
 // This runs only AFTER authenticate and requireMfa validated this exact token.
 const token=req.headers.authorization!.split(' ')[1];
 let timestamp=0;
 try {
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
  const methods=Array.isArray(claims.amr)?claims.amr:[];
  timestamp=Math.max(0,...methods.filter((entry:{method?:string;timestamp?:unknown}|null)=>entry && ['totp','phone','webauthn'].includes(entry.method || '') && typeof entry.timestamp==='number' && Number.isFinite(entry.timestamp)).map((entry:{timestamp:number})=>entry.timestamp));
 } catch { /* invalid claims fail closed */ }
 if(timestamp<Date.now()/1000-600 || timestamp>Date.now()/1000+30) throw new ApiError(403,'MFA_REAUTH_REQUIRED','Verify a fresh authenticator code in Account settings. Critical actions require verification within ten minutes.');
 next();
};
