import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Download, Navigation, Search } from 'lucide-react';
import { api, apiEnvelope, money } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { ErrorState } from '../../components/common';
import { useConfirmation } from '../../components/Confirm';
import { Lookup } from '../../components/RecordActions';
import { recordStatuses } from '../../lib/recordStatuses';
import { coverageLabel, directionsUrl, StatusBadge, statusLabel, TransportDetail, when, type Booking } from './TransportDetail';
import './transport.css';

// The Transport section of the workspace. Staff see every booking, with filters, and work a
// booking from review to handover. A driver sees only the jobs assigned to them and moves a
// job through pickup, transit and delivery. Every change goes through the API, which checks
// the role and the allowed next step again.
type Job = { id: string; reference: string; status: string; coverage_status: string; pet_details: string; pet_name: string | null; pet_species: string | null; dropoff_address: string; dropoff_city: string | null; preferred_schedule: string; confirmed_schedule: string | null; route_distance_km: number | string | null; fee_centavos?: number | null; estimate_total_centavos?: number | null; driver_id: string | null };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the request. Please try again.';
const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
// Schedules are entered and shown in Philippine time, whatever the device's own time zone is.
const manilaInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16);
const manilaToIso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const pesosToCentavos = (text: string) => Math.round(Number(text) * 100);

export default function TransportWorkspace({ staff }: { staff: boolean }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('booking');
  const show = (id: string | null) => { const next = new URLSearchParams(params); if (id) next.set('booking', id); else next.delete('booking'); setParams(next); };
  return open ? <BookingScreen id={open} staff={staff} onBack={() => show(null)} /> : <BookingList staff={staff} onOpen={show} />;
}

function BookingList({ staff, onOpen }: { staff: boolean; onOpen: (id: string) => void }) {
  const { permissions } = useAuth();
  const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const [status, setStatus] = useState(''); const [coverage, setCoverage] = useState(''); const [date, setDate] = useState(''); const [direction, setDirection] = useState('desc');
  const [exporting, setExporting] = useState(false); const [error, setError] = useState('');
  const path = (extra = '') => `/admin/transport?page=${page}&limit=15&q=${encodeURIComponent(query)}&status=${status}${coverage ? `&coverage=${coverage}` : ''}${date ? `&date=${date}` : ''}&direction=${direction}${extra}`;
  const jobs = useQuery({ queryKey: ['admin', 'transport', 'list', page, query, status, coverage, date, direction], queryFn: ({ signal }) => apiEnvelope<Job[]>(path(), { signal }) });
  const rows = jobs.data?.data ?? []; const total = jobs.data?.meta?.total ?? 0;
  const filtered = Boolean(query || status || coverage || date);
  const change = (apply: () => void) => { apply(); setPage(1); };
  async function exportPage() {
    if (exporting) return; setExporting(true); setError('');
    try {
      const exported = await apiEnvelope<Job[]>(path('&export=true'));
      const columns: [string, (job: Job) => unknown][] = [['Reference', job => job.reference], ['Pet', job => job.pet_name ?? job.pet_details], ['Destination', job => job.dropoff_address], ['Preferred schedule', job => when(job.preferred_schedule)], ['Road km', job => job.route_distance_km ?? ''], ['Coverage', job => coverageLabel[job.coverage_status] ?? job.coverage_status], ['Status', job => statusLabel(job.status)], ['Final quote', job => job.fee_centavos === null || job.fee_centavos === undefined ? '' : money(job.fee_centavos)]];
      // A leading =, +, - or @ would be run as a formula by a spreadsheet.
      const safe = (value: unknown) => { const text = String(value ?? ''); return `"${/^[=+\-@\t\r]/.test(text) ? "'" : ''}${text.replaceAll('"', '""')}"`; };
      const csv = [columns.map(([label]) => label).join(','), ...exported.data.map(job => columns.map(([, value]) => safe(value(job))).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); const link = document.createElement('a'); link.href = url; link.download = `pawsconnect-transport-page-${page}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (failure) { setError(messageOf(failure)); } finally { setExporting(false); }
  }
  return <>
    <div className="feature-toolbar transport-filters">
      {staff && <form className="dashboard-search" onSubmit={event => { event.preventDefault(); change(() => setQuery(search)); }}><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Reference, pet or destination" aria-label="Search transport requests" /><button className="text-button" type="submit">Search</button></form>}
      <div className="table-actions">
        <label className="field">Status<select value={status} onChange={event => change(() => setStatus(event.target.value))}><option value="">All statuses</option>{recordStatuses.transport.map(option => <option key={option} value={option}>{statusLabel(option)}</option>)}</select></label>
        <label className="field">Date<input type="date" value={date} onChange={event => change(() => setDate(event.target.value))} aria-label="Preferred schedule date" /></label>
        {staff && <label className="field">Coverage<select value={coverage} onChange={event => change(() => setCoverage(event.target.value))}><option value="">All coverage</option>{Object.entries(coverageLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <label className="field">Sort<select value={direction} onChange={event => change(() => setDirection(event.target.value))}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
        {filtered && <button type="button" className="text-button" onClick={() => { setSearch(''); change(() => { setQuery(''); setStatus(''); setCoverage(''); setDate(''); }); }}>Clear filters</button>}
        {staff && <button type="button" className="btn btn-secondary" disabled={exporting || !rows.length || !permissions.includes('reports.export')} onClick={exportPage}><Download size={15} />Export</button>}
      </div>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {jobs.isLoading ? <div className="dashboard-skeleton" aria-label="Loading transport requests"><div /><div /><div /></div>
      : jobs.error ? <ErrorState error={jobs.error} retry={() => jobs.refetch()} />
      : rows.length === 0 ? <div className="card empty-state"><h3>{filtered ? 'No transport requests match these filters.' : staff ? 'No transport requests yet.' : 'No trips are assigned to you right now.'}</h3>{!staff && !filtered && <p>When shelter staff assign you a trip it appears here.</p>}</div>
      : <ul className="transport-jobs">{rows.map(job => <li key={job.id}><button type="button" className="card transport-job" onClick={() => onOpen(job.id)}>
        <span className="transport-job-head"><strong>{job.reference}</strong><StatusBadge status={job.status} /></span>
        <span className="transport-job-pet">{job.pet_name ? `${job.pet_name} · ${job.pet_species}` : job.pet_details}</span>
        <span className="transport-job-line"><span>To</span>{job.dropoff_address}</span>
        <span className="transport-job-line"><span>When</span>{when(job.confirmed_schedule ?? job.preferred_schedule)}{job.confirmed_schedule ? '' : ' (preferred)'}</span>
        <span className="transport-job-foot">{job.route_distance_km !== null && <span>{Number(job.route_distance_km)} km by road</span>}{staff && <span className={`badge transport-coverage-${job.coverage_status}`}>{coverageLabel[job.coverage_status] ?? job.coverage_status}</span>}{staff && job.fee_centavos !== null && job.fee_centavos !== undefined && <span>Quote {money(job.fee_centavos)}</span>}<span className="transport-job-open">Open <ArrowRight size={15} /></span></span>
      </button></li>)}</ul>}
    {total > 15 && <div className="table-actions transport-pages"><button type="button" className="btn btn-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} />Previous</button><span className="muted">Page {page} of {Math.ceil(total / 15)}</span><button type="button" className="btn btn-secondary" disabled={page * 15 >= total} onClick={() => setPage(page + 1)}>Next<ChevronRight size={16} /></button></div>}
  </>;
}

function BookingScreen({ id, staff, onBack }: { id: string; staff: boolean; onBack: () => void }) {
  const cache = useQueryClient(); const confirm = useConfirmation();
  const booking = useQuery({ queryKey: ['admin', 'transport', 'one', id], queryFn: ({ signal }) => api<Booking>(`/admin/transport/${id}`, { signal }) });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  async function run(path: string, method: string, body: unknown, done: string) {
    if (busy) return false; setBusy(true); setError(''); setSuccess('');
    try { await api(path, send(method, body)); await cache.invalidateQueries({ queryKey: ['admin', 'transport'] }, { cancelRefetch: false }); setSuccess(done); return true; }
    catch (failure) { setError(messageOf(failure)); return false; } finally { setBusy(false); }
  }
  async function move(status: string, question: string, done: string, reason = false) {
    const answer = await confirm({ title: question, resource: booking.data?.reference, reason, confirmLabel: 'Confirm' });
    if (answer.confirmed) await run(`/admin/transport/${id}/status`, 'PATCH', { status, ...(answer.reason.trim() ? { notes: answer.reason.trim() } : {}) }, done);
  }
  const back = <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={16} />{staff ? 'All transport requests' : 'My transport jobs'}</button>;
  if (booking.isLoading) return <>{back}<div className="dashboard-skeleton" aria-label="Loading the transport request"><div /><div /><div /></div></>;
  if (booking.error || !booking.data) return <>{back}<ErrorState error={booking.error} retry={() => booking.refetch()} /></>;
  const row = booking.data;
  const feedback = <>{error && <div className="notice error" role="alert">{error}</div>}{success && <div className="notice success" role="status"><Check size={17} />{success}</div>}</>;
  return <div className="transport-booking">
    {back}
    <div className="feature-toolbar"><h2>{row.reference}</h2><StatusBadge status={row.status} /></div>
    <div className="transport-booking-layout">
      <aside className="transport-actions">
        {feedback}
        {staff ? <StaffActions row={row} busy={busy} run={run} move={move} /> : <DriverActions row={row} busy={busy} move={move} />}
      </aside>
      <TransportDetail booking={row} view={staff ? 'staff' : 'driver'} />
    </div>
  </div>;
}

type Run = (path: string, method: string, body: unknown, done: string) => Promise<boolean>;
type Move = (status: string, question: string, done: string, reason?: boolean) => Promise<void>;

/** The driver's one next step, as a large button. "Delivered" records the status the system calls arrived; staff then confirm the handover. */
function DriverActions({ row, busy, move }: { row: Booking; busy: boolean; move: Move }) {
  const next = ({ scheduled: ['picked_up', 'Picked up', 'Confirm that you have picked the pet up from the shelter?', 'Marked as picked up.'], picked_up: ['in_transit', 'In transit', 'Confirm that you are on the way to the destination?', 'Marked as in transit.'], in_transit: ['arrived', 'Delivered', 'Confirm that you have arrived and delivered the pet?', 'Marked as delivered. Shelter staff will confirm the handover.'] } as Record<string, string[]>)[row.status];
  return <section className="card transport-driver">
    <h3>Your next step</h3>
    {next ? <button type="button" className="btn btn-primary transport-big" disabled={busy} onClick={() => move(next[0], next[2], next[3])}>{next[1]}</button>
      : <p className="muted">{row.status === 'arrived' ? 'Delivered. Shelter staff will confirm the handover with the recipient.' : row.status === 'completed' ? 'This trip is complete.' : 'There is nothing for you to update on this trip right now.'}</p>}
    <a className="btn btn-secondary transport-big" href={directionsUrl(row)} target="_blank" rel="noreferrer"><Navigation size={18} />Open in Google Maps</a>
    <ol className="transport-steps">{[['picked_up', 'Picked up'], ['in_transit', 'In transit'], ['arrived', 'Delivered']].map(([status, label]) => { const event = row.history.find(item => item.status === status); return <li key={status} className={event ? 'done' : ''}><span>{label}</span><time>{event ? when(event.created_at) : 'Not yet'}</time></li>; })}</ol>
  </section>;
}

function StaffActions({ row, busy, run, move }: { row: Booking; busy: boolean; run: Run; move: Move }) {
  const path = `/admin/transport/${row.id}`;
  const [amount, setAmount] = useState(''); const [note, setNote] = useState('');
  const canQuote = ['under_review', 'quoted'].includes(row.status), canAssign = ['confirmed', 'paid'].includes(row.status), canStop = ['submitted', 'under_review', 'quoted'].includes(row.status);
  const awaitingPayment = row.status === 'confirmed' && Number(row.fee_centavos) > 0 && !row.paid_at;
  async function quote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (await run(`${path}/quote`, 'POST', { amount_centavos: pesosToCentavos(amount), breakdown: row.estimate_breakdown ? { estimate_total_centavos: row.estimate_total_centavos } : {}, expires_at: manilaToIso(String(form.get('expires_at'))) }, 'Quotation sent to the customer.')) setAmount('');
  }
  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await run(`${path}/assignment`, 'PATCH', { driver_id: form.get('driver_id'), vehicle_id: form.get('vehicle_id'), confirmed_schedule: manilaToIso(String(form.get('confirmed_schedule'))) }, 'Driver and vehicle assigned; the trip is scheduled.');
  }
  async function handover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), target = event.currentTarget;
    if (await run(`${path}/handover`, 'POST', { recipient_name: form.get('recipient_name'), notes: form.get('notes') }, 'Handover recorded.')) target.reset();
  }
  async function addNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await run(`${path}/notes`, 'POST', { note: note.trim() }, 'Note added.')) setNote('');
  }
  return <>
    <section className="card transport-staff">
      <h3>Next step</h3>
      {row.status === 'submitted' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('under_review', 'Start reviewing this request?', 'Request is under review.')}>Start review</button>}
      {canQuote && <form className="workflow-form" onSubmit={quote}>
        <h4>{row.status === 'quoted' ? 'Send a revised quotation' : 'Final quote'}</h4>
        <p className="small muted">This is the price the customer is asked to accept.{row.estimate_total_centavos !== null && row.estimate_total_centavos !== undefined ? ` The estimate they were shown was ${money(row.estimate_total_centavos)}.` : ' No estimate was shown to them.'}</p>
        <label className="field">Amount<span className="transport-phone"><span aria-hidden="true">₱</span><input type="number" inputMode="decimal" min="0" max="1000000" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} required aria-label="Quotation amount, in pesos" /></span></label>
        {row.estimate_total_centavos !== null && row.estimate_total_centavos !== undefined && <button type="button" className="text-button" onClick={() => setAmount(String(row.estimate_total_centavos! / 100))}>Use the estimate</button>}
        <label className="field">Valid until (Philippine time)<input type="datetime-local" name="expires_at" min={manilaInput(new Date().toISOString())} required /></label>
        <button className="btn btn-primary" disabled={busy}>Send quotation</button>
      </form>}
      {row.status === 'quoted' && <p className="muted small">Waiting for the customer to accept the quotation.</p>}
      {canAssign && <form className="workflow-form" onSubmit={assign}>
        <h4>Assign driver and vehicle</h4>
        {awaitingPayment && <p className="notice">The customer has accepted the quotation but has not paid yet. The trip can be scheduled once payment is verified.</p>}
        <Lookup kind="drivers" name="driver_id" label="Driver" value={row.driver_id ?? undefined} />
        <Lookup kind="vehicles" name="vehicle_id" label="Vehicle" />
        <label className="field">Confirmed schedule (Philippine time)<input type="datetime-local" name="confirmed_schedule" min={manilaInput(new Date().toISOString())} defaultValue={Date.parse(row.preferred_schedule) > Date.now() ? manilaInput(row.preferred_schedule) : undefined} required /></label>
        <button className="btn btn-primary" disabled={busy || awaitingPayment}>Assign and schedule</button>
      </form>}
      {row.status === 'scheduled' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('picked_up', 'Mark this pet as picked up from the shelter?', 'Marked as picked up.')}>Mark picked up</button>}
      {row.status === 'picked_up' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('in_transit', 'Mark this trip as in transit?', 'Marked as in transit.')}>Mark in transit</button>}
      {row.status === 'in_transit' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('arrived', 'Mark this pet as delivered to the destination?', 'Marked as delivered.')}>Mark delivered</button>}
      {row.status === 'arrived' && !row.handover && <form className="workflow-form" onSubmit={handover}>
        <h4>Confirm the handover</h4>
        <label className="field">Received by<input name="recipient_name" required minLength={2} maxLength={120} /></label>
        <label className="field">Handover notes<textarea name="notes" rows={3} required minLength={5} maxLength={2000} /></label>
        <button className="btn btn-primary" disabled={busy}>Record handover</button>
      </form>}
      {row.status === 'arrived' && row.handover && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('completed', 'Complete this transport request?', 'Transport completed.')}>Mark completed</button>}
      {['completed', 'declined', 'cancelled'].includes(row.status) && <p className="muted">This request is closed.</p>}
      {canStop && <div className="table-actions"><button type="button" className="text-button" disabled={busy} onClick={() => move('declined', 'Decline this request?', 'Request declined.', true)}>Decline</button><button type="button" className="text-button" disabled={busy} onClick={() => move('cancelled', 'Cancel this request?', 'Request cancelled.', true)}>Cancel request</button></div>}
    </section>
    <section className="card transport-staff">
      <h3>Internal notes</h3>
      <p className="small muted">Seen by shelter staff only, never by the customer or the driver.</p>
      {row.internal_notes?.length ? <ul className="transport-notes-list">{row.internal_notes.map(item => <li key={item.id}><p className="transport-prose">{item.note}</p><span className="muted small">{item.author_name || 'Staff'} · {when(item.created_at)}</span></li>)}</ul> : <p className="muted">No notes yet.</p>}
      <form className="transport-note-form" onSubmit={addNote}><label className="field">Add a note<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} required minLength={2} maxLength={2000} /></label><button className="btn btn-secondary" disabled={busy || note.trim().length < 2}>Add note</button></form>
    </section>
  </>;
}
