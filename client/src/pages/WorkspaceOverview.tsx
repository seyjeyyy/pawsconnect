import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardList, Heart, Package, PawPrint, ShieldCheck, Truck, Users, type LucideIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
const FinancialOverview=lazy(()=>import('./FinancialOverview'));
// Counts returned by workspace_overview, in display order. The database only returns
// the ones this account's module permissions cover.
const metrics:Record<string,{label:string;hint:string;to:string;icon:LucideIcon}>={
 animals_in_care:{label:'Animals in care',hint:'Open animal records',to:'pets',icon:PawPrint},
 pending_adoptions:{label:'Adoption applications to review',hint:'Review applications',to:'adoptions',icon:Heart},
 active_rescues:{label:'Active rescue cases',hint:'Coordinate rescues',to:'rescue',icon:ShieldCheck},
 transport_to_review:{label:'Transport requests to review',hint:'Review requests',to:'transport',icon:Truck},
 orders_to_process:{label:'Orders to process',hint:'Process orders',to:'orders',icon:Package},
 volunteer_applications:{label:'Volunteer applications',hint:'Review volunteers',to:'volunteers',icon:Users},
};
const Skeleton=()=> <div className="stat-grid" role="status" aria-label="Loading overview">{Array.from({length:4},(_,i)=><div className="card stat-card stat-skeleton" key={i}/>)}</div>;
export default function WorkspaceOverview(){
 const {permissions}=useAuth();
 const [reportOpen,setReportOpen]=useState(false);
 const query=useQuery({queryKey:['admin','overview'],queryFn:({signal})=>api<Record<string,number>>('/admin/overview',{signal})});
 const counts=Object.entries(query.data ?? {});
 return <>
  <p className="muted">Work waiting in the modules assigned to you. Select a figure to open its records.</p>
  {query.isPending?<Skeleton/>:query.error?<div className="notice error" role="alert">{query.error.message} <button className="text-button" onClick={()=>void query.refetch()}>Retry overview</button></div>:
   counts.length?<div className="stat-grid">{counts.map(([key,value])=>{const metric=metrics[key];const Icon=metric?.icon??ClipboardList;const body=<><span><Icon size={16}/>{metric?.label??key.replaceAll('_',' ')}</span><strong>{value.toLocaleString()}</strong>{metric&&<small>{metric.hint}<ArrowRight size={13}/></small>}</>;return metric?<Link className="card stat-card" key={key} to={`/admin/${metric.to}`}>{body}</Link>:<div className="card stat-card" key={key}>{body}</div>;})}</div>:
   <div className="card empty-state"><ClipboardList size={30}/><h3>No summary figures for your modules.</h3><p>Use the menu to open the records you are assigned to.</p></div>}
  {permissions.includes('finance.manage') && <details className="card overview-report" onToggle={event=>setReportOpen(event.currentTarget.open)}><summary>Financial reporting <span className="muted small">verified live payments only</span></summary>{reportOpen&&<Suspense fallback={<Skeleton/>}><FinancialOverview/></Suspense>}</details>}
 </>;
}
