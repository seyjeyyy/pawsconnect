import {describe,expect,it} from 'vitest';
import {maintenanceBlocks,effectiveMaintenance,serviceForPath,type OperationsConfig} from '../../server/src/modules/operations/maintenance';
import {tourFor} from '../../client/src/components/tour/steps';
const now=Date.parse('2026-10-11T10:00:00Z');
const config:OperationsConfig={version:1,mode:'full',modules:[],starts_at:'2026-10-11T09:00:00Z',ends_at:'2026-10-11T11:00:00Z',public_notice:'Maintenance',disabled_features:[],slow_request_ms:2000};
describe('trusted maintenance decisions',()=>{
 it('blocks reads and writes in full maintenance but preserves protected recovery and settlement',()=>{
  for(const method of ['GET','POST','PATCH','DELETE'])expect(maintenanceBlocks(config,method,'/orders',now)).toBe(true);
  for(const path of ['/auth/me','/health','/admin/operations/config','/operations/status','/webhooks/stripe'])expect(maintenanceBlocks(config,'POST',path,now),path).toBe(false);
  expect(maintenanceBlocks(config,'POST','/admin/operations-evil',now)).toBe(true);
 });
 it('expires automatically and does not activate future schedules',()=>{
  expect(effectiveMaintenance(config,now+86400000)).toBe(false);
  expect(maintenanceBlocks(config,'POST','/orders',now-86400000)).toBe(false);
 });
 it('enforces read-only and module-specific modes precisely',()=>{
  expect(maintenanceBlocks({...config,mode:'read_only'},'GET','/orders',now)).toBe(false);
  expect(maintenanceBlocks({...config,mode:'read_only'},'POST','/orders',now)).toBe(true);
  expect(maintenanceBlocks({...config,mode:'partial',modules:['transport']},'POST','/admin/transport/123/assignment',now)).toBe(true);
  expect(maintenanceBlocks({...config,mode:'partial',modules:['transport']},'POST','/stray-reports',now)).toBe(false);
 });
 it('flags pause writes without fabricating read results',()=>{
  expect(maintenanceBlocks({...config,mode:'normal',disabled_features:['shop']},'POST','/payments/create',now)).toBe(true);
  expect(maintenanceBlocks({...config,mode:'normal',disabled_features:['shop']},'GET','/products',now)).toBe(false);
  expect(serviceForPath('/api/admin/orders')).toBe('shop');
 });
 it.each([['donation','donations'],['adoption','adoption'],['transport','transport']])('blocks %s payment creation when its service is paused',(type,service)=>{
  expect(maintenanceBlocks({...config,mode:'partial',modules:[service]},'POST','/payments/create',now,type)).toBe(true);
  expect(maintenanceBlocks({...config,mode:'normal',disabled_features:[service]},'POST','/payments/create',now,type)).toBe(true);
  expect(maintenanceBlocks({...config,mode:'partial',modules:[service]},'POST','/payments/create',now,'order')).toBe(false);
 });
});
describe('role-specific onboarding',()=>{
 it('never sends a system administrator to shelter management',()=>{
  const tour=tourFor(['buyer','super_administrator']);
  expect(tour.key).toBe('system-v2');expect(tour.steps.some(s=>s.route.startsWith('/admin/operations'))).toBe(true);
  expect(tour.steps.some(s=>['/admin/orders','/admin/pets','/admin/overview'].includes(s.route))).toBe(false);
 });
 it.each([['shelter_driver','/admin/transport'],['rescue_personnel','/admin/rescue']])('gives %s only their authorized assignments', (role,path)=>{
  expect(tourFor([role]).steps.map(s=>s.route)).toEqual([path]);
 });
 it('gives veterinarians only animal and health tools',()=>expect(tourFor(['veterinarian']).steps.map(s=>s.route)).toEqual(['/admin/pets','/admin/health']));
});
