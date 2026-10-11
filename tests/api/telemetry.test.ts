import express,{Router} from 'express';
import request from 'supertest';
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({rpc:vi.fn(),fail:false}));
vi.mock('../../server/src/config/env',()=>({configured:true}));
vi.mock('../../server/src/config/supabase',()=>({db:()=>({rpc:state.rpc})}));
import {telemetry} from '../../server/src/modules/operations/telemetry';
beforeEach(()=>{state.fail=false;state.rpc.mockReset().mockImplementation(()=>({abortSignal:async()=>{if(state.fail)throw Error('private provider detail');return {error:null};}}));});
function app(){
 const app=express(),webhooks=Router();
 app.use(telemetry);app.use(express.json());
 webhooks.post('/stripe',(_req,res)=>res.json({data:{accepted:true}}));
 app.use('/api/webhooks',webhooks);
 app.post('/api/payments/create',(_req,res)=>res.status(201).json({data:{created:true}}));
 return app;
}
it('records safe aggregates from the original route after a nested router strips its prefix',async()=>{
 await request(app()).post('/api/webhooks/stripe?private=hidden').set('Authorization','Bearer secret-fixture').send({private:'do not store'}).expect(200);
 expect(state.rpc).toHaveBeenCalledWith('record_operations_telemetry',{p_service:'webhooks',p_status:2,p_duration:expect.any(Number),p_slow:false});
 expect(JSON.stringify(state.rpc.mock.calls)).not.toMatch(/secret-fixture|hidden|do not store/);
 await request(app()).post('/api/payments/create').send({resource_type:'donation'}).expect(201);
 expect(state.rpc.mock.calls[1][1].p_service).toBe('donations');
});
it('finishes the real response when telemetry storage fails without logging provider details',async()=>{
 state.fail=true;const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const response=await request(app()).post('/api/webhooks/stripe').expect(200);
  expect(response.body.data.accepted).toBe(true);
  expect(log).toHaveBeenCalledWith('Telemetry persistence unavailable');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private provider detail');
 }finally{log.mockRestore();}
});
