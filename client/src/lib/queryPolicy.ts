import type { QueryKey } from '@tanstack/react-query';

// Public/reference data is never polled. Visible private workflows get a bounded fallback.
export const privateRoots = new Set(['identity', 'account', 'account-overview', 'admin', 'cart', 'profile', 'addresses', 'volunteer', 'volunteer-tasks', 'my-applications', 'operations']);
export const isPrivateQuery = (key: QueryKey) => privateRoots.has(String(key[0]));
const resources: Record<string, string[]> = {
  orders: ['orders', 'payments', 'refunds', 'products', 'cart'],
  inventory: ['products', 'cart'], products: ['products', 'reviews', 'cart'], categories: ['products', 'categories'],
  pets: ['pets', 'favorites'], adoptions: ['adoptions', 'applications', 'pets'], 'adoption-applications': ['adoptions', 'applications', 'pets'],
  rescue: ['rescue', 'reports'], 'stray-reports': ['rescue', 'reports'], transport: ['transport', 'alternatives'],
  donations: ['donations', 'payments'], volunteers: ['volunteers', 'volunteer'], volunteer: ['volunteers', 'volunteer'],
  payments: ['payments', 'orders', 'donations', 'adoptions', 'applications', 'transport'],
  'refund-requests': ['refunds', 'payments'], 'favorite-pets': ['favorites'], wishlist: ['wishlist'],
  notifications: ['notifications'], contact_messages: ['contact_messages', 'messages'], contact: ['contact_messages', 'messages'],
  users: ['users', 'identity'], critical_approvals: ['critical_approvals', 'users', 'identity'],
};
export function affectedQuery(key: QueryKey, path: string): boolean {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  const resource = parts[0] === 'admin' ? parts[1] : parts[0];
  if (resource === 'operations') return key[0] === 'operations' || key[0] === 'operations-status';
  const affected = resources[resource] ?? [resource];
  const root = String(key[0]), section = String(key[1] ?? '');
  if (root === 'account-overview') return !['cart','profile','addresses'].includes(resource);
  if (root === 'identity') return affected.includes('identity') || resource === 'profile';
  if (root === 'account' || root === 'admin') return affected.includes(section) || ['overview', 'summary', 'analytics'].includes(section);
  if (root === 'lookup') return affected.includes(section);
  return affected.includes(root) || affected.includes(root.replace(/^(my-|catalog-|home-)/, '').replace(/-tasks$/, '')) ||
    (root === 'product' && affected.includes('products')) || (root === 'pet' && affected.includes('pets'));
}
