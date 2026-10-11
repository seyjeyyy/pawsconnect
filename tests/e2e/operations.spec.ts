import {expect,test,type Page} from '@playwright/test';
// Browser-only fixtures. Every backend call stays intercepted on the isolated
// preview server. Production authentication contains no test bypass.
async function fixture(page:Page,role='super_administrator'){
 const user={id:'00000000-0000-4000-8000-000000000010',email:'fixture@example.test'};
 await page.route('**/src/lib/supabase.ts',route=>route.fulfill({contentType:'application/javascript',body:`const user=${JSON.stringify(user)};const channel={on(){return channel},subscribe(){return channel}};export const supabase={auth:{getSession:async()=>({data:{session:{user,access_token:'browser-fixture'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal2'}}),listFactors:async()=>({data:{totp:[]}})}},channel:()=>channel,removeChannel:async()=>{}};` }));
 const config={version:1,mode:'normal',modules:[],starts_at:null,ends_at:null,public_notice:'',instructions:'',reason:'',disabled_features:[],slow_request_ms:2000,backup_interval_hours:null,retention_days:30,rpo_minutes:1440,rto_minutes:240};
 const writes:unknown[]=[];
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  let data:unknown=[],meta:unknown=undefined;
  if(path==='/api/auth/me')data={...user,full_name:'Fixture operator',roles:[role]};
  else if(path==='/api/cart')data={items:[]};
  else if(path==='/api/health')data={status:'ok',payment_mode:'unavailable'};
  else if(path==='/api/operations/status')data={active:false};
  else if(path.includes('/operations/tour/'))data=null;
  else if(path==='/api/admin/operations/overview')data={checked_at:new Date().toISOString(),database:{latency_ms:3,database_bytes:1000,unresolved_incidents:0,schema_version:'016'},config,worker_kinds:[],integrations:{supabase:'Fixture only'},deployment:{commit:null,date:null,environment:'isolated browser fixture',history_available:false},unavailable:['Fixture: provider metrics unavailable']};
  else if(path==='/api/admin/operations/managed-backups')data={configured:false,backups:[],note:'Fixture: secure backup worker is unconfigured'};
  else if(path==='/api/admin/operations/config'&&request.method()==='PUT'){writes.push(request.postDataJSON());data={version:2};}
  else if(path.includes('/records/')){data=[];meta={total:0,page:1,limit:20};}
  else if(path==='/api/admin/security-summary')data={source_note:'Isolated fixture',open_alerts:0};
  await route.fulfill({json:{data,...(meta?{meta}: {})}});
 });
 return writes;
}
test('all IT modules render, have bounded layouts and show unconfigured integrations honestly',async({page})=>{
 test.setTimeout(60_000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page);
 for(const section of ['','/monitoring','/incidents','/health','/jobs','/integrations','/backups','/recovery','/maintenance','/deployments','/configuration']){
  await page.goto(`/admin/operations${section}`);await expect(page.locator('.dashboard-main h1')).toBeVisible();
  await expect(page.getByText('Checked ',{exact:false}).first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),section).toBeLessThanOrEqual(0);
 }
 await page.goto('/admin/operations/backups');await expect(page.getByRole('button',{name:'Review request'})).toBeDisabled();
 await page.screenshot({path:`test-results/operations-${test.info().project.name}.png`,fullPage:true});
 expect(errors).toEqual([]);
});
test('maintenance confirmation cancels safely and submits once after confirmation',async({page})=>{
 const writes=await fixture(page);await page.goto('/admin/operations/maintenance');
 await page.getByLabel('Reason for change').fill('Isolated browser verification');
 await page.getByRole('button',{name:'Review and apply settings'}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect(writes).toHaveLength(0);
 await page.getByRole('button',{name:'Review and apply settings'}).click();await dialog.getByRole('button',{name:'Confirm change'}).click();
 await expect(page.getByRole('status').filter({hasText:'server confirmed'})).toBeVisible();expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({version:1,reason:'Isolated browser verification'});
});
test('shelter staff cannot navigate to IT Operations',async({page})=>{
 await fixture(page,'shelter_staff');await page.goto('/admin/operations');await expect(page).toHaveURL(/\/admin\/overview$/);await expect(page.getByRole('link',{name:'IT Operations',exact:true})).toHaveCount(0);
});
