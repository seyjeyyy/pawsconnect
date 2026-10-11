import {describe,expect,it} from 'vitest';
import {homePath,signInPath} from '../../client/src/lib/roles';

describe('role landing and intended tasks',()=>{
 it('gives operational roles precedence over their community roles',()=>{
  for(const [role,path] of Object.entries({super_administrator:'/admin/security',administrator:'/admin/overview',shelter_staff:'/admin/overview',veterinarian:'/admin/pets',rescue_personnel:'/admin/rescue',shelter_driver:'/admin/transport',volunteer:'/account/volunteer'}))expect(homePath(['buyer','adopter',role])).toBe(path);
  expect(homePath(['buyer','adopter','donor'])).toBe('/account/overview');
 });
 it('resumes authorized tasks while rejecting another role workspace',()=>{
  expect(signInPath(['super_administrator'],'/admin/operations/backups')).toBe('/admin/operations/backups');
  expect(signInPath(['super_administrator'],'/admin/pets')).toBe('/admin/security');
  expect(signInPath(['shelter_driver'],'/admin/transport?page=2')).toBe('/admin/transport?page=2');
  expect(signInPath(['shelter_driver'],'/account/settings')).toBe('/account/settings');
  expect(signInPath(['shelter_driver'],'/checkout')).toBe('/admin/transport');
  expect(signInPath(['buyer'],'/checkout')).toBe('/checkout');
  expect(signInPath(['buyer'],'/admin/security')).toBe('/account/overview');
  expect(signInPath(['volunteer'],'/admin/rescue')).toBe('/admin/rescue');
 });
 it('does not return users to the public landing, auth loop or external locations',()=>{
  for(const path of [null,'/','/welcome','/auth/login','/auth/reset','//example.com','https://example.com','/\\example.com'])expect(signInPath(['administrator'],path)).toBe('/admin/overview');
 });
});
