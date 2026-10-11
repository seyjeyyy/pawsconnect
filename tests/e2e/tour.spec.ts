import {expect,test} from '@playwright/test';
test('tour follows routes, fits the viewport and restores keyboard access',async({page})=>{
 test.setTimeout(60000); // Nine route changes, including cold lazy bundles and map startup.
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');await page.getByRole('button',{name:'Show me around'}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 for(let step=1;step<=9;step++){
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow',String(step));
  const next=dialog.getByRole('button',{name:step===9?'Finish':'Next',exact:true});
  await expect(next).toBeEnabled({timeout:10000});
  await expect.poll(async()=>dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;})).toBe(true);
  if(step===4)await page.screenshot({path:`test-results/tour-${test.info().project.name}.png`});
  await next.click();
 }
 await expect(dialog).toHaveCount(0);await expect(page.locator('#tour-page')).not.toHaveAttribute('inert');
 expect(errors).toEqual([]);
});
test('interrupted tours resume after reload and Escape exits',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Show me around'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Next',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('aria-valuenow','2');
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.reload();await page.getByRole('button',{name:'Resume tour'}).first().click();
 await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('aria-valuenow','2');
 await page.keyboard.press('Escape');
});
test('reduced motion, scrolling and short viewports keep controls reachable',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:360,height:480});
 await page.goto('/');await page.getByRole('button',{name:'Show me around'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Next',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('button',{name:'Next',exact:true})).toBeEnabled();
 await page.evaluate(()=>window.scrollTo(0,350));
 await expect.poll(()=>page.getByRole('dialog').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight+1)).toBe(true);
 await page.keyboard.press('Tab');await expect.poll(()=>page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement))).toBe(true);
 const duration=await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).transitionDuration);
 expect(['0s','1e-05s','0.00001s']).toContain(duration);
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('missing tour targets recover instead of leaving a hidden tooltip',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Show me around'}).click();
 await page.addStyleTag({content:'.desktop-nav,.mobile-toggle {display:none!important}'});
 await page.getByRole('dialog').getByRole('button',{name:'Next',exact:true}).click();
 await expect(page.getByText('This feature isn’t visible here.')).toBeVisible({timeout:10000});
 await expect(page.getByRole('dialog').getByRole('button',{name:'Next',exact:true})).toBeEnabled();
 await page.keyboard.press('Escape');
});
test('active pages use only PawsConnect branding',async({page})=>{
 for(const path of ['/','/about','/adopt','/auth/login','/contact','/privacy','/terms']){
  await page.goto(path);await expect(page.getByRole('heading',{level:1}).first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/Rowena/i);
 }
});
