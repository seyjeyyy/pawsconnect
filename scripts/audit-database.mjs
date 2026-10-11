// Read-only inventory. Never prints credentials, names, contact details, or record contents.
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: 'server/.env', quiet: true });
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase is not configured.');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const table of ['profiles','user_roles','pets','products','product_categories','orders','adoption_applications','stray_reports','transport_requests','donations','notifications','audit_logs','service_zones','refunds']) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  console.log(JSON.stringify({ table, count, error: error?.code }));
}
for (const table of ['products','pets']) {
  const { count, error } = await db.from(table).select('id', { count: 'exact', head: true }).eq('is_sample', true);
  console.log(JSON.stringify({ table, marked_sample: count, error: error?.code }));
}
const zones = await db.from('service_zones').select('id', { count: 'exact', head: true }).ilike('name', 'Demo%');
console.log(JSON.stringify({ demo_named_zones: zones.count, error: zones.error?.code }));
