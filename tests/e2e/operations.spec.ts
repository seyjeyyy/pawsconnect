import {expect,test,type Page} from '@playwright/test';
async function openWorkspaceMenu(page:Page){
 await expect(page.locator('.dashboard-main h1')).toBeVisible();
 const trigger=page.getByRole('button',{name:'Workspace menu',exact:true});
 if(await trigger.isVisible() && !(await page.getByRole('dialog',{name:'Workspace menu',exact:true}).isVisible())) await trigger.click();
}
// Browser-only fixtures. Every backend call stays intercepted on the isolated
// preview server. Production authentication contains no test bypass.
async function fixture(page:Page,role='super_administrator',signedIn=true){
 const user={id:'00000000-0000-4000-8000-000000000010',email:'fixture@example.test'};
 await page.route('**/src/lib/supabase.ts',route=>route.fulfill({contentType:'application/javascript',body:`
 const initialUser=${JSON.stringify(user)};
 let session=JSON.parse(sessionStorage.getItem('fixture-session')||'null')||(${signedIn}?{user:initialUser,access_token:'browser-fixture'}:null);
 const listeners=new Set();
 const channel={on(){return channel},subscribe(){return channel}};
 export const supabase={auth:{
  getSession:async()=>({data:{session}}),
  onAuthStateChange:callback=>{listeners.add(callback);return {data:{subscription:{unsubscribe(){listeners.delete(callback)}}}}},
  signInWithPassword:async({email})=>{
   const role=email.split('@')[0];
   session={user:{id:email,email},access_token:'browser-fixture:'+role};
   sessionStorage.setItem('fixture-session',JSON.stringify(session));
   listeners.forEach(callback=>callback('SIGNED_IN',session));return {data:{session},error:null};
  },
  signOut:async()=>{session=null;sessionStorage.removeItem('fixture-session');listeners.forEach(callback=>callback('SIGNED_OUT',null));return {error:null}}
 },channel:()=>channel,removeChannel:async()=>{}};` }));
 const config={version:1,mode:'normal',modules:[],starts_at:null,ends_at:null,public_notice:'',instructions:'',reason:'',disabled_features:[],slow_request_ms:2000,backup_interval_hours:null,retention_days:30,rpo_minutes:1440,rto_minutes:240};
 const writes:unknown[]=[];
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  let data:unknown=[],meta:unknown=undefined;
  const activeRole=request.headers().authorization?.split(':')[1]||role;
  if(path==='/api/auth/me')data={...user,full_name:'Fixture operator',permissions:activeRole==='administrator'||activeRole==='shelter_staff'?['animals.view','animals.manage','animals.health','store.manage','adoptions.review','rescue.manage','transport.manage','finance.manage','donations.view','volunteers.manage','contacts.manage']:activeRole==='veterinarian'?['animals.view','animals.health']:activeRole==='rescue_personnel'||activeRole==='volunteer'?['rescue.assigned']:activeRole==='shelter_driver'?['transport.assigned']:[],roles:[...new Set([activeRole,'buyer','adopter','donor','community_reporter'])]};
  else if(path==='/api/cart')data={items:[]};
  else if(path==='/api/volunteers/mine')data=null;
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

for (const role of ['super_administrator','administrator','shelter_staff','veterinarian','rescue_personnel','shelter_driver']) {
 test(`${role} keeps its workspace menu in profile and settings`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await fixture(page,role);
  await page.goto('/admin');
  await openWorkspaceMenu(page);
  await expect(page.getByRole('link',{name:'Profile & settings',exact:true})).toBeVisible();
  const workspaceLinks=await page.getByRole('navigation',{name:'Shelter navigation',exact:true}).locator('a').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  expect(workspaceLinks.length).toBeGreaterThan(0);
  await page.getByRole('link',{name:'Profile & settings',exact:true}).click();
  await expect(page.locator('.dashboard-main h1')).toHaveText('My profile');
  const menu=page.getByRole('navigation',{name:'Account navigation',exact:true});
  const assertMenu=async()=>{
   await openWorkspaceMenu(page);
   expect(await menu.locator('a[href^="/admin/"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')).filter(href=>href!=='/admin/operations'))).toEqual(workspaceLinks);
   expect(await menu.locator('a[href^="/account/"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')))).toEqual(['/account/notifications','/account/profile','/account/settings']);
   await expect(menu.locator('a[href="/admin/operations"]')).toHaveCount(role==='super_administrator'?1:0);
  };
  await assertMenu();
  await menu.getByRole('link',{name:'Account settings',exact:true}).click();
  await expect(page.locator('.dashboard-main h1')).toHaveText('Account settings');
  await openWorkspaceMenu(page);
  await expect(menu.getByRole('link',{name:'Account settings',exact:true})).toHaveAttribute('aria-current','page');
  await assertMenu();
  await page.reload();
  await expect(page.locator('.dashboard-main h1')).toHaveText('Account settings');
  await assertMenu();
  await page.goto('/account/orders');
  await expect(page).toHaveURL(/\/account\/profile$/);
  expect(errors).toEqual([]);
 });
}

for (const role of ['buyer','volunteer']) {
 test(`${role} retains its community menu in account settings`,async({page})=>{
  await fixture(page,role);await page.goto('/account/settings');
  await expect(page.locator('.dashboard-main h1')).toHaveText('Account settings');
  await openWorkspaceMenu(page);
  const menu=page.getByRole('navigation',{name:'Account navigation',exact:true});
  await expect(menu.locator('a[href="/account/orders"]')).toHaveCount(1);
  await expect(menu.locator('a[href="/account/applications"]')).toHaveCount(1);
  await expect(menu.locator('a[href="/account/volunteer"]')).toHaveCount(role==='volunteer'?1:0);
  await expect(menu.locator('a[href="/admin"]')).toHaveCount(role==='volunteer'?1:0);
  await expect(menu.locator('a[href^="/admin/"]')).toHaveCount(0);
 });
}
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

test('account settings and the system workspace need no authenticator challenge',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await fixture(page); // The auth fixture deliberately has no MFA methods.
 await page.goto('/account/settings');
 await expect(page.locator('.dashboard-main h1')).toHaveText('Account settings');
 await expect(page.getByText('Two-step verification',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Authenticator code')).toHaveCount(0);
 await page.goto('/admin/security');
 await expect(page.locator('.dashboard-main h1')).toBeVisible();
 await expect(page.getByText('Protect your workspace',{exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
});

const destinations:Record<string,string>={super_administrator:'/admin/security',administrator:'/admin/overview',shelter_staff:'/admin/overview',veterinarian:'/admin/pets',rescue_personnel:'/admin/rescue',shelter_driver:'/admin/transport',volunteer:'/account/volunteer',buyer:'/account/overview',adopter:'/account/overview',donor:'/account/overview',community_reporter:'/account/overview'};

test('module-restricted staff see only their assigned animal records and a usable sidebar',async({page})=>{
 await fixture(page,'shelter_staff');
 await page.route('**/api/auth/me',route=>route.fulfill({json:{data:{id:'00000000-0000-4000-8000-000000000010',full_name:'Animal viewer',roles:['shelter_staff'],permissions:['animals.view']}}}));
 await page.goto('/admin/pets');await expect(page.locator('.dashboard-main h1')).toBeVisible();
 await expect(page.getByRole('button',{name:'Add pet',exact:true})).toHaveCount(0);
 await openWorkspaceMenu(page);
 const nav=page.getByRole('navigation',{name:'Shelter navigation',exact:true});
 await expect(nav.locator('a[href="/admin/pets"]')).toHaveCount(1);
 await expect(nav.locator('a[href="/admin/payments"],a[href="/admin/orders"],a[href="/admin/users"]')).toHaveCount(0);
 if(await page.getByRole('dialog',{name:'Workspace menu',exact:true}).isVisible()){
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Workspace menu',exact:true})).toBeFocused();
 }else{
  await page.getByRole('button',{name:'Collapse sidebar'}).click();await expect(page.locator('.workspace-shell')).toHaveClass(/sidebar-rail/);await expect(nav.locator('a[href="/admin/pets"]')).toBeVisible();
  await page.getByRole('button',{name:'Expand sidebar'}).click();await expect(page.locator('.workspace-shell')).not.toHaveClass(/sidebar-rail/);await expect(nav).toBeVisible();
 }
 await page.screenshot({path:`test-results/optimized-workspace-${test.info().project.name}.png`,fullPage:true});
});

test('public reference data does not poll after thirty seconds',async({page})=>{
 let reads=0;await page.clock.install();
 await page.route('**/api/**',route=>{reads++;const path=new URL(route.request().url()).pathname;return route.fulfill({json:{data:path.endsWith('/health')?{payment_mode:'unavailable'}:path.endsWith('/status')?{active:false}:[]}});});
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.waitForLoadState('networkidle');const settled=reads;
 await page.clock.fastForward(35000);
 expect(reads).toBe(settled);
 await test.info().attach('public-request-count',{body:JSON.stringify({initial: settled,after35Seconds:reads,extraRequests:reads-settled}),contentType:'application/json'});
});

test('record editors retain entered values on failure and close with Escape',async({page})=>{
 await fixture(page,'shelter_staff');
 await page.route('**/api/admin/pets',route=>route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Temporary record service failure'}}}));
 await page.goto('/admin/pets');
 await page.getByRole('button',{name:'Add pet',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Edit record',exact:true});await expect(dialog).toBeVisible();
 await dialog.getByLabel('Name',{exact:true}).fill('Retained animal name');
 await dialog.getByLabel('Description',{exact:true}).fill('Animal description retained after a failed save.');
 await dialog.getByRole('button',{name:'Save record',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Temporary record service failure');
 await expect(dialog.getByLabel('Name',{exact:true})).toHaveValue('Retained animal name');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});

test('record status filtering reaches the server and uses exact pagination totals',async({page})=>{
 await fixture(page,'shelter_staff');
 await page.route('**/api/admin/pets?**',route=>route.fulfill({json:{data:[],meta:{total:0,page:1,limit:15}}}));
 await page.goto('/admin/pets');
 await page.waitForLoadState('networkidle');
 await Promise.all([
  page.waitForRequest(r=>r.url().includes('/api/admin/pets?')&&new URL(r.url()).searchParams.get('status')==='available'),
  page.getByRole('combobox',{name:'Status',exact:true}).selectOption('available'),
 ]);
 await expect(page.getByRole('combobox',{name:'Status',exact:true})).toHaveValue('available');
 await expect(page.getByRole('button',{name:'Next',exact:true})).toBeDisabled();
});
for(const [role,destination] of Object.entries(destinations)) {
 test(`${role} signs in to a dedicated task page`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await fixture(page,role,false);
  await page.goto('/auth/login?next=/');
  await page.getByLabel('Email address').fill(`${role}@example.test`);
  await page.getByLabel('Password',{exact:true}).fill('isolated-fixture-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(destination);
  await expect(page.locator('.dashboard-main h1')).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Workspace shortcuts'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Main navigation',exact:true})).toHaveCount(0);
  await expect(page.locator('.footer,.announcement')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
  await page.goto('/');await expect(page).toHaveURL(destination);
  await page.reload();await expect(page).toHaveURL(destination);
  await page.goto('/auth/login');await expect(page).toHaveURL(destination);
  await page.goto('/auth/callback');await expect(page).toHaveURL(destination);
  expect(errors).toEqual([]);
 });
}

test('switching accounts replaces the previous workspace and signing out stays signed out',async({page})=>{
 await fixture(page,'super_administrator',false);
 await page.goto('/auth/login');
 for(const role of ['super_administrator','shelter_driver','buyer']) {
  await page.getByLabel('Email address').fill(`${role}@example.test`);
  await page.getByLabel('Password',{exact:true}).fill('isolated-fixture-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(destinations[role]);
  if(role!=='super_administrator')await expect(page.locator('.account-sidebar a[href="/admin/security"]')).toHaveCount(0);
  await page.getByRole('navigation',{name:'Workspace shortcuts'}).getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page).toHaveURL('/auth/login');
  await page.reload();await expect(page.getByLabel('Email address')).toBeVisible();
 }
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toContainText('Give a shelter pet');
});

test('role lookup must succeed before sign-in chooses a workspace',async({page})=>{
 await fixture(page,'super_administrator');
 await page.route('**/api/auth/me',route=>route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Identity service temporarily unavailable'}}}));
 await page.goto('/auth/login');
 await expect(page.getByRole('alert')).toContainText('Identity service temporarily unavailable');
 await expect(page).toHaveURL('/auth/login');
 await expect(page.locator('.dashboard-main')).toHaveCount(0);
 await page.unroute('**/api/auth/me');
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page).toHaveURL('/admin/security');
});
