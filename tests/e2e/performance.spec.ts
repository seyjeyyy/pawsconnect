import {expect,test} from '@playwright/test';
// Laboratory preview only. This does not claim production p75 Core Web Vitals.
test('records local navigation, paint and layout measurements',async({page})=>{
 await page.addInitScript(()=>{
  const values:{lcp:number|null;cls:number}={lcp:null,cls:0};(window as any).__labVitals=values;
  new PerformanceObserver(list=>{for(const e of list.getEntries())values.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});
  new PerformanceObserver(list=>{for(const e of list.getEntries() as any)if(!e.hadRecentInput)values.cls+=e.value;}).observe({type:'layout-shift',buffered:true});
 });
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.waitForLoadState('networkidle');
 const metrics=await page.evaluate(()=>({scope:'Isolated local Vite preview, one sample; not production p75',vitals:(window as any).__labVitals,paint:performance.getEntriesByType('paint').map(e=>({name:e.name,startTime:e.startTime})),navigation:performance.getEntriesByType('navigation').map((e:any)=>({domContentLoaded:e.domContentLoadedEventEnd,load:e.loadEventEnd})),resources:performance.getEntriesByType('resource').length,viewport:{width:innerWidth,height:innerHeight}}));
 await test.info().attach('local-performance',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});
 console.info(`Local browser measurement (${test.info().project.name}): ${JSON.stringify(metrics)}`);
});
