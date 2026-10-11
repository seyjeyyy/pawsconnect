import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Compass, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { tourFor, type Step } from './steps';
import './tour.css';

type Progress={step:number;status:'paused'|'completed'|'dismissed';updated_at?:string};
type Box={top:number;left:number;width:number;height:number};
const Context=createContext<{active:boolean;start:(resume?:boolean)=>void;progress:Progress|null;dismiss:()=>void;ready:boolean}|null>(null);
export function useTour(){const value=useContext(Context);if(!value)throw new Error('TourProvider missing');return value;}
const read=(key:string):Progress|null=>{try{const raw=JSON.parse(localStorage.getItem(key)||'null');return raw&&Number.isInteger(raw.step)&&['paused','completed','dismissed'].includes(raw.status)?raw:null;}catch{return null;}};
const visible=(element:Element)=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
const findTarget=(step:Step)=>{for(const selector of step.targets||[]){const found=[...document.querySelectorAll(selector)].find(visible);if(found)return found;}return null;};

export function TourProvider({children}:{children:ReactNode}){
 const {user,roles,rolesLoading,loading}=useAuth(),navigate=useNavigate(),{pathname}=useLocation(),cache=useQueryClient();
 const rolesKey=[...roles].sort().join(',');
 const sequence=useMemo(()=>tourFor(rolesKey.split(',')),[rolesKey]);
 const storageKey=`pawsconnect-tour-${user?.id||'guest'}-${sequence.key}`;
 const [progress,setProgress]=useState<Progress|null>(null),[ready,setReady]=useState(false),[index,setIndex]=useState<number|null>(null);
 const [box,setBox]=useState<Box|null>(null),[searching,setSearching]=useState(false),[unavailable,setUnavailable]=useState(false),[gliding,setGliding]=useState(false);
 const [viewport,setViewport]=useState({width:window.innerWidth,height:window.innerHeight,top:0,left:0});
 const [cardSize,setCardSize]=useState({width:380,height:300});
 const card=useRef<HTMLDivElement>(null),returnFocus=useRef<HTMLElement|null>(null),pendingRoute=useRef<string|null>(null),saveQueue=useRef(Promise.resolve());
 const active=index!==null,step=active?sequence.steps[index]:null;
 const persist=useCallback((value:Progress)=>{
  const snapshot={...value,updated_at:new Date().toISOString()};setProgress(snapshot);try{localStorage.setItem(storageKey,JSON.stringify(snapshot));}catch{/* local storage is optional */}
  if(user)saveQueue.current=saveQueue.current.catch(()=>{}).then(async()=>{await api(`/operations/tour/${sequence.key}`,{method:'PUT',body:JSON.stringify(value)});}).catch(()=>{/* local progress remains usable; no false server success */});
 },[storageKey,user?.id,sequence.key]);
 useEffect(()=>{
  setIndex(null);setBox(null);setProgress(read(storageKey));setReady(!user);let disposed=false;
  if(user)void api<Progress|null>(`/operations/tour/${sequence.key}`).then(value=>{if(!disposed&&value&&Date.parse(value.updated_at||'')>(Date.parse(read(storageKey)?.updated_at||'')||0))setProgress(value);}).catch(()=>{}).finally(()=>{if(!disposed)setReady(true);});
  return()=>{disposed=true;};
 },[storageKey,user?.id,sequence.key]);
 const close=useCallback(()=>{if(index!==null)persist({step:index,status:'paused'});setIndex(null);setBox(null);pendingRoute.current=null;requestAnimationFrame(()=>{if(returnFocus.current?.isConnected)returnFocus.current.focus({preventScroll:true});else document.querySelector<HTMLElement>('main')?.focus({preventScroll:true});});},[index,persist]);
 const select=useCallback((next:number)=>{
  const target=sequence.steps[next];if(!target)return;
  setSearching(!!target.targets);setUnavailable(false);setGliding(true);setIndex(next);
  if(pathname!==target.route){pendingRoute.current=target.route;navigate(target.route);}
  persist({step:next,status:'paused'});
 },[sequence.steps,pathname,navigate,persist]);
 const start=useCallback((resume=false)=>{returnFocus.current=document.activeElement as HTMLElement;setBox(null);select(resume&&progress?.status==='paused'?Math.min(progress.step,sequence.steps.length-1):0);},[select,progress,sequence.steps.length]);
 const go=useCallback((delta:number)=>{
  if(index===null)return;const next=index+delta;
  if(next>=sequence.steps.length){persist({step:index,status:'completed'});setIndex(null);setBox(null);requestAnimationFrame(()=>returnFocus.current?.isConnected&&returnFocus.current.focus({preventScroll:true}));}
  else select(Math.max(0,next));
 },[index,select,sequence.steps.length,persist]);
 useEffect(()=>{
  if(!step)return;
  if(pathname===step.route){pendingRoute.current=null;return;}
  if(!pendingRoute.current){close();return;}
  const timeout=window.setTimeout(()=>{setBox(null);setSearching(false);setUnavailable(true);pendingRoute.current=null;},5000);
  return()=>window.clearTimeout(timeout);
 },[pathname,step,close]);

 useEffect(()=>{
  if(!step || pathname!==step.route)return;
  let frame=0,target:Element|null=null,scrolled=false,settle=0,timeout=0,stopped=false,scrolling=false;
  let resizing:ResizeObserver|null=null;
  const view=()=>{const vv=window.visualViewport;setViewport({width:vv?.width||window.innerWidth,height:vv?.height||window.innerHeight,top:vv?.offsetTop||0,left:vv?.offsetLeft||0});};
  const measure=()=>{
   frame=0;if(stopped)return;view();
   if(!step.targets){setBox(null);setSearching(false);return;}
   const found=findTarget(step);if(!found){if(target){target=null;setBox(null);setUnavailable(true);setSearching(false);}return;}
   if(target!==found){resizing?.disconnect();target=found;resizing=new ResizeObserver(schedule);resizing.observe(found);}
   const r=found.getBoundingClientRect(),header=document.querySelector('.site-header')?.getBoundingClientRect();
   const topLimit=header?Math.max(12,header.bottom+12):12;
   if(!scrolled){scrolled=true;if(r.top<topLimit || r.bottom>window.innerHeight-16){
    const calm=matchMedia('(prefers-reduced-motion: reduce)').matches;scrolling=!calm;
    found.scrollIntoView({behavior:calm?'instant':'smooth',block:'center',inline:'nearest'});
    settle=window.setTimeout(()=>{scrolling=false;schedule();},calm?0:120);return;
   }}
   if(scrolling)return;
   const top=Math.max(8,r.top-8),left=Math.max(8,r.left-8),right=Math.min(window.innerWidth-8,r.right+8),bottom=Math.min(window.innerHeight-8,r.bottom+8);
   if(right<=left || bottom<=top){setBox(null);setSearching(false);setUnavailable(true);return;}
   setBox(previous=>previous&&Math.abs(previous.top-top)<.5&&Math.abs(previous.left-left)<.5&&Math.abs(previous.width-(right-left))<.5&&Math.abs(previous.height-(bottom-top))<.5?previous:{top,left,width:right-left,height:bottom-top});
   setSearching(false);setUnavailable(false);window.clearTimeout(timeout);
  };
  function schedule(){if(!frame)frame=requestAnimationFrame(measure);}
  const scroll=()=>{setGliding(false);window.clearTimeout(settle);settle=window.setTimeout(()=>{scrolling=false;schedule();},100);if(!scrolling)schedule();};
  const observer=new MutationObserver(schedule);
  const page=document.getElementById('tour-page');if(page)observer.observe(page,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-expanded']});
  const unsubscribe=cache.getQueryCache().subscribe(schedule);
  window.addEventListener('resize',schedule);window.addEventListener('scroll',scroll,true);window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
  timeout=window.setTimeout(()=>{scrolling=false;if(!target){setBox(null);setSearching(false);setUnavailable(true);}else schedule();},5000);
  const transition=window.setTimeout(()=>setGliding(false),280);
  schedule();
  return()=>{stopped=true;cancelAnimationFrame(frame);clearTimeout(settle);clearTimeout(timeout);clearTimeout(transition);observer.disconnect();resizing?.disconnect();unsubscribe();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',scroll,true);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);};
 },[step,pathname,cache]);
 useLayoutEffect(()=>{if(!card.current)return;const observer=new ResizeObserver(()=>{const r=card.current?.getBoundingClientRect();if(r)setCardSize({width:r.width,height:r.height});});observer.observe(card.current);return()=>observer.disconnect();},[active]);
 useEffect(()=>{
  if(!active)return;
  card.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus({preventScroll:true});
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();close();}
   else if(event.key==='ArrowRight'&&!searching){event.preventDefault();go(1);}
   else if(event.key==='ArrowLeft'&&!searching){event.preventDefault();go(-1);}
   else if(event.key==='Tab'&&card.current){const items=[...card.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')];const first=items[0],last=items.at(-1);if(!card.current.contains(document.activeElement)){event.preventDefault();first?.focus();}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[active,index,searching,close,go]);
 const dismiss=()=>persist({step:0,status:'dismissed'});
 let overlay:ReactNode=null;
 if(step&&index!==null){
  const margin=16,gap=16,w=viewport.width,h=viewport.height;
  let left=(w-cardSize.width)/2,top=(h-cardSize.height)/2;
  if(box&&!searching){const below=box.top+box.height+gap,above=box.top-gap-cardSize.height;top=below+cardSize.height<=h-margin?below:above>=margin?above:h-cardSize.height-margin;left=box.left+box.width/2-cardSize.width/2;}
  left=viewport.left+Math.max(margin,Math.min(left,w-cardSize.width-margin));top=viewport.top+Math.max(margin,Math.min(top,h-cardSize.height-margin));
  const Icon=step.icon;
  overlay=createPortal(<div className={`tour${gliding?' tour-gliding':''}`}><div className={`tour-backdrop${box?'':' tour-backdrop-dim'}`} aria-hidden="true"/>{box&&<div className="tour-spotlight" aria-hidden="true" style={box}/>}<div ref={card} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" style={{left,top,maxHeight:h-32,width:Math.min(380,w-32)}}><div className="tour-progress" role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={sequence.steps.length} aria-valuenow={index+1}><span style={{width:`${(index+1)/sequence.steps.length*100}%`}}/></div><div className="tour-content"><div className="tour-head"><span className="tour-icon"><Icon size={20}/></span><span className="tour-count">Step {index+1} of {sequence.steps.length}</span><button className="tour-close" onClick={close} aria-label="Close the tour"><X size={18}/></button></div><div aria-live="polite"><h2 id="tour-title">{step.title}</h2><p id="tour-body">{step.body}</p>{searching&&<p className="tour-hint" role="status">Finding this part of the page…</p>}{unavailable&&<p className="tour-hint">This feature isn’t visible here. You can continue or pause the tour.</p>}</div></div><div className="tour-actions"><button className="btn btn-secondary" disabled={index===0||searching} onClick={()=>go(-1)}><ArrowLeft size={16}/>Back</button><button className="btn btn-primary" data-tour-primary onClick={()=>go(1)} disabled={searching}>{index===sequence.steps.length-1?'Finish':'Next'}<ArrowRight size={16}/></button></div><button className="tour-pause text-button" onClick={close}>Pause tour</button></div></div>,document.body);
 }
 return <Context.Provider value={{active,start,progress,dismiss,ready:ready&&!loading&&!rolesLoading}}><div id="tour-page" inert={active||undefined} style={{display:'contents'}}>{children}</div>{overlay}</Context.Provider>;
}
export function TourButton({className='tour-link',children='Take the tour'}:{className?:string;children?:ReactNode}){const {start,progress,ready}=useTour();return <button type="button" className={className} onClick={()=>start(progress?.status==='paused')} disabled={!ready}><Compass size={14}/>{progress?.status==='paused'?'Resume tour':children}</button>;}
export function RestartTourButton(){const {start,ready}=useTour();return <button className="btn btn-secondary" disabled={!ready} onClick={()=>start(false)}><Compass size={16}/>Restart tour</button>;}
export function TourInvitation(){const {active,start,progress,dismiss,ready}=useTour();const {pathname}=useLocation();if(!ready||progress||active||!['/','/admin/security','/admin/overview','/account'].includes(pathname))return null;return <aside className="tour-invite" aria-label="Site tour invitation"><span className="tour-icon"><Compass size={20}/></span><div><strong>Find your way around</strong><p>A short tour of the tools available to you.</p><div className="tour-invite-actions"><button className="btn btn-primary" onClick={()=>start()}>Show me around</button><button className="text-button" onClick={dismiss}>Not now</button></div></div><button className="tour-close" onClick={dismiss} aria-label="Dismiss the tour invitation"><X size={16}/></button></aside>;}
