// npm install --no-save playwright; npx playwright install chromium
// LAB_TEST_URL=https://jingxuxie.github.io/sim/ node tests/browser.cjs
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const checks=[];
let diagnostics;
// Do not leave a previous successful report behind when a new run times out.
const startedUTC=new Date().toISOString();
fs.writeFileSync(out+'/browser.json',JSON.stringify({url,started_utc:startedUTC,status:'running',passed:false},null,2)+'\n');
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--no-proxy-server','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 let page;
 try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[],failed=[],downloads=[];
  // Physics and DOM state progress independently of GPU presentation.
  const waitFor=(fn,arg,options={})=>page.waitForFunction(fn,arg,{polling:100,...options});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
  page.on('request',r=>{if(/\.(wasm|glb|whl|hdr)(\?|$)/.test(r.url()))downloads.push(r.url());});
  page.on('crash',()=>{console.error('Browser page crashed');process.exit(2);});
  const screenshot=async name=>{
   // Freeze the measured pose for reproducible captures. Continuous shadow
   // redraws can starve compositor readback on a CPU-only WebGL renderer.
   const live=await page.evaluate(()=>!document.getElementById('workspace').hidden&&!!window.lab.state);
   const wasPaused=live&&await page.evaluate(()=>window.lab.state.paused);
   if(live&&!wasPaused){await page.click('#pause');await waitFor(()=>window.lab.state.paused);}
   const time=live?await page.evaluate(()=>window.lab.state.time):null;
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:out+'/'+name+'.png',fullPage:true});
   if(live&&!wasPaused){await page.click('#pause');await waitFor(t=>window.lab.state.time>t,time);}
   console.log('Captured '+name+'; live controls resumed');
  };
  let start=Date.now();await page.goto(url,{waitUntil:'domcontentloaded'});await waitFor(()=>window.viewerReady);
  assert.equal(await page.locator('.card').count(),7);assert.equal(downloads.length,0);
  checks.push({check:'Static gallery, all seven instruments, no eager runtime/model downloads',ms:Date.now()-start,passed:true});
  await page.locator('.card img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  await screenshot('gallery');
  await page.locator('[data-asset="nikon"]').click();
  await waitFor(()=>document.getElementById('model-status').textContent==='3D view ready',null,{timeout:120000});
  await waitFor(()=>window.lab.state?.time>.05,null,{timeout:60000});
  const rendering=await page.evaluate(()=>window.lab.rendering);
  assert.ok(rendering.completed>0&&rendering.submitted-rendering.completed<=1);
  assert.equal(await page.evaluate(()=>window.crossOriginIsolated),false);
  assert.equal(downloads.filter(u=>/\.glb(\?|$)/.test(u)).length,1);
  const x=page.locator('input[data-read="x_angle"]');
  await x.evaluate(el=>{el.value='0.15';el.dispatchEvent(new Event('change',{bubbles:true}));});
  await waitFor(()=>Math.abs(window.lab.state.q.stage_x-.003)<.00015,null,{timeout:15000});
  await page.selectOption('#objective-select','1');
  await waitFor(()=>window.lab.state.objective?.magnification===40,null,{timeout:15000});
  checks.push({check:'Real Nikon stage motion and objective indexing, without cross-origin isolation',passed:true});
  await page.click('#reset');
  await page.click('#enable-camera');
  await waitFor(()=>document.getElementById('specimen-image').naturalWidth===256,null,{timeout:180000});
  await page.selectOption('#light-path-select','0');
  await waitFor(()=>document.getElementById('specimen-caption').textContent.includes('camera port dark'),null,{timeout:30000});
  await page.selectOption('#optical-channel','eyepiece');
  await waitFor(()=>document.getElementById('specimen-caption').textContent.includes('100% light'),null,{timeout:30000});
  checks.push({check:'Live microscope image; measured splitter routes light to eyepieces and blacks out camera',passed:true});
  await screenshot('nikon');
  await page.selectOption('#task','nikon.center');await page.click('#run');
  await waitFor(()=>window.lab.state?.success===true,null,{timeout:30000});
  checks.push({check:'Run baseline button executes a live task and reports measured success',passed:true});
  await page.click('#reset');await waitFor(()=>!window.lab.state?.task);
  await page.click('#pause');await waitFor(()=>window.lab.state.paused);
  const time=await page.evaluate(()=>window.lab.state.time);await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.lab.state.time),time);
  await page.click('#pause');await waitFor(t=>window.lab.state.time>t,time);
  await page.click('#back');assert.equal(await page.locator('.card:visible').count(),7);
  checks.push({check:'Pause, resume and return to responsive gallery',passed:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  if(process.env.LAB_ALL_MODELS){
   for(const asset of ['transfer','probe','zeiss','bonder','afm','tweezers']){
    await page.locator('[data-asset="'+asset+'"]').click();
    await waitFor(()=>document.getElementById('model-status').textContent==='3D view ready',null,{timeout:120000});
    await waitFor(asset=>window.lab.state?.asset===asset&&window.lab.state.time>.05,asset,{timeout:60000});
    await screenshot(asset);
    checks.push({check:asset+' detailed GLB and live physics load',passed:true});
    if(asset==='transfer'){
     const slider=async(name,value)=>page.locator('input[data-read="'+name+'"]').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},value);
     const lock=page.locator('input[data-read="rotation_lock_angle"]');
     await slider('sample_theta_angle','12');
     await waitFor(()=>Math.abs(window.lab.state.q.sample_theta_angle-Math.PI/15)<.003,null,{timeout:30000});
     const coarseAngle=await page.evaluate(()=>window.lab.state.q.sample_theta_angle);
     await slider('rotation_lock_angle',await lock.getAttribute('max'));
     await waitFor(()=>window.lab.state.q.rotation_lock_angle>1.4,null,{timeout:30000});
     await slider('rotation_fine_knob_angle','1');
     await waitFor(()=>Math.abs(window.lab.state.q.sample_fine_angle-.000635/.0413)<.0005,null,{timeout:30000});
     assert.ok(Math.abs(await page.evaluate(()=>window.lab.state.q.sample_theta_angle)-coarseAngle)<.003);
     await slider('illumination_power_angle','0');
     await waitFor(()=>window.lab.state.q.illumination_power_angle<.01,null,{timeout:30000});
     assert.equal(await page.locator('input[data-read="illumination_power_angle"]').evaluate(el=>el.previousSibling.lastChild.textContent),'Off');
     assert.equal(await page.locator('input[data-read="rotation_fine_knob_angle"]').getAttribute('data-unit'),'turn');
     checks.push({check:'Transfer UI operates lock, fine micrometer in turns and source power',passed:true});
     const views=page.locator('#render-view');assert.ok(await views.locator('option').count()>=5);
     await views.selectOption({label:'Illuminator and fiber'});
     await waitFor(()=>document.getElementById('poster').naturalWidth===2560,null,{timeout:30000});
     assert.ok((await page.locator('#full-render').getAttribute('href')).includes('illumination.png'));
     await page.click('#overview');
     checks.push({check:'Additional source-matched render views are available from the instrument UI',passed:true});
    }
    await page.click('#back');
   }
   assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  }
  await page.close();
  for(const scenario of ['javascript disabled','application unavailable','worker unavailable']){
   const p=await browser.newPage({javaScriptEnabled:scenario!=='javascript disabled'});
   if(scenario==='application unavailable')await p.route('**/app.js*',r=>r.abort());
   if(scenario==='worker unavailable')await p.route('**/worker.js*',r=>r.abort());
   await p.goto(url,{waitUntil:'domcontentloaded'});await p.waitForSelector('.card');
   assert.equal(await p.locator('.card').count(),7);
   if(scenario==='worker unavailable'){
    await p.locator('[data-asset="nikon"]').click();await p.waitForSelector('#error:not([hidden])');
    await p.click('#back');assert.equal(await p.locator('.card:visible').count(),7);
   }
   checks.push({check:scenario+' leaves gallery accessible',passed:true});await p.close();
  }
 }catch(e){
  const deadline=promise=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Diagnostic timed out')),5000))]);
  try{
   diagnostics=await deadline(page.evaluate(()=>({
    model_status:document.getElementById('model-status').textContent,
    physics_status:document.getElementById('physics-status').textContent,
    error:document.getElementById('error').textContent,
    rendering:window.lab?.rendering,
    state:window.lab?.state?{asset:window.lab.state.asset,time:window.lab.state.time,paused:window.lab.state.paused,q:window.lab.state.q,guard_events:window.lab.state.guard_events}:null,
    controls:[...document.querySelectorAll('#controls input')].map(e=>({joint:e.dataset.read,value:e.value,scale:e.dataset.scale,disabled:e.disabled}))
   })));
   diagnostics.worker=await deadline(page.evaluate(async()=>{const s=await window.lab.runtime.request('snapshot');return{time:s.time,q:s.q,targets:s.targets,guard_events:s.guard_events};}));
  }catch(diagnosticError){diagnostics={...diagnostics,diagnostic_error:diagnosticError.message};}
  console.error('Failure state: '+JSON.stringify(diagnostics));throw e;
 }finally{await browser.close();}
 const report={url,started_utc:startedUTC,checked_utc:new Date().toISOString(),checks,passed:checks.every(c=>c.passed)};
 fs.writeFileSync(out+'/browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{fs.writeFileSync(out+'/browser.json',JSON.stringify({url,started_utc:startedUTC,checked_utc:new Date().toISOString(),checks,passed:false,error:e.message,diagnostics},null,2)+'\n');console.error(e);process.exit(1);});
