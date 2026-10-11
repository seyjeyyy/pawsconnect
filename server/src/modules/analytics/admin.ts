import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate, authorize, isStaff, isSystemAdministrator } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { money, pagination, safeSearch, uuid } from '../../utils/validation.js';
import { connectedAdminRouter } from './connected.js';
import { workspacePermissions } from '../../middleware/permissions.js';

export const adminRouter = Router();
// Administrators and shelter staff reach every route in this router. Field
// roles reach only their own work: the resources listed under `read` (the list
// handler further narrows rescue and transport to the actor's own assignments)
// and the actions listed under `write`. The database functions behind those
// actions check again that the actor is the assigned person.
const recordId = '[0-9a-f-]{36}';
const fieldAccess: Record<string, { read: string[]; write: RegExp[] }> = {
  veterinarian: { read: ['pets', 'health', 'intake', 'lookups/pets'], write: [/^POST \/health$/, new RegExp(`^PATCH /pets/${recordId}/behavior$`)] },
  rescue_personnel: { read: ['rescue'], write: [new RegExp(`^PATCH /rescue/${recordId}/status$`)] },
  // Approved volunteers can be assigned to a rescue by staff.
  volunteer: { read: ['rescue'], write: [new RegExp(`^PATCH /rescue/${recordId}/status$`)] },
  shelter_driver: { read: ['transport'], write: [new RegExp(`^PATCH /transport/${recordId}/status$`)] },
};
// System administration: accounts and access, the audit trail and the security centre.
// Only the super administrator reaches these, and they are all the super administrator
// reaches here. Shelter roles, including the administrator, are refused them.
const systemAccess = {
  read: ['security-summary', 'security_events', 'security_alerts', 'critical_approvals', 'users', 'audit_logs'],
  write: [
    new RegExp(`^PUT /users/${recordId}/permissions$`),
    /^POST \/critical_approvals$/,
    new RegExp(`^POST /critical_approvals/${recordId}/decision$`),
    new RegExp(`^POST /security_alerts/${recordId}/resolve$`),
    new RegExp(`^POST /users/${recordId}/roles$`),
    new RegExp(`^DELETE /users/${recordId}/roles/[a-z_]+$`),
  ],
};
export const workspaceAccess: RequestHandler = (req, _res, next) => {
  const roles = req.actor?.roles ?? [];
  const route = req.path.replace(/\/+$/, '');
  const system = req.method === 'GET' ? systemAccess.read.includes(route.slice(1)) : systemAccess.write.some(pattern => pattern.test(`${req.method} ${route}`));
  if (system) {
    if (!isSystemAdministrator(roles)) throw new ApiError(403, 'FORBIDDEN', 'This action requires the super administrator.');
    next(); return;
  }
  const required = workspacePermissions(req.method, route);
  if (req.actor?.permissions !== undefined && (!required.length || !required.some(p=>req.actor!.permissions!.includes(p)))) throw new ApiError(403,'FORBIDDEN','You are not assigned to this module.');
  if (isStaff(roles)) { next(); return; }
  const grants = roles.flatMap(role => fieldAccess[role] ? [fieldAccess[role]] : []);
  const path = req.path.replace(/\/+$/, '');
  const allowed = req.method === 'GET'
    ? grants.some(grant => grant.read.includes(path.slice(1)))
    : grants.some(grant => grant.write.some(pattern => pattern.test(`${req.method} ${path}`)));
  if (!allowed) throw new ApiError(403, 'FORBIDDEN', 'This action requires an authorized shelter role.');
  next();
};
adminRouter.use(authenticate, workspaceAccess);
adminRouter.use(connectedAdminRouter);
adminRouter.get('/overview', async (req,res)=>{
  res.json({data:assertDb(await db().rpc('workspace_overview',{p_actor_id:req.actor!.id}))});
});
adminRouter.put('/users/:id/permissions', authorize('super_administrator'), async (req,res) => {
  const {permissions}=z.object({permissions:z.array(z.string().min(3).max(60)).max(30)}).strict().parse(req.body);
  assertDb(await db().rpc('set_staff_access',{p_actor_id:req.actor!.id,p_user_id:uuid.parse(req.params.id),p_permissions:permissions}));
  res.json({data:{updated:true}});
});
const resources: Record<string, { table: string; search?: string; order: string; select?: string; admin?: boolean; super?: boolean; key?: string }> = {
  security_events: { table: 'security_events', order: 'created_at', super: true },
  security_alerts: { table: 'security_alerts', order: 'created_at', super: true },
  critical_approvals: { table: 'critical_approvals', order: 'created_at', super: true },
  refunds: { table: 'refunds', order: 'created_at' },
  products: { table: 'products', search: 'name', order: 'created_at' }, categories: { table: 'product_categories', search: 'name', order: 'name' },
  orders: { table: 'orders', search: 'order_number', order: 'created_at', select: '*,order_items(*),shipments(*)' },
  pets: { table: 'pets', search: 'name', order: 'created_at', select: '*,pet_behavior_profiles(*)' },
  adoptions: { table: 'adoption_applications', order: 'created_at', select: '*,pets(name,image_url),profiles(full_name),adoption_appointments(*)' },
  rescue: { table: 'stray_reports', search: 'description', order: 'created_at', select: '*,stray_report_photos(*),rescue_assignments(*),rescue_events(*)' },
  transport: { table: 'transport_requests', search: 'pet_details', order: 'created_at', select: '*,transport_quotes(*),transport_tracking_events(*),transport_handovers(*)' },
  alternatives: { table: 'alternative_transport_requests', search: 'details', order: 'created_at' },
  zones: { table: 'service_zones', search: 'name', order: 'created_at' }, vehicles: { table: 'shelter_vehicles', search: 'name', order: 'name' },
  drivers: { table: 'shelter_drivers', order: 'created_at', key: 'user_id' }, donations: { table: 'donations', order: 'created_at' },
  volunteers: { table: 'volunteer_profiles', order: 'created_at', key: 'user_id', select: '*,profiles!volunteer_profiles_user_id_fkey(full_name)' },
  users: { table: 'profiles', search: 'full_name', order: 'created_at', select: '*,user_roles!user_roles_user_id_fkey(role_name),staff_access!staff_access_user_id_fkey(permissions)', super: true },
  expenses: { table: 'expenses', search: 'description', order: 'created_at' }, audit_logs: { table: 'audit_logs', search: 'action', order: 'created_at', super: true },
  contact_messages: { table: 'contact_messages', search: 'name', order: 'created_at' },
  payments: { table: 'payment_transactions', order: 'created_at' }, reviews: { table: 'customer_reviews', order: 'created_at' },
  shipments: { table: 'shipments', order: 'created_at' }, notifications: { table: 'notifications', order: 'created_at', admin: true },
  intake: { table: 'shelter_intakes', order: 'intake_at' },
  health: { table: 'pet_health_records', search: 'notes', order: 'occurred_at', select: '*,pets(name)' },
};
const slug = z.string().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const url = z.string().url().max(2000).nullable().optional();
const schemas: Record<string, z.AnyZodObject> = {
  products: z.object({ category_id: uuid.nullable().optional(), name: z.string().min(2).max(200), slug, description: z.string().max(5000).default(''), sku: z.string().max(80).nullable().optional(), price_centavos: money, cost_centavos: money.default(0), stock_quantity: z.number().int().min(0).max(100000).default(0), image_url: url, specifications: z.record(z.unknown()).default({}), is_published: z.boolean().default(false), is_sample: z.boolean().default(false) }).strict(),
  categories: z.object({ name: z.string().min(2).max(100), slug, description: z.string().max(2000).optional(), image_url: url, is_active: z.boolean().default(true) }).strict(),
  pets: z.object({ name: z.string().min(1).max(100), species: z.enum(['dog', 'cat', 'other']), breed: z.string().max(150).nullable().optional(), age_months: z.number().int().min(0).max(600).nullable().optional(), sex: z.enum(['male', 'female', 'unknown']), size: z.enum(['small', 'medium', 'large', 'unknown']), description: z.string().max(5000).default(''), image_url: url, status: z.enum(['assessment', 'available', 'unavailable']).default('assessment'), adoption_fee_centavos: money.default(0), is_published: z.boolean().default(false), is_sample: z.boolean().default(false) }).strict(),
  vehicles: z.object({ name: z.string().min(2).max(100), plate_number: z.string().min(3).max(30), animal_capacity: z.number().int().min(1).max(100), is_active: z.boolean().default(true), notes: z.string().max(2000).optional() }).strict(),
  drivers: z.object({ user_id: uuid, license_reference: z.string().min(3).max(100), is_active: z.boolean().default(false) }).strict(),
  expenses: z.object({ category: z.string().min(2).max(100), description: z.string().min(5).max(2000), amount_centavos: money.positive(), occurred_at: z.string().date() }).strict(),
};
async function audit(actor: string, action: string, table: string, id: string) {
  assertDb(await db().from('audit_logs').insert({ actor_id: actor, action, entity_type: table, entity_id: id }));
}
adminRouter.get('/analytics', async (req, res) => {
  if(req.query.export==='true') assertDb(await db().rpc('authorize_workspace_export',{p_actor_id:req.actor!.id}));
  const totals=assertDb<Record<string,unknown>>(await db().rpc('admin_metrics', { p_actor_id: req.actor!.id }));
  const financialKeys=['financial_note','test_payments','legacy_unclassified_payments','verified_payments'];
  res.json({ data:Object.fromEntries(Object.entries(totals).filter(([key])=>key.endsWith('_centavos')||financialKeys.includes(key))) });
});
adminRouter.post('/inventory', async (req, res) => {
  const input = z.object({ product_id: uuid, variant_id: uuid.optional(), quantity_delta: z.number().int().min(-100000).max(100000).refine(n => n !== 0), reason: z.string().min(5).max(500) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('adjust_inventory', { p_actor_id: req.actor!.id, p_product_id: input.product_id, p_variant_id: input.variant_id ?? null, p_quantity_delta: input.quantity_delta, p_reason: input.reason })) });
});
adminRouter.patch('/orders/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(['processing', 'ready_for_shipment', 'shipped', 'delivered', 'cancelled']), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('transition_order', { p_actor_id: req.actor!.id, p_order_id: uuid.parse(req.params.id), p_status: status })) });
});
adminRouter.patch('/adoptions/:id/status', async (req, res) => {
  const input = z.object({ status: z.enum(['under_review', 'information_requested', 'interview', 'approved', 'rejected', 'awaiting_handover']), notes: z.string().max(3000).optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('transition_adoption', { p_actor_id: req.actor!.id, p_application_id: uuid.parse(req.params.id), p_status: input.status, p_notes: input.notes ?? null })) });
});
adminRouter.post('/adoptions/:id/reserve', async (req, res) => {
  res.json({ data: assertDb(await db().rpc('reserve_pet', { p_actor_id: req.actor!.id, p_application_id: uuid.parse(req.params.id) })) });
});
adminRouter.post('/adoptions/:id/finalize', async (req, res) => {
  const { handover_notes } = z.object({ handover_notes: z.string().min(10).max(3000) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('finalize_adoption', { p_actor_id: req.actor!.id, p_application_id: uuid.parse(req.params.id), p_handover_notes: handover_notes })) });
});
adminRouter.post('/adoptions/:id/appointments', async (req, res) => {
  const input = z.object({ scheduled_at: z.string().datetime({ offset: true }), location: z.string().min(5).max(500), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  const data = assertDb(await db().rpc('schedule_adoption_appointment', { p_actor_id: req.actor!.id, p_application_id: uuid.parse(req.params.id), p_scheduled_at: input.scheduled_at, p_location: input.location, p_notes: input.notes ?? null }));
  res.status(201).json({ data });
});
adminRouter.patch('/pets/:id/behavior', async (req, res) => {
  const input = z.object({ energy_level: z.number().int().min(1).max(5).nullable().optional(), temperament: z.array(z.string().max(50)).max(20).default([]), suitable_homes: z.array(z.enum(['apartment', 'house'])).default([]), good_with_children: z.boolean().nullable().optional(), good_with_dogs: z.boolean().nullable().optional(), good_with_cats: z.boolean().nullable().optional(), care_hours_daily: z.number().min(0).max(24).nullable().optional(), max_hours_alone: z.number().min(0).max(24).nullable().optional(), experience_required: z.number().int().min(1).max(5).nullable().optional(), grooming_level: z.number().int().min(1).max(5).nullable().optional(), exercise_minutes: z.number().int().min(0).max(1440).nullable().optional(), needs_outdoor_space: z.boolean().nullable().optional(), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  const id = uuid.parse(req.params.id);
  res.json({ data: assertDb(await db().from('pet_behavior_profiles').upsert({ ...input, pet_id: id, verified_by: req.actor!.id, verified_at: new Date().toISOString() }).select().single()) });
});
// Medical history is written by veterinarians and staff, never edited afterwards.
adminRouter.post('/health', async (req, res) => {
  const input = z.object({ pet_id: uuid, record_type: z.enum(['checkup', 'vaccination', 'treatment', 'surgery', 'medication', 'observation']), notes: z.string().min(5).max(5000), occurred_at: z.string().datetime({ offset: true }).optional() }).strict().parse(req.body);
  const data = assertDb(await db().from('pet_health_records').insert({ ...input, recorded_by: req.actor!.id }).select().single());
  await audit(req.actor!.id, 'health_record.created', 'pet_health_records', data.id);
  res.status(201).json({ data });
});
adminRouter.patch('/rescue/:id/status', async (req, res) => {
  const input = z.object({ status: z.enum(['under_verification', 'verified', 'in_progress', 'resolved', 'closed', 'invalid', 'duplicate', 'declined', 'referred']), notes: z.string().max(3000).optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('transition_rescue', { p_actor_id: req.actor!.id, p_report_id: uuid.parse(req.params.id), p_status: input.status, p_notes: input.notes ?? null })) });
});
adminRouter.post('/rescue/:id/assign', async (req, res) => {
  const input = z.object({ assignee_id: uuid, notes: z.string().max(2000).optional() }).strict().parse(req.body);
  res.status(201).json({ data: assertDb(await db().rpc('assign_rescue', { p_actor_id: req.actor!.id, p_report_id: uuid.parse(req.params.id), p_assignee_id: input.assignee_id, p_notes: input.notes ?? null })) });
});
adminRouter.patch('/transport/:id/status', async (req, res) => {
  const input = z.object({ status: z.enum(['under_review', 'picked_up', 'in_transit', 'arrived', 'completed', 'declined', 'cancelled']), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('transition_transport', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_status: input.status, p_notes: input.notes ?? null })) });
});
adminRouter.patch('/transport/:id/assignment', async (req, res) => {
  const input = z.object({ driver_id: uuid, vehicle_id: uuid, confirmed_schedule: z.string().datetime({ offset: true }).refine(v => Date.parse(v) > Date.now()) }).strict().parse(req.body);
  const id = uuid.parse(req.params.id);
  const data = assertDb(await db().rpc('schedule_transport', { p_actor_id: req.actor!.id, p_request_id: id, p_driver_id: input.driver_id, p_vehicle_id: input.vehicle_id, p_schedule: input.confirmed_schedule }));
  res.json({ data: { ...data, confirmed_schedule: input.confirmed_schedule } });
});
adminRouter.post('/transport/:id/quote', async (req, res) => {
  const input = z.object({ amount_centavos: money, breakdown: z.record(z.unknown()).default({}), expires_at: z.string().datetime({ offset: true }) }).strict().parse(req.body);
  res.status(201).json({ data: assertDb(await db().rpc('create_transport_quote', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_amount_centavos: input.amount_centavos, p_breakdown: input.breakdown, p_expires_at: input.expires_at })) });
});
adminRouter.post('/transport/:id/handover', async (req, res) => {
  const input = z.object({ recipient_name: z.string().min(2).max(120), notes: z.string().min(5).max(2000) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('confirm_transport_handover', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_recipient_name: input.recipient_name, p_notes: input.notes })) });
});
adminRouter.patch('/alternatives/:id/status', async (req, res) => {
  const input = z.object({ status: z.enum(['under_review', 'approved', 'declined', 'completed', 'cancelled']), notes: z.string().max(3000).optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('transition_alternative_transport', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_status: input.status, p_notes: input.notes ?? null })) });
});
adminRouter.patch('/donations/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(['received', 'cancelled']), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  const id = uuid.parse(req.params.id);
  const data = assertDb(await db().from('donations').update({ status }).eq('id', id).eq('donation_type', 'in_kind').eq('status', 'pledged').select().single());
  await audit(req.actor!.id, `donation.${status}`, 'donations', id);
  res.json({ data });
});
adminRouter.patch('/volunteers/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(['under_review', 'approved', 'declined', 'inactive']), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  const id = uuid.parse(req.params.id);
  const current = assertDb(await db().from('volunteer_profiles').select('status').eq('user_id', id).single());
  const allowed: Record<string, string[]> = { submitted: ['under_review'], under_review: ['approved', 'declined'], approved: ['inactive'], inactive: ['under_review'], declined: ['under_review'] };
  if (!allowed[current.status]?.includes(status)) throw new ApiError(409, 'INVALID_TRANSITION', 'Review the volunteer application before updating this status.');
  const data = assertDb(await db().from('volunteer_profiles').update({ status, reviewed_by: req.actor!.id }).eq('user_id', id).eq('status', current.status).select().single());
  await audit(req.actor!.id, `volunteer.${status}`, 'volunteer_profiles', id);
  res.json({ data });
});
adminRouter.post('/volunteers/:id/tasks', async (req, res) => {
  const input = z.object({ title: z.string().min(3).max(150), description: z.string().max(3000).optional(), scheduled_at: z.string().datetime({ offset: true }).optional() }).strict().parse(req.body);
  const id = uuid.parse(req.params.id);
  assertDb(await db().from('volunteer_profiles').select('user_id').eq('user_id', id).eq('status', 'approved').single());
  res.status(201).json({ data: assertDb(await db().from('volunteer_tasks').insert({ ...input, volunteer_id: id, assigned_by: req.actor!.id }).select().single()) });
});
adminRouter.post('/users/:id/roles', authorize('super_administrator'), async (req, res) => {
  const { role_name } = z.object({ role_name: z.enum(['buyer', 'adopter', 'donor', 'community_reporter', 'volunteer', 'rescue_personnel', 'shelter_driver', 'shelter_staff', 'veterinarian', 'administrator']) }).strict().parse(req.body);
  if (role_name === 'administrator') throw new ApiError(409, 'APPROVAL_REQUIRED', 'Administrator access is granted by request: file an elevated access request for a second super administrator to review.');
  assertDb(await db().rpc('assign_user_role', { p_actor_id: req.actor!.id, p_user_id: uuid.parse(req.params.id), p_role_name: role_name, p_enabled: true }));
  res.json({ data: { assigned: true } });
});
adminRouter.delete('/users/:id/roles/:role', authorize('super_administrator'), async (req, res) => {
  if (['administrator','super_administrator'].includes(String(req.params.role))) throw new ApiError(409, 'APPROVAL_REQUIRED', 'Submit an elevated access request for independent review.');
  assertDb(await db().rpc('assign_user_role', { p_actor_id: req.actor!.id, p_user_id: uuid.parse(req.params.id), p_role_name: z.string().max(50).parse(req.params.role), p_enabled: false }));
  res.json({ data: { removed: true } });
});
const zoneSchema = z.object({ name: z.string().min(3).max(150), service_type: z.enum(['transport', 'rescue', 'delivery', 'donation_pickup', 'adoption']), province: z.string().min(2).max(100), source_reference: z.string().min(5).max(1000), is_active: z.boolean(), boundary: z.object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.array(z.unknown()).min(1) }), fee_centavos: money.default(0) }).strict();
adminRouter.post('/zones', authorize('administrator'), async (req, res) => {
  const p = zoneSchema.parse(req.body);
  res.status(201).json({ data: assertDb(await db().rpc('upsert_service_zone', { p_actor_id: req.actor!.id, p_zone_id: null, p_name: p.name, p_service_type: p.service_type, p_province: p.province, p_geojson: p.boundary, p_source_reference: p.source_reference, p_fee_centavos: p.fee_centavos, p_is_active: p.is_active })) });
});
adminRouter.patch('/zones/:id', authorize('administrator'), async (req, res) => {
  const p = zoneSchema.parse(req.body);
  res.json({ data: assertDb(await db().rpc('upsert_service_zone', { p_actor_id: req.actor!.id, p_zone_id: uuid.parse(req.params.id), p_name: p.name, p_service_type: p.service_type, p_province: p.province, p_geojson: p.boundary, p_source_reference: p.source_reference, p_fee_centavos: p.fee_centavos, p_is_active: p.is_active })) });
});
adminRouter.patch('/reviews/:id/approval', async (req, res) => {
  const { is_approved } = z.object({ is_approved: z.boolean() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().from('customer_reviews').update({ is_approved }).eq('id', uuid.parse(req.params.id)).select().single()) });
});
// Only these explicitly listed business resources may be read. No arbitrary table names reach Supabase.
adminRouter.get('/:resource', async (req, res) => {
  const key = z.string().parse(req.params.resource), resource = resources[key];
  if (!resource) throw new ApiError(404, 'NOT_FOUND', 'Administration resource not found.');
  if (resource.super && !req.actor!.roles.includes('super_administrator')) throw new ApiError(403, 'FORBIDDEN', 'Super administrator access required.');
  if (resource.admin && !req.actor!.roles.includes('administrator')) throw new ApiError(403, 'FORBIDDEN', 'Administrator access required.');
  if (req.query.export === 'true') assertDb(await db().rpc('authorize_workspace_export',{p_actor_id:req.actor!.id}));
  const { page, limit, q } = pagination.parse(req.query);
  const { status, sort, direction } = z.object({ status: z.string().max(50).optional(), sort: z.enum(['created_at', 'name', 'status']).optional(), direction: z.enum(['asc', 'desc']).default('desc') }).parse(req.query);
  let query = db().from(resource.table).select(resource.select ?? '*', { count: 'exact' });
  if (!isStaff(req.actor!.roles)) {
    // Field roles see only the work assigned to them.
    if (key === 'transport') query = query.eq('driver_id', req.actor!.id);
    if (key === 'rescue') {
      const assignments = assertDb<{ report_id: string }[]>(await db().from('rescue_assignments').select('report_id').eq('assigned_to', req.actor!.id).in('status', ['assigned','in_progress','completed']));
      if (!assignments.length) { res.json({ data: [], meta: { total: 0, page, limit } }); return; }
      query = query.in('id', assignments.map(assignment => assignment.report_id));
    }
  }
  if (q && resource.search) query = query.ilike(resource.search, `%${safeSearch(q)}%`);
  if (status && ['orders', 'pets', 'adoptions', 'rescue', 'transport', 'alternatives', 'donations', 'volunteers', 'payments', 'contact_messages'].includes(key)) query = query.eq('status', status);
  const allowedSort = sort === resource.order || sort === resource.search || (sort === 'status' && ['orders','pets','adoptions','rescue','transport','donations','volunteers','payments'].includes(key));
  const result = await query.order(sort && allowedSort ? sort : resource.order, { ascending: direction === 'asc' }).order(resource.key ?? 'id', {ascending: direction === 'asc'}).range((page - 1) * limit, page * limit - 1);
  res.json({ data: assertDb(result), meta: { total: result.count, page, limit } });
});
adminRouter.post('/:resource', async (req, res) => {
  const key = z.string().parse(req.params.resource), schema = schemas[key], resource = resources[key];
  if (!schema || !resource) throw new ApiError(404, 'NOT_FOUND', 'This resource does not support direct creation.');
  const input = schema.parse(req.body);
  if (key === 'drivers') { input.verified_by = req.actor!.id; assertDb(await db().from('user_roles').select('user_id').eq('user_id', input.user_id).eq('role_name', 'shelter_driver').single()); }
  if (key === 'expenses') input.recorded_by = req.actor!.id;
  const data = assertDb(await db().from(resource.table).insert(input).select().single());
  await audit(req.actor!.id, `${key}.created`, resource.table, data[resource.key ?? 'id']);
  res.status(201).json({ data });
});
adminRouter.patch('/:resource/:id', async (req, res) => {
  const key = z.string().parse(req.params.resource), schema = schemas[key], resource = resources[key];
  if (!schema || !resource) throw new ApiError(404, 'NOT_FOUND', 'This resource does not support direct editing.');
  const input = schema.partial().parse(req.body), id = uuid.parse(req.params.id);
  if (key === 'products' && 'stock_quantity' in input) throw new ApiError(400, 'INVENTORY_ADJUSTMENT_REQUIRED', 'Use the inventory adjustment action to change stock with an audit reason.');
  if (key === 'pets' && 'status' in input) {
    const current = assertDb(await db().from('pets').select('status').eq('id', id).single());
    if (['reserved','adopted'].includes(current.status)) throw new ApiError(409, 'ADOPTION_WORKFLOW_REQUIRED', 'Pet availability is managed by the adoption workflow for this animal.');
  }
  if (key === 'drivers') { delete input.user_id; input.verified_by = req.actor!.id; }
  const data = assertDb(await db().from(resource.table).update(input).eq(resource.key ?? 'id', id).select().single());
  await audit(req.actor!.id, `${key}.updated`, resource.table, id);
  res.json({ data });
});
