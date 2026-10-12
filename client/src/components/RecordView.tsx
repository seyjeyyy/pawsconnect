import type { ReactNode } from 'react';
import { money } from '../lib/api';

// One readable view of a record for every details and review dialog. It shows names for the
// identifiers the API resolved (`references`), formats money, dates and choices, lays out
// addresses and order items, and leaves out identifiers and storage details nobody reads.
type Row = Record<string, unknown>;
const zone = 'Asia/Manila';
const dateTime = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
const dateOnly = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: zone });
const sentence = (text: string) => { const words = text.replaceAll('_', ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
const shortId = (value: unknown) => String(value).slice(0, 8).toUpperCase();
const isPlain = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const isEmpty = (value: unknown) => value == null || value === '' || (Array.isArray(value) && !value.length) || (isPlain(value) && !Object.keys(value).length);

const singular: Record<string, string> = {
  payments: 'Payment', refunds: 'Refund request', reviews: 'Customer review', products: 'Product', categories: 'Category', orders: 'Order', pets: 'Pet', health: 'Health record',
  adoptions: 'Adoption application', applications: 'Adoption application', rescue: 'Rescue report', reports: 'Rescue report', transport: 'Transport request', alternatives: 'Alternative transport request',
  zones: 'Service zone', vehicles: 'Vehicle', drivers: 'Driver', donations: 'Donation', volunteers: 'Volunteer', users: 'Account', expenses: 'Expense', audit_logs: 'Audit entry',
  contact_messages: 'Message', messages: 'Inquiry', vouchers: 'Voucher', loyalty: 'Loyalty reward rule', security_events: 'Security event', security_alerts: 'Security alert',
  critical_approvals: 'Access request', notifications: 'Notification', wishlist: 'Wishlist item', favorites: 'Saved pet',
};
/** "Order PC-123", "Refund request": what the dialog is about, in the singular. */
export function recordTitle(kind: string, record?: Row) {
  const base = singular[kind] ?? sentence(kind);
  const name = record?.order_number ?? record?.reference;
  return name ? `${base} ${String(name)}` : base;
}

// Whose account `user_id` is depends on the list it appears in.
const accountLabels: Record<string, string> = { drivers: 'Driver', volunteers: 'Volunteer', critical_approvals: 'Account to change', users: 'Account', rescue: 'Reported by', adoptions: 'Applicant', donations: 'Donor', reviews: 'Reviewer', contact_messages: 'Sent by', alternatives: 'Requested by' };
const labels: Record<string, string> = {
  id: 'Reference', actor_id: 'Account', requested_by: 'Requested by', decided_by: 'Decided by', resolved_by: 'Resolved by', reviewed_by: 'Reviewed by', verified_by: 'Verified by',
  recorded_by: 'Recorded by', replied_by: 'Replied by', assigned_to: 'Assigned to', assigned_by: 'Assigned by', created_by: 'Created by', updated_by: 'Updated by',
  driver_id: 'Driver', vehicle_id: 'Vehicle', product_id: 'Product', pet_id: 'Pet', category_id: 'Category', coupon_id: 'Voucher', order_id: 'Order', entity_id: 'Record',
  resource_id: 'Payment for', resource_type: 'Payment for', payment_transaction_id: 'Payment', provider: 'Payment provider', provider_checkout_id: 'Provider checkout reference',
  provider_payment_id: 'Provider payment reference', provider_refund_id: 'Provider refund reference', livemode: 'Payment mode', failure_reason: 'Reason it failed',
  created_at: 'Created', updated_at: 'Last updated', paid_at: 'Paid', fee_paid_at: 'Adoption fee paid', read_at: 'Read', replied_at: 'Replied', occurred_at: 'Date',
  reservation_expires_at: 'Payment deadline', is_published: 'Published', is_approved: 'Approved for the website', is_active: 'Active', is_sample: 'Sample listing',
  is_default: 'Default', is_anonymous: 'Anonymous', sku: 'SKU', body: 'Review', order_number: 'Order number', stock_quantity: 'In stock',
  reserved_quantity: 'Held by unpaid orders', available_quantity: 'Available to sell', image_url: 'Photo', order_items: 'Items', address_snapshot: 'Delivery address',
  fee_centavos: 'Fee', price_centavos: 'Selling price', cost_centavos: 'Unit cost', total_centavos: 'Total', user_roles: 'Roles', full_name: 'Name', entity_type: 'Record type',
  pets: 'Pet', products: 'Product', profiles: 'Name', pet_behavior_profiles: 'Behaviour assessment', line1: 'Address', event_count: 'Events', age_months: 'Age (months)', enabled: 'Grants the role',
};
export function fieldLabel(key: string, kind = '') {
  if (key === 'user_id') return accountLabels[kind] ?? 'Customer';
  return labels[key] ?? sentence(key.replace(/_centavos$/, '').replace(/_(id|at)$/, '').replace(/^is_/, ''));
}
/** The name the API resolved for an identifier on this row, if it did. */
export const referenceText = (row: Row, key: string) => (row.references as Record<string, string> | undefined)?.[key];

// Never shown: the reference map itself, storage and map internals, and duplicates of what is shown another way.
const hidden = new Set(['references', 'provider_payload', 'checkout_url', 'currency', 'boundary', 'route_geometry', 'location', 'document_paths', 'document_path', 'storage_path', 'stray_report_photos', 'avatar_url', 'staff_access']);
// Shown to staff only: provider references and map coordinates.
const staffOnly = new Set(['provider', 'provider_checkout_id', 'provider_payment_id', 'provider_refund_id', 'latitude', 'longitude', 'pickup_latitude', 'pickup_longitude', 'dropoff_latitude', 'dropoff_longitude', 'slug']);
const embedded: Record<string, [id: string, name: string]> = { pets: ['pet_id', 'name'], products: ['product_id', 'name'], profiles: ['user_id', 'full_name'] };
const choices = new Set(['resource_type', 'donation_type', 'record_type', 'arrangement_type', 'service_type', 'species', 'sex', 'size', 'kind', 'applies_to', 'metric', 'discount_type', 'animal_type', 'condition', 'event_type', 'role_name', 'availability', 'urgency', 'rule', 'location_type', 'pickup_mode', 'provider', 'entity_type', 'housing_type', 'pet_experience']);
const whenEmpty: Record<string, string> = { paid_at: 'Not paid', fee_paid_at: 'Not paid', read_at: 'Unread', reply: 'No reply yet' };
const isDateKey = (key: string) => key.endsWith('_at') || key.endsWith('_schedule');

function formatDate(value: unknown) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateOnly.format(new Date(`${value}T00:00:00+08:00`));
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : dateTime.format(new Date(time));
}
function Address({ value }: { value: Row }) {
  const place = [value.barangay, value.city, value.province, value.postal_code].filter(Boolean).join(', ');
  return <address className="record-address">{value.recipient_name ? <strong>{String(value.recipient_name)}</strong> : null}{value.line1 ? <span>{String(value.line1)}</span> : null}{place && <span>{place}</span>}{value.phone ? <span>{String(value.phone)}</span> : null}{value.instructions ? <span className="muted">Instructions: {String(value.instructions)}</span> : null}</address>;
}
function Items({ items }: { items: Row[] }) {
  return <ul className="record-list">{items.map((item, index) => <li key={String(item.id ?? index)}><span>{String(item.quantity)} × {String(item.product_name ?? referenceText(item, 'product_id') ?? 'Item')}</span><span>{money(Number(item.line_total_centavos ?? 0))}{Number(item.quantity) > 1 ? ` (${money(Number(item.unit_price_centavos ?? 0))} each)` : ''}</span></li>)}</ul>;
}

/** The value as a person reads it, or null when the field has nothing worth a line. */
function display(key: string, value: unknown, row: Row, staff: boolean): ReactNode {
  if (hidden.has(key) || (!staff && staffOnly.has(key))) return null;
  const reference = referenceText(row, key);
  if (reference) return reference;
  if (key === 'id') return row.order_number || row.reference || row.code ? null : shortId(value);
  // What a payment was for is one line: the resolved record, or the kind of record when it could not be resolved.
  if (key === 'resource_type') return referenceText(row, 'resource_id') ? null : sentence(String(value));
  if (key === 'entity_id') return value ? shortId(value) : null;
  if (key.startsWith('provider_')) return value ? String(value) : null;
  // An identifier with no name resolved is a pointer between tables, not information.
  if (key.endsWith('_id') || ['requested_by', 'decided_by', 'resolved_by', 'reviewed_by', 'verified_by', 'recorded_by', 'replied_by', 'assigned_to', 'assigned_by', 'created_by', 'updated_by'].includes(key)) return null;
  if (embedded[key]) { const [idKey, nameKey] = embedded[key]; const target = (Array.isArray(value) ? value[0] : value) as Row | null; return referenceText(row, idKey) || !target?.[nameKey] ? null : String(target[nameKey]); }
  if (key === 'user_roles' && Array.isArray(value)) return value.map(role => sentence(String((role as Row).role_name))).join(', ') || null;
  if (isEmpty(value)) return whenEmpty[key] ?? null;
  if (key === 'livemode') return value ? 'Live' : 'Test (no real charge)';
  if (key === 'status' || key.endsWith('_status')) return <span className={`badge status-${String(value)}`}>{sentence(String(value))}</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key.endsWith('_centavos')) return money(Number(value));
  if (key === 'rating') return `${String(value)} out of 5`;
  if (isDateKey(key)) return formatDate(value) ?? String(value);
  if (key === 'order_items' && Array.isArray(value)) return <Items items={value as Row[]} />;
  if (isPlain(value) && (key === 'address_snapshot' || 'line1' in value)) return <Address value={value} />;
  if (Array.isArray(value)) return value.every(item => !isPlain(item)) ? value.map(item => choices.has(key) ? sentence(String(item)) : String(item)).join(', ') : <ol className="record-list record-nested">{(value as Row[]).map((item, index) => <li key={String(item.id ?? index)}><RecordFields record={item} staff={staff} kind={key} nested /></li>)}</ol>;
  if (isPlain(value)) return <RecordFields record={value} staff={staff} kind={key} nested />;
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return <a href={value} target="_blank" rel="noreferrer">{key === 'image_url' ? 'Open photo' : 'Open link'}</a>;
  if (choices.has(key) || (typeof value === 'string' && /^[a-z]+(_[a-z]+)+$/.test(value))) return sentence(String(value));
  return String(value);
}

export function RecordFields({ record, staff = false, kind = '', nested = false }: { record: Row; staff?: boolean; kind?: string; nested?: boolean }) {
  const lines = Object.entries(record).flatMap(([key, value]) => {
    // Inside a nested record the short reference is noise: the parent already identifies it.
    const shown = nested && key === 'id' ? null : display(key, value, record, staff);
    return shown == null || shown === '' ? [] : [<div key={key}><dt>{fieldLabel(key, kind)}</dt><dd>{shown}</dd></div>];
  });
  return lines.length ? <dl className={`record-details${nested ? ' record-nested' : ''}`}>{lines}</dl> : nested ? null : <p className="muted">No further details are recorded.</p>;
}
