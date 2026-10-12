import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/common';
import { useConfirmation } from '../../components/Confirm';
import './transport.css';

// Delivery range and pricing for shelter transport. Nothing here has a default: an empty field
// means "not set", and until a base fee and a rate per kilometre are entered customers are told
// that staff will send a quote. Each change is confirmed and written to the audit trail.
type Size = { small_max_kg: number | null; medium_max_kg: number | null; small: number | null; medium: number | null; large: number | null };
type Settings = { max_distance_km: number | null; base_fee_centavos: number | null; rate_per_km_centavos: number | null; handling_fees: { species?: Partial<Record<'dog' | 'cat' | 'other', number | null>>; size?: Partial<Size> }; surcharges: { label: string; amount_centavos: number; when: 'always' | 'no_carrier' }[]; updated_at: string };
type Draft = { max_distance_km: string; base: string; rate: string; dog: string; cat: string; other: string; small_max_kg: string; medium_max_kg: string; small: string; medium: string; large: string; surcharges: { label: string; amount: string; when: 'always' | 'no_carrier' }[] };
const pesosOf = (centavos: number | null | undefined) => centavos === null || centavos === undefined ? '' : String(centavos / 100);
const plain = (value: number | null | undefined) => value === null || value === undefined ? '' : String(value);
const draftOf = (saved: Settings): Draft => ({
  max_distance_km: plain(saved.max_distance_km), base: pesosOf(saved.base_fee_centavos), rate: pesosOf(saved.rate_per_km_centavos),
  dog: pesosOf(saved.handling_fees.species?.dog), cat: pesosOf(saved.handling_fees.species?.cat), other: pesosOf(saved.handling_fees.species?.other),
  small_max_kg: plain(saved.handling_fees.size?.small_max_kg), medium_max_kg: plain(saved.handling_fees.size?.medium_max_kg),
  small: pesosOf(saved.handling_fees.size?.small), medium: pesosOf(saved.handling_fees.size?.medium), large: pesosOf(saved.handling_fees.size?.large),
  surcharges: saved.surcharges.map(item => ({ label: item.label, amount: pesosOf(item.amount_centavos), when: item.when })),
});
const number = (text: string) => text.trim() === '' ? null : Number(text);
const centavos = (text: string) => text.trim() === '' ? null : Math.round(Number(text) * 100);
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the request. Please try again.';
const when = (value: string) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value));

export default function TransportSettings() {
  const cache = useQueryClient(); const confirm = useConfirmation();
  const settings = useQuery({ queryKey: ['admin', 'transport-settings'], queryFn: ({ signal }) => api<Settings>('/admin/transport-settings', { signal }) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  useEffect(() => { if (settings.data) setDraft(draftOf(settings.data)); }, [settings.data]);
  if (settings.isLoading) return <div className="dashboard-skeleton" aria-label="Loading transport pricing"><div /><div /><div /></div>;
  if (settings.error || !settings.data || !draft) return <ErrorState error={settings.error} retry={() => settings.refetch()} />;

  const saved = settings.data;
  const configured = saved.base_fee_centavos !== null && saved.rate_per_km_centavos !== null;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  const set = (key: Exclude<keyof Draft, 'surcharges'>, value: string) => { setDraft({ ...draft, [key]: value }); setSuccess(''); };
  const setSurcharge = (index: number, change: Partial<Draft['surcharges'][number]>) => { setDraft({ ...draft, surcharges: draft.surcharges.map((item, at) => at === index ? { ...item, ...change } : item) }); setSuccess(''); };
  const money = (label: string, key: Exclude<keyof Draft, 'surcharges'>) => <label className="field">{label}<span className="transport-phone"><span aria-hidden="true">₱</span><input type="number" inputMode="decimal" min="0" max="1000000" step="0.01" value={draft[key]} onChange={event => set(key, event.target.value)} placeholder="Not set" aria-label={`${label}, in pesos`} /></span></label>;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving) return;
    const answer = await confirm({ title: 'Change transport pricing?', description: 'New estimates shown to customers use these values straight away. Bookings already saved keep the estimate they were given, and the final price remains the staff quotation.', reason: true, confirmLabel: 'Save pricing' });
    if (!answer.confirmed) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      await api('/admin/transport-settings', { method: 'PUT', body: JSON.stringify({
        max_distance_km: number(draft!.max_distance_km), base_fee_centavos: centavos(draft!.base), rate_per_km_centavos: centavos(draft!.rate),
        handling_fees: { species: { dog: centavos(draft!.dog), cat: centavos(draft!.cat), other: centavos(draft!.other) }, size: { small_max_kg: number(draft!.small_max_kg), medium_max_kg: number(draft!.medium_max_kg), small: centavos(draft!.small), medium: centavos(draft!.medium), large: centavos(draft!.large) } },
        surcharges: draft!.surcharges.map(item => ({ label: item.label.trim(), amount_centavos: centavos(item.amount) ?? 0, when: item.when })),
        reason: answer.reason.trim(),
      }) });
      await cache.invalidateQueries({ queryKey: ['admin', 'transport-settings'] });
      setSuccess('Transport pricing has been saved and the change recorded in the audit trail.');
    } catch (failure) { setError(messageOf(failure)); } finally { setSaving(false); }
  }

  return <form className="transport-settings" onSubmit={save}>
    <div className={`notice${configured ? ' success' : ''}`} role="status">{configured ? <><Check size={17} /><p>Pricing is set up. Customers see an estimate, labelled as an estimate, before staff confirm the final price.</p></> : <p><strong>Pricing is not set up.</strong> Customers are told that staff will send a quote after reviewing the request. Enter a base fee and a rate per kilometre to show estimates.</p>}<p className="small">Last changed {when(saved.updated_at)}.</p></div>

    <fieldset className="card transport-section"><legend>Distance pricing</legend>
      <p className="muted small">Estimate = base fee + (road distance × rate per km) + any fees below that apply. The road distance comes from the route service.</p>
      <div className="form-grid">{money('Base fee', 'base')}{money('Rate per kilometre', 'rate')}</div>
    </fieldset>

    <fieldset className="card transport-section"><legend>Handling fee by species</legend>
      <div className="form-grid">{money('Dog', 'dog')}{money('Cat', 'cat')}{money('Other animals', 'other')}</div>
    </fieldset>

    <fieldset className="card transport-section"><legend>Handling fee by size</legend>
      <p className="muted small">Size is worked out from the weight the customer enters. Leave the limits empty to charge nothing by size.</p>
      <div className="form-grid">
        <label className="field">Small: up to (kg)<input type="number" inputMode="decimal" min="0.1" max="150" step="0.1" value={draft.small_max_kg} onChange={event => set('small_max_kg', event.target.value)} placeholder="Not set" /></label>
        <label className="field">Medium: up to (kg)<input type="number" inputMode="decimal" min="0.1" max="150" step="0.1" value={draft.medium_max_kg} onChange={event => set('medium_max_kg', event.target.value)} placeholder="Not set" /></label>
      </div>
      <div className="form-grid">{money('Small', 'small')}{money('Medium', 'medium')}{money('Large (anything heavier)', 'large')}</div>
    </fieldset>

    <fieldset className="card transport-section"><legend>Surcharges</legend>
      {draft.surcharges.length === 0 && <p className="muted">No surcharges.</p>}
      {draft.surcharges.map((item, index) => <div className="transport-surcharge" key={index}>
        <label className="field">Name<input value={item.label} onChange={event => setSurcharge(index, { label: event.target.value })} required minLength={2} maxLength={80} /></label>
        <label className="field">Amount<span className="transport-phone"><span aria-hidden="true">₱</span><input type="number" inputMode="decimal" min="0" max="1000000" step="0.01" value={item.amount} onChange={event => setSurcharge(index, { amount: event.target.value })} required aria-label="Surcharge amount, in pesos" /></span></label>
        <label className="field">Applies<select value={item.when} onChange={event => setSurcharge(index, { when: event.target.value as 'always' | 'no_carrier' })}><option value="always">To every request</option><option value="no_carrier">When the customer has no carrier</option></select></label>
        <button type="button" className="text-button" onClick={() => { setDraft({ ...draft, surcharges: draft.surcharges.filter((_, at) => at !== index) }); setSuccess(''); }}><Trash2 size={15} />Remove</button>
      </div>)}
      {draft.surcharges.length < 10 && <button type="button" className="btn btn-secondary" onClick={() => { setDraft({ ...draft, surcharges: [...draft.surcharges, { label: '', amount: '', when: 'always' }] }); setSuccess(''); }}><Plus size={16} />Add a surcharge</button>}
    </fieldset>

    <fieldset className="card transport-section"><legend>Delivery range</legend>
      <p className="muted small">Service zones decide where shelter transport is offered. This optional limit also turns away destinations further than this by road from the shelter.</p>
      <label className="field">Maximum driving distance (km)<input type="number" inputMode="decimal" min="0.1" max="2000" step="0.1" value={draft.max_distance_km} onChange={event => set('max_distance_km', event.target.value)} placeholder="No limit" /></label>
    </fieldset>

    {error && <div className="notice error" role="alert">{error}</div>}
    {success && <div className="notice success" role="status"><Check size={17} />{success}</div>}
    <button className="btn btn-primary" disabled={saving || !changed}>{saving ? 'Saving…' : 'Review and save'}</button>
  </form>;
}
