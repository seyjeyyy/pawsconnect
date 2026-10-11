// What each role sees. The API enforces the same rules (server/src/modules/analytics/admin.ts);
// this file only decides which screens and menu items to show.
//
// Two separate lines of authority: the super administrator runs the system (accounts and
// access, audit trail, security) and has no shelter screens; the administrator and shelter
// staff run the shelter and have no system screens.

const staff = ['super_administrator', 'administrator', 'shelter_staff'];
const field = ['veterinarian', 'rescue_personnel', 'shelter_driver'];

/** Accounts that manage records in the workspace (as opposed to field roles, who only update work assigned to them). Which records is decided by workspaceSections. */
export const isStaffRole = (roles: string[]) => roles.some(role => staff.includes(role));
/** Anyone whose account exists to do shelter work. They land in the workspace, not the customer dashboard. */
export const isOperational = (roles: string[]) => roles.some(role => staff.includes(role) || field.includes(role));

const systemSections = ['security', 'security_alerts', 'security_events', 'critical_approvals', 'users', 'audit_logs'];
const staffSections = ['overview', 'payments', 'refunds', 'reviews', 'products', 'categories', 'orders', 'pets', 'health', 'adoptions', 'rescue', 'transport', 'alternatives', 'zones', 'vehicles', 'drivers', 'donations', 'volunteers', 'expenses', 'contact_messages'];
const fieldSections: Record<string, string[]> = {
  veterinarian: ['pets', 'health'],
  rescue_personnel: ['rescue'],
  shelter_driver: ['transport'],
  // Approved volunteers can be assigned to a rescue; otherwise they use the customer dashboard.
  volunteer: ['rescue'],
};

/** Workspace sections this account may open, in menu order. Empty means no workspace access. */
export function workspaceSections(roles: string[]): string[] {
  // An account holding both kinds of role gets both sets; the demo accounts hold one each.
  const sections = [
    ...(roles.includes('super_administrator') ? systemSections : []),
    ...(roles.includes('administrator') || roles.includes('shelter_staff') ? staffSections : []),
  ];
  if (sections.length) return sections;
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
  ['super_administrator', 'Super administrator'], ['administrator', 'Administrator'], ['shelter_staff', 'Shelter staff'], ['veterinarian', 'Veterinarian'],
  ['rescue_personnel', 'Rescue personnel'], ['shelter_driver', 'Shelter driver'], ['volunteer', 'Volunteer'],
];
/** The most senior role the account holds, for display. */
export const roleTitle = (roles: string[]) => titles.find(([role]) => roles.includes(role))?.[1] ?? 'Member';

/** Where "my account" leads for this account. */
export const homePath = (roles: string[]) => isOperational(roles) ? '/admin' : '/account';
