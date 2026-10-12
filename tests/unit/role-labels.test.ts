import { expect, it } from 'vitest';
import { roleTitle } from '../../client/src/lib/roles';

// The label in the header, sidebar and People & access table is the account's real role.
const community = ['buyer', 'adopter', 'donor', 'community_reporter'];
it('labels every role by name, with the most senior role winning', () => {
  const expected: Record<string, string> = { super_administrator: 'Super administrator', administrator: 'Administrator', shelter_staff: 'Shelter staff', veterinarian: 'Veterinarian', rescue_personnel: 'Rescue personnel', shelter_driver: 'Shelter driver', volunteer: 'Volunteer' };
  for (const [role, label] of Object.entries(expected)) expect(roleTitle([...community, role]), role).toBe(label);
  for (const role of community) expect(roleTitle([role]), role).toBe('User');
  expect(roleTitle([])).toBe('User');
  expect(roleTitle([...community, 'volunteer', 'shelter_staff', 'administrator'])).toBe('Administrator');
});
