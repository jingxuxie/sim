// Browser integration checks for live lighting and progressive 3D rendering.
// Run through validation/run_contact_browser.sbatch rendering on a compute node.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.resolve(__dirname,'../test-results');
fs.mkdirSync(out,{recursive:true});
const report={url,started_utc:new Date().toISOString(),checks:[],passed:false};
const write=()=>fs.writeFileSync(path.join(out,'rendering.json'),JSON.stringify(report,null,2)+'\n');write();
const check=(name,extra={})=>{report.checks.push({check:name,passed:true,...extra});console.log('Passed: '+name)};
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--no-proxy-server',...(process.env.CHROMIUM_GPU_ARGS?JSON.parse(process.env.CHROMIUM_GPU_ARGS):['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])]});
 let page;
 try{
  page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(120000);
  const errors=[],failed=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
  page.on('request',r=>requests.push(r.url()));
  const wait=(fn,arg,timeout=120000)=>page.waitForFunction(fn,arg,{polling:100,timeout});
  const quality=()=>page.evaluate(()=>window.lab.photoRendering);
  const capture=async name=>{
   assert.equal(await page.evaluate(()=>window.lab.renderCurrentFrame()),true);
   assert.equal(await page.locator('#poster').evaluate(el=>el.hidden),true);
   const file=path.join(out,name+'.png');await page.locator('#canvas').screenshot({path:file});
   const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
   return {file:path.basename(file),sha256,quality:await quality()};
  };
  await page.goto(url,{waitUntil:'domcontentloaded'});await wait(()=>window.viewerReady);
  assert.equal(await page.locator('.card').count(),7);
  assert.equal(requests.filter(s=>/pathtrac|mesh-bvh/i.test(s)).length,0);
  check('Gallery remains independent of path-tracing downloads');
  await page.locator('[data-asset="transfer"]').click();
  await wait(()=>document.getElementById('model-status').textContent==='3D view ready');
  await wait(()=>window.lab.state?.time>.05);
  assert.equal(await page.locator('#render-quality').inputValue(),'interactive');
  assert.equal(requests.filter(s=>/pathtrac|mesh-bvh/i.test(s)).length,0);
  await page.click('#pause');await wait(()=>window.lab.state.paused);
  const live=await capture('quality-live-transfer');
  await page.click('#pause');await wait(()=>!window.lab.state.paused);
  check('Default live mode retains actual instrument geometry without ray-tracing cost',{view:live});
  const entered=Date.now();await page.selectOption('#render-quality','photo');
  await wait(()=>window.lab.state.paused);
  await wait(()=>window.lab.photoRendering?.ready&&window.lab.photoRendering.samples>=2,null,300000);
  assert.equal(await page.locator('#render-quality').inputValue(),'photo');
  const traced=await capture('quality-photo-transfer');
  assert.notEqual(traced.sha256,live.sha256);
  assert.ok(traced.quality.samples>=2);
  check('Photo mode pauses physics and accumulates actual 3D samples with no still-image substitution',{ms:Date.now()-entered,view:traced});
  const before=await quality(),bounds=await page.locator('#canvas').boundingBox();
  await page.mouse.move(bounds.x+bounds.width*.57,bounds.y+bounds.height*.58);
  await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.69,bounds.y+bounds.height*.62,{steps:8});
  const dragged=await quality();await page.mouse.up();
  assert.ok(dragged.generation>before.generation||dragged.samples<before.samples,'Orbit must invalidate old ray samples');
  await page.waitForFunction(()=>{const q=window.lab.photoRendering;if(window.__qaOrbitGeneration!==q.generation){window.__qaOrbitGeneration=q.generation;window.__qaOrbitStableAt=performance.now();}return q.ready&&performance.now()-window.__qaOrbitStableAt>1200;},null,{polling:100,timeout:300000});
  // The old view can retain its sample counter while a slow raster GPU frame
  // is still in flight. Complete the first frame of the settled new camera
  // before waiting for its samples, rather than accepting the old counter.
  assert.equal(await page.evaluate(()=>window.lab.renderCurrentFrame()),true);
  await wait(()=>window.lab.photoRendering.ready&&window.lab.photoRendering.samples>=2,null,300000);
  const orbited=await capture('quality-photo-orbit');assert.notEqual(orbited.sha256,traced.sha256);assert.ok(orbited.quality.samples>=2);
  check('Orbit resets accumulation and renders a different 3D viewpoint',{before,dragged,view:orbited});
  const xBefore=await page.evaluate(()=>window.lab.state.q.sample_x_travel);
  const slider=page.locator('input[data-read="sample_x_travel"]');
  await slider.evaluate(el=>{el.value='0.25';el.dispatchEvent(new Event('change',{bubbles:true}));});
  await wait(()=>document.getElementById('render-quality').value==='interactive');
  await wait(()=>!window.lab.state.paused);
  await wait(initial=>Math.abs(window.lab.state.q.sample_x_travel-initial)>.00002,xBefore);
  check('An instrument command exits refinement, resumes live physics, and moves the stage');
  await page.click('#pause');await wait(()=>window.lab.state.paused);
  await page.selectOption('#render-quality','photo');
  await page.selectOption('#render-quality','interactive');
  await wait(()=>window.lab.photoRendering?.mode==='interactive');
  assert.equal(await page.evaluate(()=>window.lab.state.paused),true);
  check('Canceling refinement preserves a pause explicitly requested by the user');
  await page.click('#back');await page.locator('[data-asset="nikon"]').click();
  await wait(()=>document.getElementById('model-status').textContent==='3D view ready');
  await wait(()=>window.lab.state?.asset==='nikon'&&window.lab.state.time>.05);
  assert.equal(await page.locator('#render-quality').inputValue(),'interactive');
  assert.equal((await quality()).mode,'interactive');
  check('Switching instruments disposes the previous photo scene and keeps live controls working');
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  check('No browser exceptions or failed HTTP responses');
  // Delay the real pause reply to exercise cancellation before that reply can
  // be applied by the page. Physics itself remains the ordinary MuJoCo worker.
  await page.evaluate(()=>{const r=window.lab.runtime,request=r.request.bind(r);r.request=(op,extra)=>{const result=request(op,extra);return op==='pause'?result.then(s=>new Promise(resolve=>setTimeout(()=>resolve(s),350))):result;};});
  await page.selectOption('#render-quality','photo');
  await page.selectOption('#render-quality','interactive');
  await page.waitForTimeout(1200);await wait(()=>!window.lab.state.paused);
  assert.equal((await quality()).mode,'interactive');
  check('Canceling before an automatic pause reply arrives restores live simulation');
  await page.close();
  const openCase=async configure=>{
   const p=await browser.newPage({viewport:{width:1000,height:800}});p.setDefaultTimeout(120000);p.__qaPageErrors=[];p.on('pageerror',e=>p.__qaPageErrors.push(e.message));
   if(configure)await configure(p);
   await p.goto(url,{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>window.viewerReady,null,{polling:100});
   await p.locator('[data-asset="nikon"]').click();
   await p.waitForFunction(()=>document.getElementById('model-status').textContent==='3D view ready'&&window.lab.state?.time>.05,null,{polling:100,timeout:120000});
   return p;
  };
  for(const unavailable of ['module download failed','floating-point targets unavailable']){
   page=await openCase(p=>p.route('**/progressive-renderer.js*',route=>unavailable==='module download failed'?route.abort():route.fulfill({contentType:'application/javascript',body:'export class ProgressiveRenderer {constructor(){throw Error("Simulated unavailable floating-point targets");}}'})));
   await page.selectOption('#render-quality','photo');
   await page.waitForFunction(()=>window.lab.photoRendering.mode==='interactive'&&document.getElementById('render-quality-status').textContent.includes('unavailable')&&!window.lab.state.paused,null,{polling:100});
   await page.click('#pause');await page.waitForFunction(()=>window.lab.state.paused,null,{polling:100});
   await page.selectOption('#render-quality','photo');
   await page.waitForFunction(()=>window.lab.photoRendering.mode==='interactive'&&document.getElementById('render-quality-status').textContent.includes('unavailable'),null,{polling:100});
   assert.equal(await page.evaluate(()=>window.lab.state.paused),true);
   assert.equal(await page.locator('#poster').evaluate(el=>el.hidden),true);
   assert.equal(await page.locator('#error').evaluate(el=>el.hidden),true);assert.deepEqual(page.__qaPageErrors,[]);
   check(unavailable+' falls back to interactive rendering and preserves pause intent',{error_banner_hidden:true});await page.close();
  }
  let workerRequested=false,releaseWorker;
  const workerGate=new Promise(resolve=>{releaseWorker=resolve;});
  page=await openCase(p=>p.route('**/bvh.worker.js*',async route=>{workerRequested=true;await workerGate;try{await route.continue();}catch{}}));
  await page.selectOption('#render-quality','photo');
  const workerWait=Date.now();while(!workerRequested){if(Date.now()-workerWait>60000)throw Error('Photo acceleration worker was not requested');await page.waitForTimeout(100);}
  assert.equal((await quality()).preparing,true);
  await page.click('#back');await page.locator('[data-asset="transfer"]').click();releaseWorker();
  await wait(()=>document.getElementById('model-status').textContent==='3D view ready'&&window.lab.state?.asset==='transfer'&&window.lab.state.time>.05);
  assert.equal((await quality()).mode,'interactive');assert.equal((await quality()).ready,false);
  assert.equal(await page.locator('#render-quality').inputValue(),'interactive');
  assert.equal(await page.locator('#error').evaluate(el=>el.hidden),true);assert.deepEqual(page.__qaPageErrors,[]);
  check('Switching instruments during acceleration preparation cancels the previous scene safely',{error_banner_hidden:true});
  report.passed=true;
 }catch(e){report.error=e.stack;try{report.diagnostics=await page.evaluate(()=>({quality:window.lab?.photoRendering,state:window.lab?.state,model:document.getElementById('model-status')?.textContent,status:document.getElementById('render-quality-status')?.textContent}));}catch{}throw e;}
 finally{report.checked_utc=new Date().toISOString();write();await browser.close();}
})().then(()=>console.log(JSON.stringify(report,null,2))).catch(e=>{console.error(e);process.exit(1)});
