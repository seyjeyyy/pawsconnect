import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { assertDb } from '../../utils/errors.js';
import { pagination, safeSearch, uuid } from '../../utils/validation.js';

// The service role bypasses column grants: explicitly keep acquisition costs private.
export const publicProductColumns = 'id,category_id,name,slug,description,sku,price_centavos,stock_quantity,reserved_quantity,image_url,specifications,is_published,is_sample,created_at,updated_at';
export const publicBehaviorColumns = 'energy_level,temperament,suitable_homes,good_with_children,good_with_dogs,good_with_cats,care_hours_daily,max_hours_alone,experience_required,grooming_level,exercise_minutes,needs_outdoor_space,verified_at';
export const catalogRouter = Router();
catalogRouter.get('/categories', async (_req, res) => {
  res.json({ data: assertDb(await db().from('product_categories').select('*').eq('is_active', true).order('name')) });
});
catalogRouter.get('/products', async (req, res) => {
  const { page, limit, q } = pagination.parse(req.query);
  const filters = z.object({ category: uuid.optional(), sort: z.enum(['newest','price_asc','price_desc','name']).default('newest'), in_stock: z.enum(['true','false']).optional() }).parse(req.query);
  let query = db().from('products').select(`${publicProductColumns},product_categories(name,slug)`, { count: 'exact' }).eq('is_published', true).eq('is_sample', false);
  if (q) query = query.ilike('name', `%${safeSearch(q)}%`);
  if (filters.category) query = query.eq('category_id', filters.category);
  if (filters.in_stock === 'true') query = query.gt('available_quantity', 0);
  const column = filters.sort.startsWith('price') ? 'price_centavos' : filters.sort === 'name' ? 'name' : 'created_at';
  const result = await query.order(column, { ascending: ['name','price_asc'].includes(filters.sort) }).order('id').range((page - 1) * limit, page * limit - 1);
  res.json({ data: assertDb(result), meta: { page, limit, total: result.count } });
});
catalogRouter.get('/products/:id', async (req, res) => {
  const id = z.string().max(150).parse(req.params.id);
  const data = assertDb(await db().from('products').select(`${publicProductColumns},product_categories(name,slug),product_images(*),product_variants(*)`).eq('is_published', true).eq('is_sample', false).eq(uuid.safeParse(id).success ? 'id' : 'slug', id).single());
  data.product_variants = data.product_variants.filter((v: { is_active: boolean }) => v.is_active);
  res.json({ data });
});
catalogRouter.get('/products/:id/reviews', async (req, res) => {
  const product = assertDb(await db().from('products').select('id').eq(uuid.safeParse(req.params.id).success ? 'id' : 'slug', req.params.id).eq('is_published', true).eq('is_sample', false).single());
  res.json({ data: assertDb(await db().from('customer_reviews').select('id,rating,comment:body,created_at').eq('product_id', product.id).eq('is_approved', true).order('created_at', { ascending: false }).limit(100)) });
});
catalogRouter.get('/pets', async (req, res) => {
  const { page, limit, q } = pagination.parse(req.query);
  const filters = z.object({ species: z.enum(['dog','cat','other']).optional(), size: z.enum(['small','medium','large']).optional(), sex: z.enum(['male','female','unknown']).optional() }).parse(req.query);
  let query = db().from('pets').select(`*,pet_behavior_profiles(${publicBehaviorColumns})`, { count: 'exact' }).eq('is_published', true).eq('is_sample', false).eq('status', 'available');
  for (const [key, value] of Object.entries(filters)) if (value) query = query.eq(key, value);
  if (q) query = query.ilike('name', `%${safeSearch(q)}%`);
  const result = await query.order('created_at', { ascending: false }).order('id').range((page - 1) * limit, page * limit - 1);
  res.json({ data: assertDb(result), meta: { page, limit, total: result.count } });
});
catalogRouter.get('/pets/:id', async (req, res) => {
  res.json({ data: assertDb(await db().from('pets').select(`*,pet_photos(*),pet_behavior_profiles(${publicBehaviorColumns})`).eq('id', uuid.parse(req.params.id)).eq('is_published', true).eq('is_sample', false).in('status', ['available','reserved','adopted']).single()) });
});
