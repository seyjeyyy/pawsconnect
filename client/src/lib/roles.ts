// What each role sees. The API enforces the same rules (server/src/modules/analytics/admin.ts);
// this file only decides which screens and menu items to show.

const staff = ['administrator', 'shelter_staff'];
const field = ['veterinarian', 'rescue_personnel', 'shelter_driver'];

/** Administrators and shelter staff: the full shelter workspace. */
export const isStaffRole = (roles: string[]) => roles.some(role => staff.includes(role));
/** Anyone whose account exists to do shelter work. They land in the workspace, not the customer dashboard. */
export const isOperational = (roles: string[]) => roles.some(role => staff.includes(role) || field.includes(role));

const administratorOnly = ['users', 'audit_logs'];
const staffSections = ['overview', 'products', 'categories', 'orders', 'pets', 'health', 'adoptions', 'rescue', 'transport', 'alternatives', 'zones', 'vehicles', 'drivers', 'donations', 'volunteers', 'expenses', 'contact_messages'];
const fieldSections: Record<string, string[]> = {
  veterinarian: ['pets', 'health'],
  rescue_personnel: ['rescue'],
  shelter_driver: ['transport'],
  // Approved volunteers can be assigned to a rescue; otherwise they use the customer dashboard.
  volunteer: ['rescue'],
};

/** Workspace sections this account may open, in menu order. Empty means no workspace access. */
export function workspaceSections(roles: string[]): string[] {
  if (roles.includes('administrator')) return [...staffSections, ...administratorOnly];
  if (roles.includes('shelter_staff')) return staffSections;
  return [...new Set(roles.flatMap(role => fieldSections[role] ?? []))];
}

/** Section titles as a field role sees them: their own work, not the shelter's whole list. */
export const fieldSectionLabels: Record<string, string> = {
  pets: 'Animals in care',
  health: 'Health records',
  rescue: 'My rescue assignments',
  transport: 'My transport jobs',
};

/** Status changes a field role may make. Staff get the full list defined beside the workspace tables. */
export const fieldStatusOptions: Record<string, string[]> = {
  rescue: ['in_progress', 'resolved'],
  transport: ['picked_up', 'in_transit', 'arrived'],
};

const titles: [string, string][] = [
  ['administrator', 'Administrator'], ['shelter_staff', 'Shelter staff'], ['veterinarian', 'Veterinarian'],
  ['rescue_personnel', 'Rescue personnel'], ['shelter_driver', 'Shelter driver'], ['volunteer', 'Volunteer'],
];
/** The most senior role the account holds, for display. */
export const roleTitle = (roles: string[]) => titles.find(([role]) => roles.includes(role))?.[1] ?? 'Member';

/** Where "my account" leads for this account. */
export const homePath = (roles: string[]) => isOperational(roles) ? '/admin' : '/account';
