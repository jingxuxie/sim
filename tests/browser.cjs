// npm install --no-save playwright; npx playwright install chromium
// LAB_TEST_URL=https://jingxuxie.github.io/sim/ node tests/browser.cjs
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const checks=[];
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--no-proxy-server','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],failed=[],downloads=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
  page.on('request',r=>{if(/\.(wasm|glb|whl|hdr)(\?|$)/.test(r.url()))downloads.push(r.url());});
  page.on('crash',()=>{console.error('Browser page crashed');process.exit(2);});
  let start=Date.now();await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.viewerReady);
  assert.equal(await page.locator('.card').count(),7);assert.equal(downloads.length,0);
  checks.push({check:'Static gallery, all seven instruments, no eager runtime/model downloads',ms:Date.now()-start,passed:true});
  await page.screenshot({path:out+'/gallery.png',fullPage:true});
  await page.locator('[data-asset="nikon"]').click();
  await page.waitForFunction(()=>document.getElementById('model-status').textContent==='3D view ready',null,{timeout:120000});
  await page.waitForFunction(()=>window.lab.state?.time>.05,null,{timeout:60000});
  assert.equal(await page.evaluate(()=>window.crossOriginIsolated),false);
  assert.equal(downloads.filter(u=>u.endsWith('.glb')).length,1);
  const x=page.locator('input[data-read="x_angle"]');
  await x.evaluate(el=>{el.value='0.15';el.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>Math.abs(window.lab.state.q.stage_x-.003)<.00015,null,{timeout:15000});
  await page.selectOption('#objective-select','1');
  await page.waitForFunction(()=>window.lab.state.objective?.magnification===40,null,{timeout:15000});
  checks.push({check:'Real Nikon stage motion and objective indexing, without cross-origin isolation',passed:true});
  await page.click('#reset');
  await page.click('#enable-camera');
  await page.waitForFunction(()=>document.getElementById('specimen-image').naturalWidth===256,null,{timeout:180000});
  await page.selectOption('#light-path-select','0');
  await page.waitForFunction(()=>document.getElementById('specimen-caption').textContent.includes('camera port dark'),null,{timeout:30000});
  await page.selectOption('#optical-channel','eyepiece');
  await page.waitForFunction(()=>document.getElementById('specimen-caption').textContent.includes('100% light'),null,{timeout:30000});
  checks.push({check:'Live microscope image; measured splitter routes light to eyepieces and blacks out camera',passed:true});
  await page.screenshot({path:out+'/nikon.png',fullPage:true});
  await page.click('#pause');await page.waitForFunction(()=>window.lab.state.paused);
  const time=await page.evaluate(()=>window.lab.state.time);await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.lab.state.time),time);
  await page.click('#pause');await page.waitForFunction(t=>window.lab.state.time>t,time);
  await page.click('#back');assert.equal(await page.locator('.card:visible').count(),7);
  checks.push({check:'Pause, resume and return to responsive gallery',passed:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  if(process.env.LAB_ALL_MODELS){
   for(const asset of ['transfer','probe','zeiss','bonder','afm','tweezers']){
    await page.locator('[data-asset="'+asset+'"]').click();
    await page.waitForFunction(()=>document.getElementById('model-status').textContent==='3D view ready',null,{timeout:120000});
    await page.waitForFunction(asset=>window.lab.state?.asset===asset&&window.lab.state.time>.05,asset,{timeout:60000});
    await page.screenshot({path:out+'/'+asset+'.png',fullPage:true});
    checks.push({check:asset+' detailed GLB and live physics load',passed:true});
    await page.click('#back');
   }
   assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  }
  await page.close();
  for(const scenario of ['javascript disabled','application unavailable','worker unavailable']){
   const p=await browser.newPage({javaScriptEnabled:scenario!=='javascript disabled'});
   if(scenario==='application unavailable')await p.route('**/app.js',r=>r.abort());
   if(scenario==='worker unavailable')await p.route('**/worker.js',r=>r.abort());
   await p.goto(url,{waitUntil:'domcontentloaded'});await p.waitForSelector('.card');
   assert.equal(await p.locator('.card').count(),7);
   if(scenario==='worker unavailable'){
    await p.locator('[data-asset="nikon"]').click();await p.waitForSelector('#error:not([hidden])');
    await p.click('#back');assert.equal(await p.locator('.card:visible').count(),7);
   }
   checks.push({check:scenario+' leaves gallery accessible',passed:true});await p.close();
  }
 }finally{await browser.close();}
 const report={url,checked_utc:new Date().toISOString(),checks,passed:checks.every(c=>c.passed)};
 fs.writeFileSync(out+'/browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1);});
