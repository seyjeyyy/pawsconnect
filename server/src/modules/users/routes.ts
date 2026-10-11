import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, publicAuth } from '../../config/supabase.js';
import { authenticate, optionalAuth, isStaff } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { addressSchema, uuid } from '../../utils/validation.js';

export const userRouter = Router();
userRouter.post('/auth/register', async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(10).max(128), full_name: z.string().min(2).max(120) }).strict().parse(req.body);
  const { data, error } = await publicAuth().auth.signUp({ email: input.email, password: input.password, options: { data: { full_name: input.full_name }, emailRedirectTo: `${env.CLIENT_URL}/auth/callback` } });
  if (error) throw new ApiError(400, 'REGISTRATION_FAILED', error.message);
  res.status(201).json({ data: { user_id: data.user?.id, verification_required: !data.session } });
});
userRouter.post('/newsletter', async (req, res) => {
  const { email } = z.object({ email: z.string().email().max(254) }).strict().parse(req.body);
  assertDb(await db().from('newsletter_subscriptions').upsert({ email: email.toLowerCase(), consent_at: new Date().toISOString(), unsubscribed_at: null }, { onConflict: 'email' }));
  res.status(201).json({ data: { subscribed: true, message: 'Your newsletter request has been saved.' } });
});
userRouter.post('/contact', optionalAuth, async (req, res) => {
  const input = z.object({ name: z.string().min(2).max(120), email: z.string().email().max(254), message: z.string().min(10).max(5000) }).strict().parse(req.body);
  assertDb(await db().from('contact_messages').insert({ ...input, user_id: req.actor?.id ?? null }));
  res.status(201).json({ data: { received: true, message: 'Your message has been saved for the shelter team.' } });
});
userRouter.get('/auth/me', authenticate, async (req, res) => {
  const profile = assertDb(await db().from('profiles').select('*').eq('id', req.actor!.id).single());
  res.json({ data: { ...profile, email: req.actor!.email, roles: req.actor!.roles } });
});
userRouter.get('/profile', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('profiles').select('*').eq('id', req.actor!.id).single()) });
});
userRouter.patch('/profile', authenticate, async (req, res) => {
  const input = z.object({ full_name: z.string().min(2).max(120), phone: z.string().max(30).nullable().optional() }).strict().parse(req.body);
  res.json({ data: assertDb(await db().from('profiles').update(input).eq('id', req.actor!.id).select().single()) });
});
userRouter.get('/addresses', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('customer_addresses').select('*').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
userRouter.post('/addresses', authenticate, async (req, res) => {
  const input = addressSchema.parse(req.body);
  res.status(201).json({ data: assertDb(await db().from('customer_addresses').insert({ ...input, user_id: req.actor!.id }).select().single()) });
});
userRouter.patch('/addresses/:id', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('customer_addresses').update(addressSchema.partial().parse(req.body)).eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id).select().single()) });
});
userRouter.delete('/addresses/:id', authenticate, async (req, res) => {
  assertDb(await db().from('customer_addresses').delete().eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id));
  res.json({ data: { deleted: true } });
});
userRouter.get('/notifications', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('notifications').select('*').eq('user_id', req.actor!.id).order('created_at', { ascending: false }).limit(100)) });
});
userRouter.patch('/notifications/:id', authenticate, async (req, res) => {
  z.object({ read: z.literal(true) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id).select().single()) });
});
userRouter.get('/payments/mine', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('payment_transactions').select('id,resource_type,resource_id,amount_centavos,currency,status,created_at,paid_at').eq('user_id', req.actor!.id).order('created_at', { ascending: false }).limit(100)) });
});
const uploadSchema = z.object({ bucket: z.enum(['rescue-evidence', 'adoption-documents', 'listing-images']), filename: z.string().min(1).max(200), content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']), size: z.number().int().positive().max(5 * 1024 * 1024) }).strict();
userRouter.post('/uploads/signed-url', authenticate, async (req, res) => {
  const input = uploadSchema.parse(req.body);
  if (input.bucket === 'listing-images' && !isStaff(req.actor!.roles)) throw new ApiError(403, 'FORBIDDEN', 'Only shelter staff may upload public listing images.');
  if (input.content_type === 'application/pdf' && input.bucket !== 'adoption-documents') throw new ApiError(400, 'INVALID_FILE_TYPE', 'This bucket accepts images only.');
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const path = `${req.actor!.id}/${randomUUID()}.${extensions[input.content_type]}`;
  const signed = assertDb(await db().storage.from(input.bucket).createSignedUploadUrl(path));
  res.status(201).json({ data: { bucket: input.bucket, path, signed_url: signed.signedUrl, token: signed.token } });
});
userRouter.post('/uploads/read-url', authenticate, async (req, res) => {
  const { bucket, path } = z.object({ bucket: z.enum(['rescue-evidence', 'adoption-documents']), path: z.string().max(500).regex(/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/) }).strict().parse(req.body);
  if (!path.startsWith(`${req.actor!.id}/`) && !isStaff(req.actor!.roles)) {
    let allowed = false;
    if (bucket === 'rescue-evidence' && req.actor!.roles.some(role => ['rescue_personnel','volunteer'].includes(role))) {
      const photo = assertDb(await db().from('stray_report_photos').select('report_id').eq('storage_path', path).maybeSingle());
      if (photo) allowed = Boolean(assertDb(await db().from('rescue_assignments').select('id').eq('report_id', photo.report_id).eq('assigned_to', req.actor!.id).in('status', ['assigned','in_progress','completed']).maybeSingle()));
    }
    if (!allowed) throw new ApiError(403, 'FORBIDDEN', 'You cannot access this private document.');
  }
  const data = assertDb(await db().storage.from(bucket).createSignedUrl(path, 120));
  res.json({ data: { signed_url: data.signedUrl, expires_in: 120 } });
});
