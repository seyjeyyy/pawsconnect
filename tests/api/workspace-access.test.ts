import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { workspaceAccess } from '../../server/src/modules/analytics/admin';

// The workspace API is one router. This guard decides, per role, which of its
// routes a request may reach. (List handlers then narrow rescue and transport
// to the actor's own assignments, and the database functions re-check ownership.)
const id = '0b6f2f0e-6a3c-4d0e-9d55-3f2b1c7a9e10';
function allowed(roles: string[], method: string, path: string) {
  let passed = false;
  const req = { method, path, actor: { id: 'actor', roles } } as unknown as Request;
  try { workspaceAccess(req, {} as Response, (() => { passed = true; }) as NextFunction); } catch { return false; }
  return passed;
}
const community = ['buyer', 'adopter', 'donor', 'community_reporter'];

describe('workspace access by role', () => {
  // Shelter operations and system administration are separate lines of authority.
  const shelterRoutes = [['GET', '/analytics'], ['GET', '/orders'], ['GET', '/rescue'], ['GET', '/pets'], ['GET', '/payments'], ['GET', '/donations'], ['POST', '/products'], ['PATCH', `/orders/${id}/status`], ['POST', '/inventory'], ['POST', '/health'], ['POST', '/zones'], ['GET', '/lookups/pets']];
  const systemRoutes = [['GET', '/security-summary'], ['GET', '/security_events'], ['GET', '/security_alerts'], ['GET', '/critical_approvals'], ['GET', '/users'], ['GET', '/audit_logs'], ['POST', '/critical_approvals'], ['POST', `/critical_approvals/${id}/decision`], ['POST', `/security_alerts/${id}/resolve`], ['POST', `/users/${id}/roles`], ['DELETE', `/users/${id}/roles/volunteer`]];

  it.each([['administrator'], ['shelter_staff']])('%s reaches every shelter route and no system route', (role) => {
    for (const [method, path] of shelterRoutes) expect(allowed([...community, role], method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of systemRoutes) expect(allowed([...community, role], method, path), `${method} ${path}`).toBe(false);
  });

  it('the super administrator reaches every system route and no shelter route', () => {
    const roles = [...community, 'super_administrator'];
    for (const [method, path] of systemRoutes) expect(allowed(roles, method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of shelterRoutes) expect(allowed(roles, method, path), `${method} ${path}`).toBe(false);
  });

  it('system routes are closed to field roles and customers too', () => {
    for (const role of ['veterinarian', 'rescue_personnel', 'shelter_driver', 'volunteer', 'buyer']) {
      for (const [method, path] of systemRoutes) expect(allowed([...community, role], method, path), `${role} ${method} ${path}`).toBe(false);
    }
  });

  it('customers reach nothing', () => {
    for (const [method, path] of [['GET', '/analytics'], ['GET', '/orders'], ['GET', '/pets'], ['GET', '/rescue'], ['GET', '/transport'], ['POST', '/health'], ['PATCH', `/rescue/${id}/status`]]) {
      expect(allowed(community, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('a veterinarian reaches animals and health records only', () => {
    const roles = [...community, 'veterinarian'];
    expect(allowed(roles, 'GET', '/pets')).toBe(true);
    expect(allowed(roles, 'GET', '/health')).toBe(true);
    expect(allowed(roles, 'POST', '/health')).toBe(true);
    expect(allowed(roles, 'PATCH', `/pets/${id}/behavior`)).toBe(true);
    for (const [method, path] of [['GET', '/analytics'], ['GET', '/orders'], ['GET', '/users'], ['GET', '/donations'], ['GET', '/rescue'], ['GET', '/transport'], ['POST', '/pets'], ['PATCH', `/pets/${id}`], ['POST', '/inventory'], ['PATCH', `/orders/${id}/status`]]) {
      expect(allowed(roles, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('rescue personnel reach rescue reports and their status only', () => {
    const roles = [...community, 'rescue_personnel'];
    expect(allowed(roles, 'GET', '/rescue')).toBe(true);
    expect(allowed(roles, 'PATCH', `/rescue/${id}/status`)).toBe(true);
    for (const [method, path] of [['GET', '/analytics'], ['GET', '/transport'], ['GET', '/pets'], ['GET', '/orders'], ['POST', `/rescue/${id}/assign`], ['PATCH', `/transport/${id}/status`]]) {
      expect(allowed(roles, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('a driver reaches transport jobs and their status only', () => {
    const roles = [...community, 'shelter_driver'];
    expect(allowed(roles, 'GET', '/transport')).toBe(true);
    expect(allowed(roles, 'PATCH', `/transport/${id}/status`)).toBe(true);
    for (const [method, path] of [['GET', '/analytics'], ['GET', '/rescue'], ['GET', '/vehicles'], ['GET', '/drivers'], ['POST', `/transport/${id}/quote`], ['PATCH', `/transport/${id}/assignment`], ['POST', `/transport/${id}/handover`]]) {
      expect(allowed(roles, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('a volunteer reaches only rescue reports (assigned ones are filtered later)', () => {
    const roles = [...community, 'volunteer'];
    expect(allowed(roles, 'GET', '/rescue')).toBe(true);
    for (const [method, path] of [['GET', '/analytics'], ['GET', '/volunteers'], ['GET', '/pets'], ['POST', `/volunteers/${id}/tasks`]]) {
      expect(allowed(roles, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('does not match look-alike paths', () => {
    const roles = [...community, 'rescue_personnel'];
    expect(allowed(roles, 'PATCH', '/rescue/not-an-id/status')).toBe(false);
    expect(allowed(roles, 'PATCH', `/rescue/${id}/status/extra`)).toBe(false);
    expect(allowed(roles, 'DELETE', `/rescue/${id}/status`)).toBe(false);
    expect(allowed(roles, 'GET', '/rescue/')).toBe(true);
  });

  it('an unauthenticated request never passes', () => {
    const req = { method: 'GET', path: '/pets' } as unknown as Request;
    expect(() => workspaceAccess(req, {} as Response, (() => {}) as NextFunction)).toThrow();
  });
});
