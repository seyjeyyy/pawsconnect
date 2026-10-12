import { expect, it } from 'vitest';
import { workspaceSections } from '../../client/src/lib/roles';

// The Shelter location screen is offered only to accounts the API lets change it.
const community = ['buyer', 'adopter', 'donor', 'community_reporter'];
const adminModules = ['animals.view', 'transport.manage', 'zones.view', 'zones.manage'];
it('shows the shelter location setting to administrators and the super administrator only', () => {
  expect(workspaceSections([...community, 'administrator'], adminModules)).toContain('shelter_location');
  expect(workspaceSections([...community, 'super_administrator'], [])).toContain('shelter_location');
  // An administrator whose assignment no longer includes the zones module.
  expect(workspaceSections([...community, 'administrator'], ['animals.view', 'transport.manage'])).not.toContain('shelter_location');
  for (const role of ['shelter_staff', 'veterinarian', 'rescue_personnel', 'shelter_driver', 'volunteer']) {
    expect(workspaceSections([...community, role], adminModules), role).not.toContain('shelter_location');
    expect(workspaceSections([...community, role]), role).not.toContain('shelter_location');
  }
  expect(workspaceSections(community)).toEqual([]);
});
it('lists the section once for an account holding both administrator roles', () => {
  const sections = workspaceSections(['administrator', 'super_administrator'], adminModules);
  expect(sections.filter(section => section === 'shelter_location')).toHaveLength(1);
});
it('shows transport pricing to administrators holding the transport module only', () => {
  expect(workspaceSections([...community, 'administrator'], adminModules)).toContain('transport_settings');
  expect(workspaceSections([...community, 'administrator'], ['animals.view', 'zones.manage'])).not.toContain('transport_settings');
  for (const role of ['shelter_staff', 'shelter_driver', 'veterinarian']) expect(workspaceSections([...community, role], adminModules), role).not.toContain('transport_settings');
  expect(workspaceSections([...community, 'super_administrator'], [])).not.toContain('transport_settings');
});
