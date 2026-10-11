import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Product } from '../types';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';

export interface CartItem { id: string; product: Product; variant_id?: string; quantity: number }
type Cart = { items: CartItem[]; count: number; subtotal: number; loading: boolean; error: Error | null; busy: boolean; retry: () => void;
  add: (p: Product, q?: number, variant?: string) => Promise<void>; update: (id: string, q: number) => Promise<void>; remove: (id: string) => Promise<void>; clear: () => Promise<void> };
type StoredCart = { items: { id: string; products: Product; variant_id?: string; quantity: number; product_variants?: { name: string; price_centavos: number; stock_quantity: number; reserved_quantity: number } }[] };
const Context = createContext<Cart | null>(null);
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth(); const cache = useQueryClient(); const lock = useRef(false); const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['cart', user?.id], enabled: !!user, queryFn: ({signal}) => api<StoredCart>('/cart',{signal}) });
  const items: CartItem[] = user ? (query.data?.items || []).map(row => ({ id: row.id, variant_id: row.variant_id, quantity: row.quantity, product: row.product_variants ? { ...row.products, ...row.product_variants, id: row.products.id, name: `${row.products.name} · ${row.product_variants.name}` } : row.products })) : [];
  async function mutate(path: string, method: string, body?: unknown, success?: string) {
    if (!user) { toast.info('Sign in to save a shopping cart to your account.'); return; }
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); await cache.invalidateQueries({ queryKey: ['cart', user.id] },{cancelRefetch:false}); if (success) toast.success(success); }
    catch (failure) { toast.error((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  const value: Cart = { items, count: items.reduce((n, i) => n + i.quantity, 0), subtotal: items.reduce((n, i) => n + i.quantity * i.product.price_centavos, 0), loading: !!user && query.isPending, error: query.error, busy, retry: () => { void query.refetch(); },
    async add(product, quantity = 1, variant) { const existing = items.find(i => i.product.id === product.id && (i.variant_id || undefined) === variant); await mutate('/cart/items', 'POST', { product_id: product.id, variant_id: variant, quantity: quantity + (existing?.quantity || 0) }, `${product.name} added to your cart`); },
    async update(id, quantity) { await mutate(`/cart/items/${id}`, 'PATCH', { quantity }); },
    async remove(id) { await mutate(`/cart/items/${id}`, 'DELETE'); },
    async clear() { await mutate('/cart', 'DELETE'); },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCart() { const value = useContext(Context); if (!value) throw new Error('CartProvider missing'); return value; }
