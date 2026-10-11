import {describe,expect,it} from 'vitest';
import {workspaceAccess} from '../../server/src/modules/analytics/admin';
const check=(permissions:string[],path:string,method='GET',roles=['shelter_staff'])=>{
 let allowed=false;
 try{workspaceAccess({actor:{id:'test',roles,permissions},path,method} as any,{} as any,()=>{allowed=true;});}catch{/* expected refusal */}
 return allowed;
};
describe('staff module authorization',()=>{
 it('restricts adoption staff from finance, store, security and grants',()=>{
  expect(check(['adoptions.review'],'/adoptions')).toBe(true);
  for(const path of ['/payments','/analytics','/orders','/users','/security-summary','/unknown']) expect(check(['adoptions.review'],path)).toBe(false);
 });
 it('separates animal viewing from management and health records',()=>{
  expect(check(['animals.view'],'/pets')).toBe(true);
  expect(check(['animals.view'],'/pets','POST')).toBe(false);
  expect(check(['animals.view'],'/health')).toBe(false);
 });
 it('empty grants close shelter access and never grant system users shelter access',()=>{
  expect(check([],'/orders')).toBe(false);
  expect(check([],'/users','GET',['super_administrator'])).toBe(true);
  expect(check([],'/orders','GET',['super_administrator'])).toBe(false);
 });
 it('allows the overview for narrow staff grants without broadening module access',()=>{
  expect(check(['zones.view'],'/overview')).toBe(true);
  expect(check(['zones.view'],'/zones')).toBe(true);
  expect(check(['zones.view'],'/zones','POST')).toBe(false);
  expect(check(['zones.view'],'/payments')).toBe(false);
 });
});
