import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export function useMfa() {
 const {user}=useAuth();
 return useQuery({queryKey:['mfa',user?.id],enabled:!!user&&!!supabase,queryFn:async()=>{
  const {data,error}=await supabase!.auth.mfa.getAuthenticatorAssuranceLevel();if(error)throw error;return data;
 },refetchInterval:60000});
}
export function MfaGate({children}:{children:ReactNode}) {
 const mfa=useMfa();
 if(mfa.isPending)return <div className="notice" role="status">Checking workspace verification…</div>;
 if(mfa.error)return <div className="notice error" role="alert">{mfa.error.message}<button onClick={()=>void mfa.refetch()}>Retry</button></div>;
 if(mfa.data?.currentLevel!=='aal2')return <section className="card service-form"><h2>Protect your workspace</h2><p>All workspace accounts must verify an authenticator code. Critical system changes require a code verified within ten minutes.</p><MfaSettings/><Link className="text-button" to="/account/settings">Account settings</Link></section>;
 return children;
}
export function MfaSettings() {
 const cache=useQueryClient();const [factor,setFactor]=useState(''),[qr,setQr]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
 useEffect(()=>{let active=true;void supabase?.auth.mfa.listFactors().then(({data,error})=>{if(!active)return;if(error)setError(error.message);else setFactor(data?.totp.find(f=>f.status==='verified')?.id || '');});return()=>{active=false;};},[]);
 async function enroll(){if(!supabase||busy)return;setBusy(true);setError('');try{
  // Reuse a verified factor. Only remove this browser's unfinished enrollment on retry.
  if(factor&&qr)await supabase.auth.mfa.unenroll({factorId:factor});
  const {data,error}=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:`PawsConnect ${new Date().toISOString()}`,issuer:'PawsConnect'});if(error)throw error;
  setFactor(data.id);setQr(data.totp.qr_code);
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function verify(event:React.FormEvent){event.preventDefault();if(!supabase||busy)return;setBusy(true);setError('');setSuccess('');try{
  const {error}=await supabase.auth.mfa.challengeAndVerify({factorId:factor,code});if(error)throw error;
  setQr('');setCode('');setSuccess('Authenticator verified. Your workspace session is ready.');await cache.invalidateQueries({queryKey:['mfa']});
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="mfa-settings"><h3>Two-step verification</h3><p className="muted">Use your authenticator app. Verification codes are never stored by PawsConnect.</p>{!factor?<button className="btn btn-secondary" disabled={busy} onClick={()=>void enroll()}>Set up authenticator</button>:<form onSubmit={verify} className="service-form">{qr&&<><img className="mfa-qr" src={qr} alt="Scan this QR code with your authenticator app"/><p>Scan the code, then enter the six-digit code from your app.</p></>}<label className="field">Authenticator code<input value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label><button className="btn btn-primary" disabled={busy}>{busy?'Verifying…':'Verify code'}</button></form>}{error&&<p className="notice error" role="alert">{error}</p>}{success&&<p className="notice success" role="status">{success}</p>}</div>;
}
