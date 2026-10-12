import { db } from '../../config/supabase.js';
import { assertDb } from '../../utils/errors.js';

// Lists carry identifiers of other records (who paid, which product, which order). A person
// reading a record needs the name, so each row gets a `references` map from the identifier's
// key to the text to show for it. Rows nested inside a row (order items, assignments) get one too.
type Row = Record<string, unknown>;
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const personKeys = ['user_id', 'actor_id', 'requested_by', 'decided_by', 'resolved_by', 'reviewed_by', 'verified_by', 'recorded_by', 'replied_by', 'assigned_to', 'assigned_by', 'driver_id', 'created_by', 'updated_by'];
const labels = (rows: Row[], text: (row: Row) => unknown) => new Map(rows.flatMap(row => { const label = text(row); return label ? [[String(row.id), String(label)] as [string, string]] : []; }));

const lookups: Record<string, (ids: string[]) => Promise<Map<string, string>>> = {
  people: async ids => labels(assertDb<Row[]>(await db().from('profiles').select('id,full_name').in('id', ids)), row => row.full_name),
  product_id: async ids => labels(assertDb<Row[]>(await db().from('products').select('id,name').in('id', ids)), row => row.name),
  pet_id: async ids => labels(assertDb<Row[]>(await db().from('pets').select('id,name').in('id', ids)), row => row.name),
  category_id: async ids => labels(assertDb<Row[]>(await db().from('product_categories').select('id,name').in('id', ids)), row => row.name),
  vehicle_id: async ids => labels(assertDb<Row[]>(await db().from('shelter_vehicles').select('id,name,plate_number').in('id', ids)), row => `${row.name} (${row.plate_number})`),
  coupon_id: async ids => labels(assertDb<Row[]>(await db().from('coupons').select('id,code').in('id', ids)), row => row.code),
  order_id: async ids => labels(assertDb<Row[]>(await db().from('orders').select('id,order_number').in('id', ids)), row => `Order ${row.order_number}`),
};

/** What a payment was for, keyed by `type:id`. */
async function paidFor(targets: { type: string; id: string }[]) {
  const ids = (type: string) => [...new Set(targets.filter(target => target.type === type).map(target => target.id))];
  const [orders, adoptions, transport] = await Promise.all([
    ids('order').length ? db().from('orders').select('id,order_number').in('id', ids('order')) : null,
    ids('adoption').length ? db().from('adoption_applications').select('id,pets(name)').in('id', ids('adoption')) : null,
    ids('transport').length ? db().from('transport_requests').select('id,reference').in('id', ids('transport')) : null,
  ]);
  const found = new Map<string, string>();
  for (const row of orders ? assertDb<Row[]>(orders) : []) found.set(`order:${row.id}`, `Order ${row.order_number}`);
  for (const row of adoptions ? assertDb<Row[]>(adoptions) : []) { const pet = row.pets as { name?: string } | { name?: string }[] | null; const name = (Array.isArray(pet) ? pet[0] : pet)?.name; found.set(`adoption:${row.id}`, name ? `Adoption fee for ${name}` : 'Adoption fee'); }
  for (const row of transport ? assertDb<Row[]>(transport) : []) found.set(`transport:${row.id}`, `Pet transport ${row.reference}`);
  for (const target of targets) if (target.type === 'donation') found.set(`donation:${target.id}`, 'Donation');
  return found;
}

/** Every row and nested row, to two levels. Stored snapshots are plain data and are visited harmlessly. */
function visit(value: unknown, each: (row: Row) => void, depth = 0): void {
  if (Array.isArray(value)) { for (const item of value) visit(item, each, depth); return; }
  if (!value || typeof value !== 'object') return;
  each(value as Row);
  if (depth < 2) for (const nested of Object.values(value as Row)) if (nested && typeof nested === 'object') visit(nested, each, depth + 1);
}

/** `people` is for staff and system administrators; without it no account names are added. */
export async function withReferences<T extends Row>(rows: T[], options: { people: boolean }): Promise<T[]> {
  const wanted = new Map<string, Set<string>>();
  const want = (lookup: string, id: unknown) => { if (isId(id)) wanted.set(lookup, (wanted.get(lookup) ?? new Set<string>()).add(id)); };
  const targets: { type: string; id: string }[] = [];
  visit(rows, row => {
    for (const [key, value] of Object.entries(row)) {
      if (personKeys.includes(key)) { if (options.people) want('people', value); }
      else if (key === 'resource_id' && typeof row.resource_type === 'string' && isId(value)) targets.push({ type: row.resource_type, id: value });
      else if (key === 'payment_transaction_id') want('payments', value);
      else if (lookups[key]) want(key, value);
    }
  });
  // A refund names its payment; the payment in turn names what was paid for.
  const paymentIds = [...(wanted.get('payments') ?? [])];
  const payments = paymentIds.length ? assertDb<Row[]>(await db().from('payment_transactions').select('id,resource_type,resource_id').in('id', paymentIds)) : [];
  for (const payment of payments) targets.push({ type: String(payment.resource_type), id: String(payment.resource_id) });
  const names = Object.keys(lookups).filter(name => wanted.get(name)?.size);
  const [resolved, purposes] = await Promise.all([Promise.all(names.map(name => lookups[name]([...wanted.get(name)!]))), targets.length ? paidFor(targets) : new Map<string, string>()]);
  const found = new Map(names.map((name, index) => [name, resolved[index]]));
  const paymentLabels = new Map(payments.map(payment => [String(payment.id), `Payment for ${purposes.get(`${payment.resource_type}:${payment.resource_id}`) ?? String(payment.resource_type)}`]));

  const label = (key: string, value: unknown, row: Row) => {
    if (!isId(value)) return undefined;
    if (personKeys.includes(key)) return found.get('people')?.get(value);
    if (key === 'resource_id') return purposes.get(`${row.resource_type}:${value}`);
    if (key === 'payment_transaction_id') return paymentLabels.get(value);
    return found.get(key)?.get(value);
  };
  const attach = (value: unknown, depth: number): unknown => {
    if (Array.isArray(value)) return value.map(item => attach(item, depth));
    if (!value || typeof value !== 'object') return value;
    const row = value as Row, references: Record<string, string> = {}, copy: Row = {};
    for (const [key, field] of Object.entries(row)) {
      copy[key] = field && typeof field === 'object' && depth < 2 ? attach(field, depth + 1) : field;
      const text = label(key, field, row);
      if (text) references[key] = text;
    }
    return Object.keys(references).length ? { ...copy, references } : copy;
  };
  return rows.map(row => attach(row, 0) as T);
}
