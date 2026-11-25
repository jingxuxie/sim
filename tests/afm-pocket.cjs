// Inspect the delivered folding handle at measured poses in the actual browser.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const out=process.env.LAB_TEST_OUTPUT,url=process.env.LAB_TEST_URL;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const hook=`
window.__afmPocketInspect=(nodes)=>{
 model.updateMatrixWorld(true);
 const pose=lastState.poses.door,rotation=new THREE.Quaternion(pose.q[1],pose.q[2],pose.q[3],pose.q[0]);
 const inverse=rotation.clone().invert(),origin=new THREE.Vector3(...pose.p),bounds=new THREE.Box3();
 let vertices=0;
 for(const name of nodes){
  const node=poseNodes[name];if(!node)throw Error('Missing handle mesh '+name);
  node.traverse(o=>{if(!o.isMesh)return;const positions=o.geometry.attributes.position;
   for(let i=0;i<positions.count;i++){
    const w=new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(o.matrixWorld);
    const local=new THREE.Vector3(w.x,-w.z,w.y).sub(origin).applyQuaternion(inverse);
    bounds.expandByPoint(local);vertices++;
   }
  });
 }
 return {bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},vertices,
         q:lastState.q,time:lastState.time,paused:lastState.paused};
};
window.__afmPocketCamera=()=>{
 const p=lastState.poses.door,q=new THREE.Quaternion(p.q[1],p.q[2],p.q[3],p.q[0]);
 const world=local=>{const v=new THREE.Vector3(...local).applyQuaternion(q).add(new THREE.Vector3(...p.p));return new THREE.Vector3(v.x,v.z,-v.y);};
 orbit.enableDamping=false;camera.fov=30;
 camera.position.copy(world([.70,-.31,.31]));orbit.target.copy(world([.322,-.005,.132]));
 orbit.update();syncProjection();camera.updateProjectionMatrix();viewDirty=true;
};
`;
const report={revision:'reference5',url,passed:false,checks:[],views:[],errors:[],sources:{},
 harness_sha256:hash(fs.readFileSync(__filename)),instrumentation_sha256:hash(hook),
 source_capture:'Hash original asset response bytes from route.fetch and forward the same bytes to the viewer.'};
const save=()=>fs.writeFileSync(path.join(out,'afm-pocket.json'),JSON.stringify(report,null,2)+'\n');
fs.mkdirSync(out,{recursive:true});save();
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,
  args:['--no-sandbox','--no-proxy-server',...JSON.parse(process.env.CHROMIUM_GPU_ARGS||'[]')]});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(180000);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'||/GL_INVALID|GL_OUT_OF_MEMORY|CONTEXT_LOST|Shader Error/i.test(m.text()))report.errors.push(m.text());});
  // Large GLBs can be evicted from Chromium's inspector response cache.
  // Hash and forward the original HTTP body before it reaches the viewer.
  await page.route(/\/assets\/afm\/(model\.glb|metadata\.json|physics\.xml)(?:\?|$)/,async route=>{
   try{
    const response=await route.fetch(),body=await response.body();
    assert.equal(response.status(),200);
    report.sources[new URL(route.request().url()).pathname]=hash(body);
    await route.fulfill({response,body});
   }catch(error){report.errors.push('Asset response capture: '+error.message);await route.abort();}
  });
  await page.route('**/app.js*',async route=>{const r=await route.fetch(),b=await r.body();report.app_sha256=hash(b);report.sources[new URL(r.url()).pathname]=hash(b);await route.fulfill({response:r,body:Buffer.concat([b,Buffer.from(hook)]),contentType:'application/javascript'});});
  await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.viewerReady);
  await page.click('[data-asset="afm"]');
  await page.waitForFunction(()=>document.getElementById('model-status').textContent==='3D view ready'&&window.lab.state?.asset==='afm'&&window.lab.state.time>.05);
  const metadata=await page.evaluate(async()=>{const c=JSON.parse(document.getElementById('instrument-catalog').textContent);const item=c.instruments.find(x=>x.id==='afm');return await (await fetch(item.metadata)).json();});
  const geometry=metadata.release_geometry,nodes=geometry.door_handle_visual_nodes;
  assert.ok(nodes.length>0);assert.ok(geometry.door_paddle_length_mm>=80,'Reference handle is a long folding blade');
  const inspect=()=>page.evaluate(nodes=>window.__afmPocketInspect(nodes),nodes);
  const waitQ=async(joint,target,tolerance=.025)=>page.waitForFunction(({joint,target,tolerance})=>Math.abs(window.lab.state.q[joint]-target)<tolerance,{joint,target,tolerance},{polling:50});
  const waitStowed=async()=>{
   await waitQ('door_latch_angle',0,.003);
   const t=await page.evaluate(()=>window.lab.state.time);
   await page.waitForFunction(t=>window.lab.state.time>t+.3&&Math.abs(window.lab.state.q.door_latch_angle)<.003,t,{polling:50});
  };
  const command=async(joint,target)=>page.locator('input[data-read="'+joint+'"]').evaluate((el,target)=>{
   el.value=String(target*Number(el.dataset.scale));el.dispatchEvent(new Event('change',{bubbles:true}));
  },target);
  const capture=async name=>{
   if(!await page.evaluate(()=>window.lab.state.paused)){await page.click('#pause');await page.waitForFunction(()=>window.lab.state.paused);}
   await page.evaluate(()=>window.__afmPocketCamera());
   assert.equal(await page.evaluate(()=>window.lab.renderCurrentFrame()),true);
   assert.equal(await page.evaluate(()=>document.querySelector('#canvas canvas').getContext('webgl2').getError()),0);
   const file='afm-'+name+'.png';await page.locator('#canvas').screenshot({path:path.join(out,file)});
   const state=await inspect();report.views.push({name,file,sha256:hash(fs.readFileSync(path.join(out,file))),state});save();
   await page.click('#pause');await page.waitForFunction(()=>!window.lab.state.paused);return state;
  };
  function stowed(state){
   const {min,max}=state.bounds,p=geometry.door_pocket_door_local_bounds_mm;
   assert.ok(state.vertices>100);
   assert.ok(max[0]<=geometry.door_nominal_exterior_plane_door_local_x_mm/1000+.0002,'Closed blade must remain recessed behind the door exterior');
   assert.ok(min[0]>=p.x[0]/1000-.0002&&min[1]>=p.y[0]/1000-.0002&&max[1]<=p.y[1]/1000+.0002);
   assert.ok(min[2]>=p.z[0]/1000-.0002&&max[2]<=p.z[1]/1000+.0002,'Closed blade must fit inside the real vertical pocket');
   return {check:'Closed handle fits in recessed pocket',exterior_clearance_m:geometry.door_nominal_exterior_plane_door_local_x_mm/1000-max[0],passed:true};
  }
  await waitStowed();const initial=await capture('handle-stowed');report.checks.push(stowed(initial));
  await command('door_angle',-1.65);const start=await page.evaluate(()=>window.lab.state.time);
  await page.waitForFunction(t=>window.lab.state.time>t+.6,start,{polling:50});
  assert.ok(Math.abs((await inspect()).q.door_angle)<.03,'Stowed latch must block opening');
  await command('door_angle',0);report.checks.push({check:'Door remains locked with handle stowed',passed:true});
  const deployed=geometry.door_deployed_angle_rad;
  await command('door_latch_angle',deployed);await waitQ('door_latch_angle',deployed);
  const lifted=await capture('handle-deployed');
  assert.ok(lifted.bounds.max[0]-initial.bounds.max[0]>.075,'Handle must physically lift outward');
  assert.ok(lifted.bounds.min[2]-initial.bounds.min[2]>.065,'Distal end must rise from its stowed position');
  report.checks.push({check:'Folding blade extends outward and upward at deployment',passed:true});
  await command('door_angle',-1.65);await waitQ('door_angle',-1.65);
  await capture('pocket-door-open');report.checks.push({check:'Released door opens with deployed handle',passed:true});
  await command('door_angle',0);await waitQ('door_angle',0);
  await command('door_latch_angle',0);await waitStowed();
  const closed=await capture('handle-restowed');report.checks.push(stowed(closed));
  assert.ok(Math.abs(closed.q.door_angle)<.03);
  report.checks.push({check:'Door closes and handle returns into pocket',passed:true});
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.error=error.stack;throw error;}finally{save();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
