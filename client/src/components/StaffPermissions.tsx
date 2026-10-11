import { useState } from 'react';
const choices=['animals.view','animals.manage','animals.health','adoptions.review','adoptions.decide','rescue.manage','transport.manage','store.manage','donations.view','donations.manage','finance.manage','volunteers.manage','reports.export','contacts.manage','zones.view','zones.manage','rescue.assigned','transport.assigned'];
export function StaffPermissions({userId,initial,busy,onSave}:{userId:string;initial:string[];busy:boolean;onSave:(path:string,method:string,body:unknown)=>Promise<void>}) {
 const [selected,setSelected]=useState(initial);
 return <form className="workflow-form" onSubmit={e=>{e.preventDefault();void onSave(`/admin/users/${userId}/permissions`,'PUT',{permissions:selected});}}>
  <h3>Staff module permissions</h3><p className="small muted">Choose the modules this staff member can use. Clearing every permission closes staff access while retaining their account and records. Elevated decisions still require independently approved authority.</p>
  <fieldset className="permission-grid"><legend>Authorized modules</legend>{choices.map(p=><label key={p}><input type="checkbox" checked={selected.includes(p)} onChange={e=>setSelected(e.target.checked?[...selected,p]:selected.filter(v=>v!==p))}/>{p.replaceAll('.',' · ')}</label>)}</fieldset>
  <button className="btn btn-primary" disabled={busy}>Save staff permissions</button>
 </form>;
}
