import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authorize } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid, safeSearch } from '../../utils/validation.js';

// Mounted behind authenticate + workspaceAccess, before the generic resource routes.
export const connectedAdminRouter = Router();
connectedAdminRouter.get('/lookups/:kind', async (req, res) => {
  const kind = z.enum(['rescuers','drivers','vehicles','pets','categories']).parse(req.params.kind);
  const { q } = z.object({ q: z.string().max(100).default('') }).parse(req.query);
  if (kind === 'rescuers' || kind === 'drivers') {
    res.json({data:assertDb(await db().rpc('workspace_people_lookup',{p_actor_id:req.actor!.id,p_kind:kind,p_search:safeSearch(q)}))});return;
  }
  const table = kind === 'vehicles' ? 'shelter_vehicles' : kind === 'categories' ? 'product_categories' : 'pets';
  let query = db().from(table).select('id,name').ilike('name', `%${safeSearch(q)}%`).order('name').limit(100);
  if (kind !== 'pets') query = query.eq('is_active', true);
  res.json({ data: assertDb(await query) });
});
connectedAdminRouter.post('/contact_messages/:id/reply', async (req, res) => {
  const { reply } = z.object({ reply: z.string().min(5).max(5000) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('reply_to_contact', { p_actor_id: req.actor!.id, p_message_id: uuid.parse(req.params.id), p_reply: reply })) });
});
connectedAdminRouter.post('/critical_approvals', authorize('super_administrator'), async (req, res) => {
  const input = z.object({ user_id: uuid, role_name: z.enum(['administrator','super_administrator']), enabled: z.boolean(), reason: z.string().min(10).max(2000) }).strict().parse(req.body);
  res.status(201).json({ data: assertDb(await db().from('critical_approvals').insert({ ...input, requested_by: req.actor!.id }).select().single()) });
});
connectedAdminRouter.post('/critical_approvals/:id/decision', authorize('super_administrator'), async (req, res) => {
  const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('decide_critical_approval', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_approve: approve })) });
});
connectedAdminRouter.post('/security_alerts/:id/resolve', authorize('super_administrator'), async (req, res) => {
  const { notes } = z.object({ notes: z.string().min(10).max(2000) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('resolve_security_alert', { p_actor_id: req.actor!.id, p_alert_id: uuid.parse(req.params.id), p_notes: notes })) });
});
connectedAdminRouter.get('/security-summary', authorize('super_administrator'), async (req, res) => {
  const [metrics, openSignals] = await Promise.all([db().rpc('security_metrics', { p_actor_id: req.actor!.id }), db().from('operations_signals').select('id', { count: 'exact', head: true }).eq('status', 'open')]);
  assertDb(openSignals);
  res.json({ data: { ...assertDb<Record<string, unknown>>(metrics), open_operational_signals: openSignals.count ?? 0 } });
});
