import {useDebouncedValue} from '../lib/useDebouncedValue';
import {useConfirmation} from './Confirm';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { PrivateFile } from './UploadField';

type Row = Record<string, any>;
type Action = (path: string, method: string, body?: unknown) => Promise<void>;
export function Lookup({ kind, name, label, value }: { kind: string; name: string; label: string; value?: string }) {
  const [search, setSearch] = useState('');
  const settledSearch=useDebouncedValue(search);
  const query = useQuery({ queryKey: ['lookup', kind, settledSearch], queryFn: ({signal}) => api<{ id: string; name: string }[]>(`/admin/lookups/${kind}?q=${encodeURIComponent(settledSearch)}`,{signal}) });
  return <label className="field">{label}<input type="search" aria-label={`Search ${label}`} placeholder="Search by name" value={search} onChange={e => setSearch(e.target.value)} />
    <select name={name} required defaultValue={value || ''} disabled={query.isPending || !!query.error}><option value="">Choose a record</option>{query.data?.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
    {query.isPending && <span>Loading…</span>}{query.error && <span role="alert">{query.error.message}<button type="button" onClick={() => void query.refetch()}>Retry</button></span>}
    {query.data?.length === 0 && <span>No eligible records found.</span>}
  </label>;
}
export function Attachments({ row }: { row: Row }) {
  return <>{(row.document_paths || []).map((path: string) => <PrivateFile key={path} bucket="adoption-documents" path={path} />)}{(row.stray_report_photos || []).map((photo: Row) => <PrivateFile key={photo.id} bucket="rescue-evidence" path={photo.storage_path} />)}</>;
}
export function AdminRecordActions({ resource, row, busy, onAction }: { resource: string; row: Row; busy: boolean; onAction: Action }) {
  const confirm=useConfirmation();
  const { roles,permissions } = useAuth();
  const staff = roles.some(role => ['administrator','super_administrator','shelter_staff'].includes(role));
  const id = row.id || row.user_id;
  const submit = (path: string, method = 'POST', transform: (data: Row) => Row = d => d) => async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const body = transform(Object.fromEntries(new FormData(event.currentTarget)));
    if (!(await confirm({title:'Save this change?',resource:String(id)})).confirmed) return;
    await onAction(path, method, body);
  };
  return <div className="admin-workflow"><Attachments row={row} />
    {roles.includes('super_administrator') && resource==='users' && <form className="workflow-form" onSubmit={submit(`/admin/operations/accounts/${id}/access`)}><h3>Account protection</h3><p className="small muted">Suspension blocks PawsConnect API and direct database access. Revocation invalidates existing platform sessions and requires a new sign-in. Elevated role holders must first go through independent access removal.</p><label className="field">Action<select name="action"><option value="revoke_sessions">Revoke existing sessions</option><option value="suspend">Suspend platform access</option><option value="reinstate">Reinstate access (new sign-in required)</option></select></label><label className="field">Reason<textarea name="reason" required minLength={10} maxLength={2000}/></label><button className="btn btn-secondary" disabled={busy}>Review account protection</button></form>}
    {staff && resource === 'adoptions' && <form className="workflow-form" onSubmit={submit(`/admin/adoptions/${id}/appointments`, 'POST', d => ({ ...d, scheduled_at: new Date(d.scheduled_at).toISOString() }))}><h3>Schedule an interview</h3><label className="field">Date and time<input name="scheduled_at" type="datetime-local" required /></label><label className="field">Meeting location<input name="location" required minLength={5} /></label><label className="field">Notes<textarea name="notes" /></label><button className="btn btn-primary" disabled={busy}>Schedule appointment</button></form>}
    {staff && resource === 'rescue' && <form className="workflow-form" onSubmit={submit(`/admin/rescue/${id}/assign`)}><h3>Assign a rescuer</h3><Lookup kind="rescuers" name="assignee_id" label="Authorized rescuer" /><label className="field">Assignment notes<textarea name="notes" /></label><button className="btn btn-primary" disabled={busy || row.status !== 'verified'}>Assign verified report</button></form>}
    {resource === 'pets' && permissions.some(p=>['animals.health','animals.manage'].includes(p)) && <form className="workflow-form" onSubmit={submit(`/admin/pets/${id}/behavior`, 'PATCH', d => {
      const result: Row = { temperament: String(d.temperament || '').split(',').map(x => x.trim()).filter(Boolean), suitable_homes: d.suitable_homes ? String(d.suitable_homes).split(',') : [], notes: d.notes };
      for (const key of ['energy_level','care_hours_daily','max_hours_alone','experience_required','grooming_level','exercise_minutes']) result[key] = d[key] === '' ? null : Number(d[key]);
      for (const key of ['good_with_children','good_with_dogs','good_with_cats','needs_outdoor_space']) result[key] = d[key] === '' ? null : d[key] === 'true';
      return result;
    })}><h3>Record a verified behaviour assessment</h3><p className="small muted">Leave unassessed factors blank. Scores use only recorded observations.</p>
      {['energy_level','care_hours_daily','max_hours_alone','experience_required','grooming_level','exercise_minutes'].map(key => <label className="field" key={key}>{key.replaceAll('_',' ')}<input name={key} type="number" min="0" step="0.1" defaultValue={row.pet_behavior_profiles?.[key] ?? ''} /></label>)}
      {['good_with_children','good_with_dogs','good_with_cats','needs_outdoor_space'].map(key => <label className="field" key={key}>{key.replaceAll('_',' ')}<select name={key} defaultValue={String(row.pet_behavior_profiles?.[key] ?? '')}><option value="">Not assessed</option><option value="true">Yes</option><option value="false">No</option></select></label>)}
      <label className="field">Suitable homes<select name="suitable_homes" defaultValue={row.pet_behavior_profiles?.suitable_homes?.join(',') || ''}><option value="">Not assessed</option><option value="house">House</option><option value="apartment">Apartment</option><option value="apartment,house">Apartment and house</option></select></label>
      <label className="field">Observed temperament (comma separated)<input name="temperament" defaultValue={row.pet_behavior_profiles?.temperament?.join(', ') || ''} /></label><label className="field">Assessment notes<textarea name="notes" defaultValue={row.pet_behavior_profiles?.notes || ''} /></label><button className="btn btn-primary" disabled={busy}>Save verified assessment</button></form>}
    {staff && resource === 'volunteers' && <form className="workflow-form" onSubmit={submit(`/admin/volunteers/${id}/tasks`, 'POST', d => ({ ...d, scheduled_at: d.scheduled_at ? new Date(d.scheduled_at).toISOString() : undefined }))}><h3>Assign a volunteer task</h3><label className="field">Title<input name="title" required minLength={3} /></label><label className="field">Description<textarea name="description" /></label><label className="field">Schedule<input name="scheduled_at" type="datetime-local" /></label><button className="btn btn-primary" disabled={busy || row.status !== 'approved'}>Assign task</button></form>}
    {staff && resource === 'contact_messages' && <form className="workflow-form" onSubmit={submit(`/admin/contact_messages/${id}/reply`)}><h3>Reply to inquiry</h3>{!row.user_id && <p>This anonymous inquiry has no account inbox. Saving a reply does not send email.</p>}<label className="field">Reply<textarea name="reply" minLength={5} required /></label><button className="btn btn-primary" disabled={busy}>Save reply</button></form>}
    {staff && resource === 'reviews' && <form className="workflow-form" onSubmit={submit(`/admin/reviews/${id}/approval`, 'PATCH', d => ({ is_approved: d.is_approved === 'true' }))}><h3>Review publication</h3><label className="field">Publication<select name="is_approved"><option value="true">Approve</option><option value="false">Unpublish</option></select></label><button className="btn btn-primary" disabled={busy}>Save review decision</button></form>}
    {resource === 'security_alerts' && row.status === 'open' && <form className="workflow-form" onSubmit={submit(`/admin/security_alerts/${id}/resolve`)}><h3>Resolve alert</h3><label className="field">Investigation outcome<textarea name="notes" minLength={10} required /></label><button className="btn btn-primary" disabled={busy}>Resolve recorded alert</button></form>}
    {resource === 'critical_approvals' && row.status === 'pending' && <form className="workflow-form" onSubmit={submit(`/admin/critical_approvals/${id}/decision`, 'POST', d => ({ approve: d.approve === 'true' }))}><h3>Critical access decision</h3><p>A different super administrator must review this request.</p><label className="field">Decision<select name="approve"><option value="false">Reject</option><option value="true">Approve</option></select></label><button className="btn btn-primary" disabled={busy}>Record decision</button></form>}
    {resource === 'users' && <form className="workflow-form" onSubmit={submit('/admin/critical_approvals','POST',d => ({ ...d, user_id: id, enabled: d.enabled === 'true' }))}><h3>Request elevated access change</h3><label className="field">Role<select name="role_name"><option value="administrator">Administrator</option><option value="super_administrator">Super administrator</option></select></label><label className="field">Change<select name="enabled"><option value="true">Grant</option><option value="false">Revoke</option></select></label><label className="field">Reason<textarea name="reason" required minLength={10} /></label><button className="btn btn-primary" disabled={busy}>Submit for independent review</button></form>}
    {resource === 'refunds' && <p className="notice">This request remains pending until staff process it with the payment provider and reconcile its verified outcome. Saving a request does not issue a refund.</p>}
  </div>;
}
export function SecuritySummary() {
  const query = useQuery({ queryKey: ['admin','security-summary'], queryFn: ({signal}) => api<Row>('/admin/security-summary',{signal}) });
  if (query.isPending) return <p role="status">Loading recorded security events…</p>;
  if (query.error) return <div role="alert">{query.error.message}<button onClick={() => void query.refetch()}>Retry</button></div>;
  return <><p>{query.data.source_note}</p><div className="stat-grid">{Object.entries(query.data).filter(([, value]) => typeof value === 'number').map(([key, value]) => <div className="card stat-card" key={key}><span>{key.replaceAll('_',' ')}</span><strong>{value}</strong></div>)}</div></>;
}
