// Verify the delivered AFM workfield and safe holder service in the live viewer.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const out=process.env.LAB_TEST_OUTPUT,url=process.env.LAB_TEST_URL;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const hook=`
window.__afmAlignmentInspect=()=>{
 model.updateMatrixWorld(true);
 const front=lastState.sites.objective_front_center;
 const bounds=(name,maxZ=Infinity)=>{
  const node=poseNodes[name];if(!node)throw Error('Missing optical inspection node '+name);
  const box=new THREE.Box3();let vertices=0;
  node.traverse(o=>{if(!o.isMesh)return;const a=o.geometry.attributes.position;
   for(let i=0;i<a.count;i++){
    const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld);
    const w=new THREE.Vector3(v.x,-v.z,v.y);if(w.z>maxZ)continue;
    box.expandByPoint(w);vertices++;
   }
  });
  if(!vertices)throw Error('Empty optical inspection mesh '+name);
  return {min:box.min.toArray(),max:box.max.toArray(),center:box.getCenter(new THREE.Vector3()).toArray(),vertices};
 };
 return {q:lastState.q,sites:lastState.sites,contacts:lastState.contacts,guards:lastState.guard_events,time:lastState.time,
  objective:bounds('inspection_objective',front[2]+.004),specimen:bounds('sample_puck__wafer')};
};
window.__afmAlignmentCamera=side=>{
 const p=lastState.sites.specimen_surface_center;
 const target=new THREE.Vector3(p[0],p[2]+.0152,-p[1]);
 orbit.enableDamping=false;camera.fov=30;orbit.target.copy(target);
 camera.position.copy(target).add(side==='side'?new THREE.Vector3(.121106,.003003,0):new THREE.Vector3(0,.006,.18));
 orbit.update();syncProjection();camera.updateProjectionMatrix();viewDirty=true;
};
`;
const report={revision:'alignment6',url,passed:false,checks:[],views:[],errors:[],sources:{},
 harness_sha256:hash(fs.readFileSync(__filename)),instrumentation_sha256:hash(hook),
 scope:'Measured live sites, actual exported objective/specimen vertices, UI operation and order-independent service guards.'};
fs.mkdirSync(out,{recursive:true});
const save=()=>fs.writeFileSync(path.join(out,'afm-alignment.json'),JSON.stringify(report,null,2)+'\n');save();
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,
  args:['--no-sandbox','--no-proxy-server',...JSON.parse(process.env.CHROMIUM_GPU_ARGS||'[]')]});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(180000);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'||/GL_INVALID|GL_OUT_OF_MEMORY|CONTEXT_LOST|Shader Error/i.test(m.text()))report.errors.push(m.text());});
  await page.route(/\/assets\/afm\/(model\.glb|metadata\.json|physics\.xml)(?:\?|$)/,async route=>{
   try{const response=await route.fetch(),body=await response.body();assert.equal(response.status(),200);
    report.sources[new URL(route.request().url()).pathname]=hash(body);await route.fulfill({response,body});
   }catch(error){report.errors.push('Asset response capture: '+error.message);await route.abort();}
  });
  await page.route('**/app.js*',async route=>{const response=await route.fetch(),body=await response.body();
   report.app_sha256=hash(body);report.sources[new URL(response.url()).pathname]=hash(body);
   await route.fulfill({response,body:Buffer.concat([body,Buffer.from(hook)]),contentType:'application/javascript'});
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.viewerReady);
  await page.click('[data-asset="afm"]');
  await page.waitForFunction(()=>document.getElementById('model-status').textContent==='3D view ready'&&window.lab.state?.asset==='afm'&&window.lab.state.time>.5);
  Object.assign(report.sources,await page.evaluate(async()=>{
   const result={};for(const file of ['physics.js','worker.js','runtime.js']){
    const response=await fetch('./'+file+'?v=alignment6');if(!response.ok)throw Error('Missing runtime '+file);
    const bytes=await response.arrayBuffer();result[new URL(response.url).pathname]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   }return result;
  }));
  const inspect=()=>page.evaluate(()=>window.__afmAlignmentInspect());
  const command=async(joint,target)=>page.locator('input[data-read="'+joint+'"]').evaluate((el,target)=>{
   el.value=String(target*Number(el.dataset.scale));el.dispatchEvent(new Event('change',{bubbles:true}));
  },target);
  const waitQ=async(joint,target,tolerance=.015)=>page.waitForFunction(({joint,target,tolerance})=>Math.abs(window.lab.state.q[joint]-target)<tolerance,{joint,target,tolerance},{polling:50});
  const elapsed=async seconds=>{const time=await page.evaluate(()=>window.lab.state.time);await page.waitForFunction(({time,seconds})=>window.lab.state.time>time+seconds,{time,seconds},{polling:50});};
  const check=(name,ok,evidence={})=>{assert.ok(ok,name);report.checks.push({check:name,passed:true,...evidence});save();};
  const xy=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const capture=async(name,side)=>{
   if(!await page.evaluate(()=>window.lab.state.paused)){await page.click('#pause');await page.waitForFunction(()=>window.lab.state.paused);}
   await page.evaluate(side=>window.__afmAlignmentCamera(side),side);
   assert.equal(await page.evaluate(()=>window.lab.renderCurrentFrame()),true);
   assert.equal(await page.evaluate(()=>document.querySelector('#canvas canvas').getContext('webgl2').getError()),0);
   const file='afm-alignment-'+name+'.png';await page.locator('#canvas').screenshot({path:path.join(out,file)});
   report.views.push({name,file,sha256:hash(fs.readFileSync(path.join(out,file))),state:await inspect()});save();
   await page.click('#pause');await page.waitForFunction(()=>!window.lab.state.paused);
  };
  // Open the enclosure through its UI interlock, retaining the locked/docked
  // scanner so these views inspect the actual operating alignment.
  await command('door_latch_angle',Math.PI/2);await waitQ('door_latch_angle',Math.PI/2);
  await command('door_angle',-1.8);await waitQ('door_angle',-1.8);
  const initial=await inspect(),s=initial.sites;
  check('Inspection objective axis is vertical',xy(s.objective_axis_top,s.objective_front_center)<.000002&&s.objective_axis_top[2]>s.objective_front_center[2]);
  check('Docked sample is centered on objective',xy(s.objective_front_center,s.specimen_surface_center)<.0001,{offset_m:xy(s.objective_front_center,s.specimen_surface_center)});
  check('Actual AFM tip is centered on specimen',xy(s.afm_tip,s.specimen_surface_center)<.00015,{offset_m:xy(s.afm_tip,s.specimen_surface_center)});
  const working=s.objective_front_center[2]-s.specimen_surface_center[2],tipGap=s.afm_tip[2]-s.specimen_surface_center[2];
  check('Safe tip standoff and plausible objective working distance',tipGap>.0008&&tipGap<.002&&working>.005&&working<.025,{tip_gap_m:tipGap,working_distance_m:working});
  check('Actual exported lower objective mesh matches optical axis',initial.objective.vertices>100&&xy(initial.objective.center,s.objective_front_center)<.0002&&initial.objective.min[2]>s.specimen_surface_center[2]+.005,{bounds:initial.objective});
  check('Actual exported specimen mesh matches its physical surface',initial.specimen.vertices>20&&xy(initial.specimen.center,s.specimen_surface_center)<.0001&&Math.abs(initial.specimen.max[2]-s.specimen_surface_center[2])<.00005,{bounds:initial.specimen});
  await capture('docked-front','front');await capture('docked-side','side');
  await command('cantilever_lift',.5);await elapsed(.5);let state=await inspect();
  check('Docked holder service command is rejected',Math.abs(state.q.cantilever_lift)<.04&&state.guards.some(g=>g.control==='cantilever_lift'&&g.reason.includes('Withdraw scanner')));
  await command('scanner_latch_angle',1.2);await waitQ('scanner_latch_angle',1.2);
  await command('drawer_travel',.1);await waitQ('drawer_travel',.1,.0002);
  const protectedTargets=await page.evaluate(async()=>{const s=await window.lab.runtime.request('snapshot');return s.targets;});
  assert.ok(Math.abs(protectedTargets.drawer_travel-.1)<.0001);
  const simultaneous=[];
  for(const action of [{drawer_travel:0,cantilever_lift:.5},{cantilever_lift:.5,drawer_travel:0}]){
   const result=await page.evaluate(async action=>{await window.lab.runtime.request('command',{action});return window.lab.runtime.request('snapshot');},action);
   simultaneous.push({action,targets:result.targets,guards:result.guard_events});
   assert.equal(result.targets.drawer_travel,protectedTargets.drawer_travel);
   assert.equal(result.targets.cantilever_lift,protectedTargets.cantilever_lift);
  }
  check('Simultaneous unsafe commands cannot bypass guards in either order',true,{cases:simultaneous});
  const withdrawn=await inspect();await command('cantilever_lift',.5);await waitQ('cantilever_lift',.5);state=await inspect();
  check('Withdrawn holder can lift for service',state.q.drawer_travel>.09&&state.sites.afm_tip[2]-withdrawn.sites.afm_tip[2]>.006);
  await capture('service-side','side');
  await command('drawer_travel',0);await elapsed(.5);state=await inspect();
  check('Raised holder prevents scanner return command',state.q.drawer_travel>.09&&state.guards.some(g=>g.control==='drawer_travel'&&g.reason.includes('Lower cantilever')));
  await command('cantilever_lift',0);await waitQ('cantilever_lift',0,.003);
  await command('drawer_travel',0);await waitQ('drawer_travel',0,.00005);await elapsed(.4);state=await inspect();
  check('Lowered holder and returned sample recover the optical datum',xy(state.sites.objective_front_center,state.sites.specimen_surface_center)<.0001&&xy(state.sites.afm_tip,state.sites.specimen_surface_center)<.00015);
  await capture('returned-front','front');
  check('Live inspection has no browser or GPU errors',report.errors.length===0,{errors:report.errors});
  assert.equal(report.checks.length,12);report.passed=true;
 }catch(error){report.error=error.stack;throw error;}finally{save();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
