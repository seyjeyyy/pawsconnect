import { z } from 'zod';
import type { db } from '../../config/supabase.js';
import { isStaff, isSystemAdministrator } from '../../middleware/auth.js';
import { assertDb } from '../../utils/errors.js';
import { safeSearch } from '../../utils/validation.js';

// The only things the assistant can do. Every tool is read-only, decides for
// itself whether this account may use it, and filters by the signed-in account
// in code. The model never supplies a user id, a table name or a query.
export type Actor = { id: string; roles: string[]; permissions?: string[] };
type Db = ReturnType<typeof db>;
type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
export type AssistantTool = {
  name: string;
  /** What the model is told the tool does. */
  description: string;
  /** Shown to the person while the tool runs. */
  label: string;
  input: z.ZodTypeAny;
  /** JSON Schema of the input, as shown to the model. `input` is what is enforced. */
  schema: JsonSchema;
  allowed: (actor: Actor) => boolean;
  run: (actor: Actor, input: any, client: Db) => Promise<unknown>;
};

const fieldRoles = ['veterinarian', 'rescue_personnel', 'shelter_driver'];
export const accountType = (roles: string[]) => isSystemAdministrator(roles) ? 'super_administrator' : isStaff(roles) || roles.some(role => fieldRoles.includes(role)) ? 'staff' : 'user';
const has = (actor: Actor, permission: string) => actor.permissions?.includes(permission) ?? false;
const anyone = () => true;
const limit = z.number().int().min(1).max(10).default(6);
const limitSchema = { type: 'integer', minimum: 1, maximum: 10, description: 'How many to return (default 6).' } as const;
const short = (text: unknown, length = 240) => typeof text === 'string' && text.length > length ? `${text.slice(0, length)}…` : text;
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const myRecordKinds = ['adoption_applications', 'orders', 'rescue_reports', 'donations', 'transport_requests', 'payments', 'notifications'] as const;
const myRecords: Record<typeof myRecordKinds[number], { path: string; read: (client: Db, userId: string) => PromiseLike<any> }> = {
  adoption_applications: { path: '/account/applications', read: (client, userId) => client.from('adoption_applications').select('id,status,created_at,fee_centavos,fee_paid_at,pets(name)').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  orders: { path: '/account/orders', read: (client, userId) => client.from('orders').select('order_number,status,total_centavos,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  rescue_reports: { path: '/account/reports', read: (client, userId) => client.from('stray_reports').select('animal_type,city,status,coverage_status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  donations: { path: '/account/donations', read: (client, userId) => client.from('donations').select('donation_type,amount_centavos,status,created_at,paid_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  transport_requests: { path: '/account/transport', read: (client, userId) => client.from('transport_requests').select('pet_details,status,preferred_schedule,confirmed_schedule,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  payments: { path: '/account/payments', read: (client, userId) => client.from('payment_transactions').select('resource_type,amount_centavos,status,livemode,created_at,paid_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
  notifications: { path: '/account/notifications', read: (client, userId) => client.from('notifications').select('title,body,read_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10) },
};

const staffModules = ['pets', 'adoptions', 'rescue', 'transport', 'orders', 'volunteers', 'donations'] as const;
type StaffModule = typeof staffModules[number];
/** The module permission each staff list requires: the same ones workspaceAccess enforces for the workspace screens. */
export const staffModulePermission: Record<StaffModule, string> = { pets: 'animals.view', adoptions: 'adoptions.review', rescue: 'rescue.manage', transport: 'transport.manage', orders: 'store.manage', volunteers: 'volunteers.manage', donations: 'donations.view' };
// Slim column lists: no reporter contact details, addresses, documents or payment payloads.
const staffLists: Record<StaffModule, { from: (client: Db) => any; search?: string; order: string }> = {
  pets: { from: client => client.from('pets').select('id,name,species,size,status,is_published,created_at,updated_at', { count: 'exact' }), search: 'name', order: 'created_at' },
  adoptions: { from: client => client.from('adoption_applications').select('id,status,created_at,pets(name),profiles(full_name)', { count: 'exact' }), order: 'created_at' },
  rescue: { from: client => client.from('stray_reports').select('id,animal_type,animal_count,condition,city,barangay,description,status,coverage_status,created_at', { count: 'exact' }), search: 'description', order: 'created_at' },
  transport: { from: client => client.from('transport_requests').select('id,pet_details,status,preferred_schedule,confirmed_schedule,created_at', { count: 'exact' }), search: 'pet_details', order: 'created_at' },
  orders: { from: client => client.from('orders').select('id,order_number,status,total_centavos,created_at', { count: 'exact' }), search: 'order_number', order: 'created_at' },
  volunteers: { from: client => client.from('volunteer_profiles').select('user_id,status,skills,created_at,profiles!volunteer_profiles_user_id_fkey(full_name)', { count: 'exact' }), order: 'created_at' },
  donations: { from: client => client.from('donations').select('id,donation_type,amount_centavos,status,created_at', { count: 'exact' }), order: 'created_at' },
};

const systemKinds = ['users', 'security_alerts', 'critical_approvals', 'audit_logs'] as const;

export const assistantTools: AssistantTool[] = [
  {
    name: 'search_adoptable_pets', label: 'Looking at animals available for adoption',
    description: 'List animals currently published and available for adoption, optionally filtered by species and size. Use this whenever the person asks which animals are available or wants a suggestion. Each result includes the in-app path of the animal\'s page.',
    input: z.object({ species: z.enum(['dog', 'cat', 'other']).optional(), size: z.enum(['small', 'medium', 'large']).optional(), limit }).strict(),
    schema: object({ species: { type: 'string', enum: ['dog', 'cat', 'other'] }, size: { type: 'string', enum: ['small', 'medium', 'large'] }, limit: limitSchema }),
    allowed: anyone,
    async run(_actor, input, client) {
      let query = client.from('pets').select('id,name,species,breed,age_months,sex,size,description,adoption_fee_centavos', { count: 'exact' }).eq('is_published', true).eq('is_sample', false).eq('status', 'available');
      if (input.species) query = query.eq('species', input.species);
      if (input.size) query = query.eq('size', input.size);
      const result = await query.order('created_at', { ascending: false }).limit(input.limit);
      const rows = assertDb<Record<string, unknown>[]>(result);
      return { total_matching: result.count, animals: rows.map(({ id, description, ...pet }) => ({ ...pet, description: short(description), path: `/adopt/${id}` })) };
    },
  },
  {
    name: 'search_products', label: 'Checking the shop',
    description: 'Search published shop products by name and report price and whether each is in stock.',
    input: z.object({ query: z.string().max(80).optional(), limit }).strict(),
    schema: object({ query: { type: 'string', maxLength: 80, description: 'Words from the product name.' }, limit: limitSchema }),
    allowed: anyone,
    async run(_actor, input, client) {
      let query = client.from('products').select('id,name,description,price_centavos,stock_quantity,reserved_quantity').eq('is_published', true).eq('is_sample', false);
      if (input.query) query = query.ilike('name', `%${safeSearch(input.query)}%`);
      const rows = assertDb<Record<string, any>[]>(await query.order('created_at', { ascending: false }).limit(input.limit));
      return { products: rows.map(row => ({ name: row.name, description: short(row.description, 160), price_centavos: row.price_centavos, in_stock: row.stock_quantity - row.reserved_quantity > 0, path: `/shop/${row.id}` })) };
    },
  },
  {
    name: 'my_records', label: 'Checking your records',
    description: 'Read the signed-in person\'s own most recent records of one kind: adoption applications, shop orders, rescue reports, donations, transport requests, payments or notifications. Only this person\'s records are ever returned.',
    input: z.object({ kind: z.enum(myRecordKinds) }).strict(),
    schema: object({ kind: { type: 'string', enum: [...myRecordKinds] } }, ['kind']),
    allowed: anyone,
    async run(actor, input: { kind: typeof myRecordKinds[number] }, client) {
      const source = myRecords[input.kind];
      const rows = assertDb<Record<string, unknown>[]>(await source.read(client, actor.id));
      return { records: rows.map(row => ({ ...row, ...('body' in row ? { body: short(row.body) } : {}) })), path: source.path };
    },
  },
  {
    name: 'my_volunteer_status', label: 'Checking your volunteer status',
    description: 'Read the signed-in person\'s own volunteer application status and the tasks assigned to them.',
    input: z.object({}).strict(), schema: object({}),
    allowed: anyone,
    async run(actor, _input, client) {
      const application = assertDb<Record<string, unknown> | null>(await client.from('volunteer_profiles').select('status,skills,created_at').eq('user_id', actor.id).maybeSingle());
      if (!application) return { application: null, apply_path: '/volunteer' };
      const tasks = assertDb<Record<string, unknown>[]>(await client.from('volunteer_tasks').select('title,status,scheduled_at').eq('volunteer_id', actor.id).order('created_at', { ascending: false }).limit(10));
      return { application, tasks, path: '/account/volunteer' };
    },
  },
  {
    name: 'my_account_summary', label: 'Checking your account',
    description: 'Counts of the signed-in person\'s own orders, adoption applications, rescue reports and unread updates.',
    input: z.object({}).strict(), schema: object({}),
    allowed: actor => accountType(actor.roles) === 'user',
    run: async (actor, _input, client) => assertDb(await client.rpc('account_metrics', { p_actor_id: actor.id })),
  },
  {
    name: 'workspace_overview', label: 'Checking work waiting in your modules',
    description: 'Counts of work waiting in the workspace modules assigned to this staff member (animals in care, adoption applications to review, active rescues, transport to review, orders to process, volunteer applications). Only the modules this person is assigned appear.',
    input: z.object({}).strict(), schema: object({}),
    allowed: actor => accountType(actor.roles) === 'staff' && (actor.permissions?.length ?? 0) > 0,
    run: async (actor, _input, client) => assertDb(await client.rpc('workspace_overview', { p_actor_id: actor.id })),
  },
  {
    name: 'staff_records', label: 'Searching workspace records',
    description: 'List shelter records in one workspace module this staff member is assigned to, optionally filtered by status and a search word. Returns the total number matching and the most recent few, with the workspace path where the full list is managed.',
    input: z.object({ module: z.enum(staffModules), status: z.string().max(40).regex(/^[a-z_]+$/).optional(), search: z.string().max(80).optional(), limit }).strict(),
    schema: object({ module: { type: 'string', enum: [...staffModules] }, status: { type: 'string', maxLength: 40, pattern: '^[a-z_]+$', description: 'Exact status value, for example submitted, under_review, available, in_progress, paid.' }, search: { type: 'string', maxLength: 80 }, limit: limitSchema }, ['module']),
    // Field roles see only their own assignments on the workspace screens, so they do not get this list.
    allowed: actor => isStaff(actor.roles) && staffModules.some(module => has(actor, staffModulePermission[module])),
    async run(actor, input: { module: StaffModule; status?: string; search?: string; limit: number }, client) {
      if (!isStaff(actor.roles) || !has(actor, staffModulePermission[input.module])) return { error: 'This account is not assigned to that module.' };
      const source = staffLists[input.module];
      let query = source.from(client);
      if (input.status) query = query.eq('status', input.status);
      if (input.search && source.search) query = query.ilike(source.search, `%${safeSearch(input.search)}%`);
      const result = await query.order(source.order, { ascending: false }).limit(input.limit);
      const rows = assertDb<Record<string, unknown>[]>(result);
      return { total_matching: result.count, records: rows.map(row => ({ ...row, ...('description' in row ? { description: short(row.description) } : {}) })), path: `/admin/${input.module}` };
    },
  },
  {
    name: 'system_overview', label: 'Checking system status',
    description: 'System administration summary for the super administrator: registered accounts, security events, open alerts and pending elevated-access requests.',
    input: z.object({}).strict(), schema: object({}),
    allowed: actor => isSystemAdministrator(actor.roles),
    async run(actor, _input, client) {
      const [metrics, accounts] = await Promise.all([client.rpc('security_metrics', { p_actor_id: actor.id }), client.from('profiles').select('id', { count: 'exact', head: true })]);
      assertDb(accounts);
      return { registered_accounts: accounts.count, security: assertDb(metrics), path: '/admin/security' };
    },
  },
  {
    name: 'system_records', label: 'Reading system records',
    description: 'Most recent system administration records of one kind for the super administrator: accounts with their roles, security alerts, elevated-access requests, or audit trail entries.',
    input: z.object({ kind: z.enum(systemKinds), status: z.string().max(40).regex(/^[a-z_]+$/).optional(), search: z.string().max(80).optional(), limit }).strict(),
    schema: object({ kind: { type: 'string', enum: [...systemKinds] }, status: { type: 'string', maxLength: 40, pattern: '^[a-z_]+$', description: 'For alerts: open or resolved. For requests: pending, approved or rejected.' }, search: { type: 'string', maxLength: 80, description: 'For accounts: part of a name.' }, limit: limitSchema }, ['kind']),
    allowed: actor => isSystemAdministrator(actor.roles),
    async run(actor, input: { kind: typeof systemKinds[number]; status?: string; search?: string; limit: number }, client) {
      if (!isSystemAdministrator(actor.roles)) return { error: 'This account cannot read system records.' };
      if (input.kind === 'users') {
        let query = client.from('profiles').select('full_name,created_at,user_roles!user_roles_user_id_fkey(role_name)', { count: 'exact' });
        if (input.search) query = query.ilike('full_name', `%${safeSearch(input.search)}%`);
        const result = await query.order('created_at', { ascending: false }).limit(input.limit);
        const rows = assertDb<{ full_name: string; created_at: string; user_roles: { role_name: string }[] }[]>(result);
        return { total_matching: result.count, accounts: rows.map(row => ({ name: row.full_name, created_at: row.created_at, account_type: accountType(row.user_roles.map(role => role.role_name)), roles: row.user_roles.map(role => role.role_name) })), path: '/admin/users' };
      }
      if (input.kind === 'security_alerts') {
        let query = client.from('security_alerts').select('rule,event_count,status,created_at,resolved_at', { count: 'exact' });
        if (input.status) query = query.eq('status', input.status);
        const result = await query.order('created_at', { ascending: false }).limit(input.limit);
        return { total_matching: result.count, records: assertDb(result), path: '/admin/security_alerts' };
      }
      if (input.kind === 'critical_approvals') {
        let query = client.from('critical_approvals').select('role_name,enabled,status,reason,created_at,decided_at', { count: 'exact' });
        if (input.status) query = query.eq('status', input.status);
        const result = await query.order('created_at', { ascending: false }).limit(input.limit);
        return { total_matching: result.count, records: assertDb(result), path: '/admin/critical_approvals' };
      }
      const result = await client.from('audit_logs').select('action,entity_type,created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(input.limit);
      return { total_matching: result.count, records: assertDb(result), path: '/admin/audit_logs' };
    },
  },
];

/** The tools this account may use right now. Anything else is never offered to the model. */
export const toolsFor = (actor: Actor) => assistantTools.filter(tool => tool.allowed(actor));

/** Opening prompts shown in the chat panel, matched to what this account can actually do. */
export function suggestionsFor(actor: Actor): string[] {
  const type = accountType(actor.roles);
  if (type === 'super_administrator') return ['Show the system overview', 'Are there open security alerts?', 'Check pending access requests'];
  if (type === 'staff') {
    const byPermission: [string, string][] = [['adoptions.review', 'Which adoption applications need review?'], ['animals.view', 'Which animals are available for adoption?'], ['rescue.manage', 'Show active rescue cases'], ['store.manage', 'Which orders need processing?'], ['transport.manage', 'Any transport requests to review?'], ['volunteers.manage', 'Are there volunteer applications waiting?']];
    const matched = byPermission.filter(([permission]) => has(actor, permission)).map(([, prompt]) => prompt);
    return ['What should I prioritize?', ...matched].slice(0, 4);
  }
  return ['Help me adopt a pet', 'Track my adoption application', 'Where is my order?', 'How can I volunteer?'];
}
