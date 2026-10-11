import { z } from 'zod';
export const uuid = z.string().uuid();
export const money = z.number().int().min(0).max(100_000_000);
export const point = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
export const location = point.extend({ address: z.string().min(5).max(500), province: z.string().min(2).max(100), city: z.string().min(2).max(100), barangay: z.string().max(100).default('') });
export const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(24), q: z.string().max(100).optional() });
export const addressSchema = point.extend({ label: z.string().min(1).max(80).default('Home'), is_default: z.boolean().default(false), recipient_name: z.string().min(2).max(120), phone: z.string().min(7).max(30), line1: z.string().min(5).max(500), barangay: z.string().max(100), city: z.string().min(2).max(100), province: z.string().min(2).max(100), postal_code: z.string().max(12), instructions: z.string().max(1000).default('') }).strict();
export const safeSearch = (value: string) => value.replace(/[%_(),.]/g, '').trim();
