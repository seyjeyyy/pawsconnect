import {describe,expect,it} from 'vitest';
import {affectedQuery,isPrivateQuery} from '../../client/src/lib/queryPolicy';
describe('targeted synchronization',()=>{
 it('cart writes leave identity, public listings and staff records alone',()=>{
  expect(affectedQuery(['cart','owner'],'/cart/items')).toBe(true);
  for(const key of [['identity','owner'],['products'],['admin','pets'],['health']]) expect(affectedQuery(key,'/cart/items')).toBe(false);
 });
 it('adoption changes refresh linked pet and application views',()=>{
  for(const key of [['account','applications','owner'],['admin','adoptions'],['pets'],['admin','overview']]) expect(affectedQuery(key,'/admin/adoptions/id/status')).toBe(true);
  expect(affectedQuery(['admin','orders'],'/admin/adoptions/id/status')).toBe(false);
 });
 it('permission changes invalidate identity and private roots exclude public references',()=>{
  expect(affectedQuery(['identity','owner'],'/admin/users/id/permissions')).toBe(true);
  for(const key of [['categories'],['lookup','pets'],['health'],['products']]) expect(isPrivateQuery(key)).toBe(false);
 });
});
