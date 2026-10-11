import { describe, expect, it, vi } from 'vitest';
import { handleMaintenance } from '../../supabase/functions/maintenance/handler';
const config={url:'https://project.example.test',serviceKey:'test-only-service-key',cronSecret:'a-test-only-scheduler-secret-with-more-than-32-characters'};
const request=(secret=config.cronSecret)=>new Request('https://example.test/maintenance',{method:'POST',headers:{authorization:`Bearer ${secret}`}});
describe('maintenance Edge Function',()=>{
 it('rejects unauthenticated invocations before any database request',async()=>{
  const fetcher=vi.fn();const response=await handleMaintenance(request('anon-key'),config,fetcher);
  expect(response.status).toBe(401);expect(fetcher).not.toHaveBeenCalled();
 });
 it('reports the actual database expiry counts',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json(2)).mockResolvedValueOnce(Response.json(0));
  const response=await handleMaintenance(request(),config,fetcher);
  expect(await response.json()).toEqual({data:{expire_order_reservations:2,expire_pet_reservations:0}});
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('does not report successful maintenance when a database operation fails',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('unavailable',{status:503}));
  const response=await handleMaintenance(request(),config,fetcher);
  expect(response.status).toBe(503);expect((await response.json()).data).toBeUndefined();
 });
});
