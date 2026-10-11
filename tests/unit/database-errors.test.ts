import {afterEach,expect,it,vi} from 'vitest';
import {ApiError,assertDb} from '../../server/src/utils/errors';
afterEach(()=>vi.restoreAllMocks());
it.each(['PGRST202','PGRST204','PGRST205','42P01','42703','42883'])('identifies schema mismatch %s without exposing provider details',code=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 let failure:unknown;
 try{assertDb({data:null,error:{code,message:'private database detail'}});}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(ApiError);
 expect(failure).toMatchObject({status:503,code:'DEPLOYMENT_SCHEMA_MISMATCH'});
 expect((failure as Error).message).not.toContain('private database detail');
});
it('preserves transient outage and business-rule handling',()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 expect(()=>assertDb({data:null,error:{code:'08006',message:'connection failure'}})).toThrow(expect.objectContaining({code:'DATABASE_UNAVAILABLE'}));
 expect(()=>assertDb({data:null,error:{code:'P0001',message:'Reservation expired'}})).toThrow(expect.objectContaining({code:'BUSINESS_RULE',message:'Reservation expired'}));
});
