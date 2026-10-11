import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldCheck, X } from 'lucide-react';

type Options={title:string;description?:string;resource?:string;typed?:string;reason?:boolean;confirmLabel?:string};
type Answer={confirmed:boolean;reason:string};
const Context=createContext<(options:Options|string)=>Promise<Answer>>(async()=>({confirmed:false,reason:''}));
export const useConfirmation=()=>useContext(Context);
export function ConfirmationProvider({children}:{children:ReactNode}) {
 const [options,setOptions]=useState<Options|null>(null),[reason,setReason]=useState(''),[typed,setTyped]=useState('');
 const pending=useRef<((answer:Answer)=>void)|null>(null);
 const finish=(confirmed:boolean)=>{const resolve=pending.current;pending.current=null;setOptions(null);resolve?.({confirmed,reason});};
 useEffect(()=>()=>{pending.current?.({confirmed:false,reason:''});},[]);
 const confirm=(input:Options|string)=>new Promise<Answer>(resolve=>{
  if(pending.current){resolve({confirmed:false,reason:''});return;}
  pending.current=resolve;setReason('');setTyped('');setOptions(typeof input==='string'?{title:input}:input);
 });
 return <Context.Provider value={confirm}>{children}<Dialog.Root open={!!options} onOpenChange={open=>{if(!open)finish(false);}}><Dialog.Portal><Dialog.Overlay className="confirm-overlay"/><Dialog.Content className="confirm-dialog" aria-describedby="confirm-description"><div className="feature-toolbar"><ShieldCheck size={24}/><Dialog.Close className="icon-button" aria-label="Cancel confirmation"><X/></Dialog.Close></div><Dialog.Title>{options?.title}</Dialog.Title><Dialog.Description id="confirm-description">{options?.description || 'Review this change before continuing. It will be applied to the selected record.'}</Dialog.Description>{options?.resource&&<p className="confirmation-resource">{options.resource}</p>}<form onSubmit={event=>{event.preventDefault();finish(true);}}>{options?.reason&&<label className="field">Reason<textarea value={reason} onChange={e=>setReason(e.target.value)} required minLength={10} maxLength={2000}/></label>}{options?.typed&&<label className="field">Type “{options.typed}” to confirm<input value={typed} onChange={e=>setTyped(e.target.value)} required autoComplete="off"/></label>}<div className="form-actions"><button type="button" className="btn btn-secondary" onClick={()=>finish(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!!options?.typed&&typed!==options.typed || !!options?.reason&&reason.trim().length<10}>{options?.confirmLabel || 'Confirm change'}</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root></Context.Provider>;
}
