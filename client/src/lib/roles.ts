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

const systemSections = ['security', 'security_alerts', 'security_events', 'critical_approvals', 'users', 'audit_logs', 'shelter_location'];
// Settings that only an administrator or the super administrator may open.
const administratorSections = ['shelter_location', 'transport_settings'];
const staffSections = ['overview', 'payments', 'refunds', 'reviews', 'products', 'categories', 'orders', 'pets', 'health', 'adoptions', 'rescue', 'transport', 'alternatives', 'zones', 'shelter_location', 'transport_settings', 'vehicles', 'drivers', 'donations', 'volunteers', 'expenses', 'contact_messages'];
const fieldSections: Record<string, string[]> = {
  veterinarian: ['pets', 'health'],
  rescue_personnel: ['rescue'],
  shelter_driver: ['transport'],
  // Approved volunteers can be assigned to a rescue; otherwise they use the customer dashboard.
  volunteer: ['rescue'],
};

/** Workspace sections this account may open, in menu order. Empty means no workspace access. */
export function workspaceSections(roles: string[], permissions?: string[]): string[] {
  // An account holding both kinds of role gets both sets; the demo accounts hold one each.
  const administrator = roles.includes('administrator') || roles.includes('super_administrator');
  const sections = [...new Set([
    ...(roles.includes('super_administrator') ? systemSections : []),
    ...(roles.includes('administrator') || roles.includes('shelter_staff') ? staffSections : []),
  ])].filter(section => administrator || !administratorSections.includes(section));
  const available = sections.length ? sections : [...new Set(roles.flatMap(role => fieldSections[role] ?? []))];
  return permissions === undefined ? available : available.filter(section => (roles.includes('super_administrator') && systemSections.includes(section)) || (section === 'overview' ? permissions.length > 0 : (sectionPermissions[section] || []).some(p=>permissions.includes(p))));
}

export const sectionPermissions: Record<string,string[]> = {
  pets:['animals.view'], health:['animals.health'],adoptions:['adoptions.review'],rescue:['rescue.manage','rescue.assigned'],
  transport:['transport.manage','transport.assigned'],alternatives:['transport.manage'],vehicles:['transport.manage'],drivers:['transport.manage'],
  products:['store.manage'],categories:['store.manage'],orders:['store.manage'],reviews:['store.manage'],
  payments:['finance.manage'],refunds:['finance.manage'],expenses:['finance.manage'],donations:['donations.view'],
  volunteers:['volunteers.manage'],zones:['zones.view','zones.manage'],shelter_location:['zones.manage'],transport_settings:['transport.manage'],contact_messages:['contacts.manage'],
};

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

/** The label shown for an account: its most senior role. Community roles are simply "User". */
const roleLabels: [string, string][] = [['super_administrator', 'Super administrator'], ['administrator', 'Administrator'], ['shelter_staff', 'Shelter staff'], ['veterinarian', 'Veterinarian'], ['rescue_personnel', 'Rescue personnel'], ['shelter_driver', 'Shelter driver'], ['volunteer', 'Volunteer']];
export const roleTitle = (roles: string[]) => roleLabels.find(([role]) => roles.includes(role))?.[1] ?? 'User';

/** Where "my account" leads for this account. */
export const homePath = (roles: string[], permissions?:string[]) => isOperational(roles) ? (workspaceSections(roles,permissions).length ? `/admin/${workspaceSections(roles,permissions)[0]}` : '/account/profile') : roles.includes('volunteer') ? '/account/volunteer' : '/account/overview';

/** Resume an intended task only when it belongs to this account's area. */
export function signInPath(roles: string[], next: string | null, permissions?:string[]) {
  const fallback = homePath(roles,permissions);
  if (!next?.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  const path = new URL(next, 'https://pawsconnect.invalid').pathname;
  if (path === '/' || path === '/welcome' || path.startsWith('/auth')) return fallback;
  if (path.startsWith('/admin')) {
    const section = path.split('/')[2];
    return workspaceSections(roles,permissions).includes(section) || (section === 'operations' && roles.includes('super_administrator')) ? next : fallback;
  }
  if (isOperational(roles) && !['/account/profile','/account/settings','/account/notifications'].includes(path)) return fallback;
  return next;
}
