import { Router } from 'express';
import { z } from 'zod';
import { configured } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { pagination, safeSearch } from '../../utils/validation.js';
import { sampleCategories, samplePets, sampleProducts } from './sample.js';

export const catalogRouter = Router();
catalogRouter.get('/categories', async (_req, res) => {
  const data = configured ? assertDb(await db().from('product_categories').select('*').order('name')) : sampleCategories;
  res.json({ data, meta: { sample: !configured } });
});
catalogRouter.get('/products', async (req, res) => {
  const { page, limit, q } = pagination.parse(req.query);
  const filters = z.object({ category: z.string().optional(), sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest') }).parse(req.query);
  if (!configured) {
    let data = sampleProducts.filter(p => (!q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase())) && (!filters.category || p.category_id === filters.category || sampleCategories.find(c => c.slug === filters.category)?.id === p.category_id));
    if (filters.sort.startsWith('price')) data = [...data].sort((a, b) => filters.sort === 'price_asc' ? a.price_centavos - b.price_centavos : b.price_centavos - a.price_centavos);
    if (filters.sort === 'name') data = [...data].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ data: data.slice((page - 1) * limit, page * limit), meta: { sample: true, page, limit, total: data.length } }); return;
  }
  let query = db().from('products').select('*,product_categories(name,slug)', { count: 'exact' }).eq('is_published', true);
  if (q) query = query.ilike('name', `%${safeSearch(q)}%`);
  if (filters.category) query = query.eq('category_id', filters.category);
  const column = filters.sort.startsWith('price') ? 'price_centavos' : filters.sort === 'name' ? 'name' : 'created_at';
  const result = await query.order(column, { ascending: ['name', 'price_asc'].includes(filters.sort) }).range((page - 1) * limit, page * limit - 1);
  const data = assertDb<{ is_sample: boolean }[]>(result);
  res.json({ data, meta: { sample: data.some(p => p.is_sample), page, limit, total: result.count } });
});
catalogRouter.get('/products/:id', async (req, res) => {
  const id = z.string().max(150).parse(req.params.id);
  const data = configured ? assertDb(await db().from('products').select('*,product_categories(name,slug),product_images(*),product_variants(*)').eq('is_published', true).eq(z.string().uuid().safeParse(id).success ? 'id' : 'slug', id).single()) : sampleProducts.find(p => p.id === id || p.slug === id);
  if (!data) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  res.json({ data, meta: { sample: !configured || data.is_sample } });
});
catalogRouter.get('/products/:id/reviews', async (req, res) => {
  const data = configured ? assertDb(await db().from('customer_reviews').select('id,rating,comment:body,created_at').eq('product_id', z.string().uuid().parse(req.params.id)).eq('is_approved', true).order('created_at', { ascending: false }).limit(100)) : [];
  res.json({ data, meta: { sample: !configured } });
});
catalogRouter.get('/pets', async (req, res) => {
  const { page, limit, q } = pagination.parse(req.query);
  const { species, size } = z.object({ species: z.enum(['dog', 'cat', 'other']).optional(), size: z.enum(['small', 'medium', 'large']).optional() }).parse(req.query);
  if (!configured) {
    const data = samplePets.filter(p => (!q || p.name.toLowerCase().includes(q.toLowerCase())) && (!species || p.species === species) && (!size || p.size === size));
    res.json({ data: data.slice((page - 1) * limit, page * limit), meta: { sample: true, total: data.length, page, limit } }); return;
  }
  let query = db().from('pets').select('*,pet_behavior_profiles(*)', { count: 'exact' }).eq('is_published', true);
  if (species) query = query.eq('species', species);
  if (size) query = query.eq('size', size);
  if (q) query = query.ilike('name', `%${safeSearch(q)}%`);
  const result = await query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const data = assertDb<{ is_sample: boolean }[]>(result);
  res.json({ data, meta: { sample: data.some(p => p.is_sample), total: result.count, page, limit } });
});
catalogRouter.get('/pets/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const data = configured ? assertDb(await db().from('pets').select('*,pet_photos(*),pet_behavior_profiles(*)').eq('id', id).eq('is_published', true).single()) : samplePets.find(p => p.id === id);
  if (!data) throw new ApiError(404, 'NOT_FOUND', 'Pet profile not found.');
  res.json({ data, meta: { sample: !configured || data.is_sample } });
});
