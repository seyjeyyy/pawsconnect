import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardList } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
const FinancialOverview=lazy(()=>import('./FinancialOverview'));
const modules=[['animals.view','pets','Animals in care'],['adoptions.review','adoptions','Review adoptions'],['rescue.manage','rescue','Coordinate rescues'],['transport.manage','transport','Manage transport'],['store.manage','orders','Process orders'],['volunteers.manage','volunteers','Volunteer applications']];
const Skeleton=()=> <div className="dashboard-skeleton" role="status" aria-label="Loading overview"><div/><div/><div/></div>;
export default function WorkspaceOverview(){
 const {permissions}=useAuth();
 const [reportOpen,setReportOpen]=useState(false);
 const query=useQuery({queryKey:['admin','overview'],queryFn:({signal})=>api<Record<string,number>>('/admin/overview',{signal})});
 return <>
  <p className="muted">Your assigned work, together in one place. Open a module to review records and take action.</p>
  {query.isPending?<Skeleton/>:query.error?<div className="notice error" role="alert">{query.error.message} <button className="text-button" onClick={()=>void query.refetch()}>Retry overview</button></div>:<div className="stat-grid">{Object.entries(query.data).map(([key,value])=><div className="card stat-card" key={key}><span>{key.replaceAll('_',' ')}</span><strong>{value.toLocaleString()}</strong></div>)}</div>}
  <section className="card"><h2><ClipboardList size={20}/> Work requiring attention</h2><div className="account-quick-links">{modules.filter(([p])=>permissions.includes(p)).map(([,path,label])=><Link className="btn btn-secondary" key={path} to={`/admin/${path}`}>{label}<ArrowRight size={16}/></Link>)}</div></section>
  {permissions.includes('finance.manage') && <details className="card" onToggle={event=>setReportOpen(event.currentTarget.open)}><summary>Financial reporting · verified live payments</summary>{reportOpen&&<Suspense fallback={<Skeleton/>}><FinancialOverview/></Suspense>}</details>}
 </>;
}
