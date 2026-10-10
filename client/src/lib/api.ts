import { supabase } from './supabase';
export const money = (centavos: number | string = 0) => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(Number(centavos)/100);
export type Envelope<T>={data:T;meta?:{sample?:boolean;page?:number;limit?:number;total?:number}};
export class ApiError extends Error {constructor(message:string,public status:number,public code?:string){super(message);this.name='ApiError';}}
export async function apiEnvelope<T>(path:string,options:RequestInit={}):Promise<Envelope<T>> {
 const session=supabase ? (await supabase.auth.getSession()).data.session : null;
 const headers=new Headers(options.headers); if(options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
 if(session) headers.set('Authorization',`Bearer ${session.access_token}`);
 const response=await fetch(`${import.meta.env.VITE_API_URL || '/api'}${path}`,{...options,headers});
 const body=await response.json().catch(()=>null);
 if(!response.ok) throw new ApiError(body?.error?.message || 'The service is unavailable. Please try again.',response.status,body?.error?.code);
 if(!body || !('data' in body)) throw new ApiError('The service returned an unexpected response.',502);
 return body;
}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{return (await apiEnvelope<T>(path,options)).data;}
