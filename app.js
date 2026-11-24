import {FlexibleDetails} from './flexible-details.js?v=realism4';
import {BrowserRuntime} from './runtime.js?v=realism4';
window.viewerBooted=true;
const $=id=>document.getElementById(id), fmt=(x,d=3)=>Number(x).toFixed(d);
let instruments=[],current=null,renderer=null,scene,camera,orbit,model=null,ground=null,THREE,ready=false,selection=0,lastState=null,photograph=false;
let flexibleDetails;
let viewDirty=true,poseNodes={},inspectionLight,composer,occlusion,studio,renderFrames=0,modelAbort=null;const baseURL=new URL('./',location.href).href;
let gpuFrame=null,completedFrame=0,gpuSyncSupported=true,modelLoading=false;
function error(message){$('error').hidden=!message;$('error').textContent=message;}
let physicsReady=false,cameraEnabled=false,operationBusy=false;
const runtime=new BrowserRuntime(s=>state(s),message=>{$('physics-status').textContent=message;},message=>error('Simulator stopped: '+message));
window.lab={runtime,get state(){return lastState;},get rendering(){return{submitted:renderFrames,completed:completedFrame,pending:!!gpuFrame};}};
function frameReady(){
 const gl=renderer.getContext();
 if(gl.isContextLost()){if(gpuFrame)gl.deleteSync(gpuFrame.sync);gpuFrame=null;viewDirty=true;return false;}
 if(!gpuFrame)return true;
 const status=gl.clientWaitSync(gpuFrame.sync,0,0);
 if(status===gl.TIMEOUT_EXPIRED)return false;
 gl.deleteSync(gpuFrame.sync);completedFrame=gpuFrame.id;gpuFrame=null;
 if(status===gl.WAIT_FAILED){gpuSyncSupported=false;console.warn('GPU synchronization unavailable; using normal rendering.');}
 return true;
}
function renderView(){
 if(composer)composer.render();else renderer.render(scene,camera);
 const gl=renderer.getContext(),id=++renderFrames;
 if(gpuFrame)gl.deleteSync(gpuFrame.sync);
 const sync=gpuSyncSupported&&gl.fenceSync?gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0):null;
 gpuFrame=sync?{id,sync}:null;
 if(sync)gl.flush();else{gpuSyncSupported=false;completedFrame=id;}
 return id;
}
async function finishFrame(id,token){
 if(token!==selection)return false;
 if(renderer.getContext().isContextLost())throw Error('WebGL context was lost; reopen the instrument to retry');
 const start=performance.now();
 while(completedFrame<id){
  if(token!==selection)return false;
  if(renderer.getContext().isContextLost())throw Error('WebGL context was lost; reopen the instrument to retry');
  frameReady();
  if(completedFrame>=id)break;
  if(performance.now()-start>60000)throw Error('The graphics device took too long to render the model');
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 return token===selection;
}
async function send(op,extra={}){
 if(!current||!physicsReady)return;
 const key=current.id;
 try{
  if(op==='task'){$('run').disabled=true;$('manual').disabled=true;operationBusy=true;}
  const s=await runtime.request(op,extra);
  if(s?.asset===current?.id)state(s);
  error('');
 }catch(e){if(current?.id===key)error('Control failed: '+e.message);}
 finally{operationBusy=false;if(current?.id===key){$('run').disabled=false;$('manual').disabled=false;}}
}
async function setup3D(){
 const mods=await Promise.all([import('three'),import('./vendor/three/OrbitControls.js'),import('./studio-renderer.js')]);THREE=mods[0];flexibleDetails=new FlexibleDetails(THREE);
 scene=new THREE.Scene();scene.background=new THREE.Color(0xd2d4d1);camera=new THREE.PerspectiveCamera(32,1,.001,20);
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=1.15;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.VSMShadowMap;renderer.shadowMap.autoUpdate=false;$('canvas').append(renderer.domElement);
 studio=new mods[2].LabStudio(renderer,scene);ground=studio.ground;
 // Load the local room HDR independently; a failed environment request cannot block the model.
 (async()=>{const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);try{const {RGBELoader}=await import('./vendor/three/RGBELoader.js');const response=await fetch('./assets/lighting/studio_small_09_1k.hdr',{signal:abort.signal});if(!response.ok)throw Error(response.status);const data=new RGBELoader().parse(await response.arrayBuffer());const texture=new THREE.DataTexture(data.data,data.width,data.height,THREE.RGBAFormat,data.type);texture.colorSpace=THREE.LinearSRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.flipY=true;texture.needsUpdate=true;studio.setEnvironment(texture);texture.dispose();viewDirty=true;}catch(e){console.warn('Room reflections unavailable; using built-in studio lighting.',e);}finally{clearTimeout(timer);}})();
 inspectionLight=new THREE.PointLight(0x80ff5a,.025,.35,2);inspectionLight.position.set(0,.24,-.05);inspectionLight.visible=false;scene.add(inspectionLight);
 orbit=new mods[1].OrbitControls(camera,renderer.domElement);orbit.minDistance=.025;orbit.maxDistance=3;orbit.enableDamping=true;orbit.addEventListener('change',()=>viewDirty=true);
 try{const effects=await Promise.all([import('./vendor/three/EffectComposer.js'),import('./vendor/three/RenderPass.js'),import('./vendor/three/SSAOPass.js'),import('./vendor/three/OutputPass.js')]);
 // Canvas antialiasing does not reach postprocessing targets; multisample those too.
 const target=new THREE.WebGLRenderTarget(512,512,{type:THREE.HalfFloatType});target.samples=renderer.capabilities.isWebGL2?4:0;
 composer=new effects[0].EffectComposer(renderer,target);composer.addPass(new effects[1].RenderPass(scene,camera));occlusion=new effects[2].SSAOPass(scene,camera,512,512,16);
 // Bound AO to subtle local cavity shading. It must not paint dark silhouettes
 // around the model or treat transmissive glazing as an opaque wall.
 occlusion.ssaoMaterial.fragmentShader=occlusion.ssaoMaterial.fragmentShader.replace('1.0 - occlusion','1.0 - 0.28 * occlusion');
 const renderAO=occlusion.render.bind(occlusion);occlusion.render=(...args)=>{const hidden=[];scene.traverse(o=>{if(o.isMesh&&o.visible&&(o===studio.contact||[].concat(o.material).some(m=>(m.transmission||0)>.1||(m.transparent&&m.opacity<.45)))){hidden.push(o);o.visible=false;}});try{renderAO(...args);}finally{for(const o of hidden)o.visible=true;}};
 composer.addPass(occlusion);const output=new effects[3].OutputPass();
 // A moderate photographic contrast look after AgX, before display transfer.
 // This preserves the imported surface maps and keeps black coatings black.
 output.material.fragmentShader=output.material.fragmentShader.replace('// color space',`vec3 filmLow=pow(clamp(gl_FragColor.rgb,0.0,1.0),vec3(1.28));
 vec3 filmHigh=pow(clamp(1.0-gl_FragColor.rgb,0.0,1.0),vec3(1.28));
 gl_FragColor.rgb=filmLow/max(filmLow+filmHigh,vec3(0.00001));
 // color space`);composer.addPass(output);}catch(e){console.warn('Ambient shadows unavailable; using direct rendering.',e);composer=null;}
 new ResizeObserver(()=>{const w=$('canvas').clientWidth,h=$('canvas').clientHeight;if(w&&h){renderer.setSize(w,h,false);composer?.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();viewDirty=true;}}).observe($('canvas'));
 // Keep at most one rendered frame in flight. This retains every quality
 // setting while preventing slow GPUs from accumulating obsolete poses.
 function draw(){requestAnimationFrame(draw);if(document.hidden||$('workspace').hidden||photograph||modelLoading)return;orbit.update();if(!frameReady())return;if(studio.update(model))viewDirty=true;if(viewDirty){syncProjection();renderView();viewDirty=false;}}
 draw();ready=true;
}
let threePromise;
function syncProjection(){
 // Millimetre-scale near planes at metre viewing distances lose depth
 // precision on the bench. Keep the frustum fitted as the user zooms.
 camera.near=Math.max(.0001,camera.position.distanceTo(orbit.target)*.01);camera.updateProjectionMatrix();
 if(occlusion){const u=occlusion.ssaoMaterial.uniforms;u.cameraNear.value=camera.near;u.cameraFar.value=camera.far;u.cameraProjectionMatrix.value.copy(camera.projectionMatrix);u.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);occlusion.minDistance=studio.extent*.0004/(camera.far-camera.near);occlusion.maxDistance=studio.extent*.035/(camera.far-camera.near);}
}
function cameraView(detail=false){if(!model)return;const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());let extent=Math.max(size.x,size.y,size.z);const physicalExtent=extent;
 if(detail){const targets={nikon:[.03,.145,.06],transfer:[-.02,.17,.02],probe:[0,.175,.03],zeiss:[0,.20,.07],bonder:[.02,.12,.11],afm:[0,.20,.05],tweezers:[.06,.01,0]};center.set(...targets[current.id]);extent*=current.id==='tweezers'?.38:.45;}
 if(!detail&&current.id==='afm'){center.x-=.07;extent*=1.12;}
 camera.near=Math.max(.0001,physicalExtent*.001);camera.far=Math.max(5,physicalExtent*20);camera.updateProjectionMatrix();
 if(occlusion){occlusion.kernelRadius=physicalExtent*.012;occlusion.minDistance=physicalExtent*.0004/(camera.far-camera.near);occlusion.maxDistance=physicalExtent*.035/(camera.far-camera.near);}
 orbit.target.copy(center);const dist=extent*2.65*Math.max(1,1/camera.aspect);camera.position.copy(center).add(new THREE.Vector3(.62,.52,1.12).normalize().multiplyScalar(dist));orbit.update();viewDirty=true;}
function disposeModel(object){const geometries=new Set(),materials=new Set(),textures=new Set(),images=new Set();object.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)for(const material of [].concat(o.material))materials.add(material);});for(const material of materials){for(const value of Object.values(material))if(value?.isTexture)textures.add(value);material.dispose();}for(const texture of textures){texture.dispose();if(texture.image)images.add(texture.image);}for(const image of images)if(typeof image.close==='function')image.close();for(const geometry of geometries)geometry.dispose();}
async function modelBytes(url,token){const c=new AbortController();modelAbort=c;let timer=setTimeout(()=>c.abort(),20000);try{const r=await fetch(url,{signal:c.signal,cache:'no-cache'});if(!r.ok)throw Error('Model download HTTP '+r.status);const total=+r.headers.get('content-length')||current.size,reader=r.body.getReader(),chunks=[];let count=0;
 for(;;){const {done,value}=await reader.read();if(done)break;clearTimeout(timer);timer=setTimeout(()=>c.abort(),20000);chunks.push(value);count+=value.length;if(token===selection)$('model-status').textContent='Loading model '+Math.round(100*count/total)+'% · '+fmt(count/1048576,1)+' MB';}
 const bytes=new Uint8Array(count);let at=0;for(const v of chunks){bytes.set(v,at);at+=v.length;}return bytes.buffer;}finally{clearTimeout(timer);if(modelAbort===c)modelAbort=null;}}
function updateDemo(){const task=current?.tasks.find(t=>t.id===$('task').value),url=task?.demo||current?.demo;$('recorded-demo').hidden=!url;if(url)$('recorded-demo').href=url;$('recorded-demo').textContent=task?.demo?'Watch this task’s recording ↗':'Watch instrument demonstration ↗';$('confirm-focus').hidden=!task?.requires_finish;}
async function openInstrument(item){const token=++selection;modelAbort?.abort();current=item;physicsReady=false;cameraEnabled=false;operationBusy=false;$('enable-camera').hidden=false;$('specimen-image').hidden=true;lastState=null;photograph=false;$('gallery').hidden=true;$('workspace').hidden=false;$('title').textContent=item.title;$('poster').src=item.preview;$('full-render').href=item.render;$('poster').hidden=false;$('model-status').textContent='Starting 3D view…';$('task-status').textContent='Ready to explore';error('');buildControls(item);$('specimen-panel').hidden=!item.specimen_camera;$('specimen-image').removeAttribute('src');$('specimen-caption').textContent='Enable the image to load the optical simulator. Synthetic specimen; estimated optics.';
 $('task').replaceChildren(...item.tasks.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.title;return o;}));
 updateDemo();
 for(const e of $('workspace').querySelectorAll('aside button,aside input,aside select'))e.disabled=true;
 $('physics-status').textContent='Starting live physics…';
 runtime.open(item).then(s=>{
  if(token!==selection)return;physicsReady=true;state(s);
  for(const e of $('workspace').querySelectorAll('aside button,aside input,aside select'))e.disabled=false;
 }).catch(e=>{if(token===selection)error('Physics could not start: '+e.message);});
 try{
  threePromise??=setup3D();await threePromise;if(token!==selection)return;modelLoading=true;
  inspectionLight.visible=item.id==='afm';
  if(model){scene.remove(model);disposeModel(model);model=null;poseNodes={};}
  const bytes=await modelBytes(item.glb,token);if(token!==selection)return;$('model-status').textContent='Preparing detailed geometry…';await new Promise(r=>setTimeout(r,0));
  const {GLTFLoader}=await import('./vendor/three/GLTFLoader.js');const gltf=await new GLTFLoader().parseAsync(bytes,baseURL);if(token!==selection){disposeModel(gltf.scene);return;}
  model=gltf.scene;model.traverse(o=>{if(o.isMesh){o.castShadow=![].concat(o.material).some(m=>(m.transmission||0)>.1||(m.transparent&&m.opacity<.45));o.receiveShadow=true;for(const m of [].concat(o.material)){for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap'])if(m[key])m[key].anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}}});scene.add(model);flexibleDetails.attach(model);poseNodes={};model.traverse(o=>poseNodes[o.name]=o);studio.fit(new THREE.Box3().setFromObject(model));cameraView();if(lastState){applyPoses(lastState.poses);flexibleDetails.update(lastState.q);}$('poster').hidden=false;
  // Keep the preview visible until the initial GPU frame actually completes.
  if(gpuFrame&&!await finishFrame(gpuFrame.id,token))return;
  studio.update(model,true);syncProjection();if(!await finishFrame(renderView(),token))return;$('poster').hidden=!photograph;$('model-status').textContent='3D view ready';viewDirty=true;
 }catch(e){if(token!==selection)return;console.error(e);$('model-status').textContent='3D view unavailable: '+e.message+'. The preview remains available. Try a current browser with WebGL enabled.';error('3D loading stopped. Return to All instruments and reopen it to retry.');}
 finally{if(token===selection)modelLoading=false;}
}
function applyPoses(poses){if(!model||!poses)return;const basis=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2),inv=basis.clone().invert();model.updateMatrixWorld(true);let moved=false;
 for(const [name,p] of Object.entries(poses)){const node=poseNodes[name];if(!node)continue;const values=[...p.p,...p.q],previous=node.userData.lastRenderPose;if(!previous||values.some((v,i)=>Math.abs(v-previous[i])>1e-7)){moved=true;node.userData.lastRenderPose=values;}const world=new THREE.Matrix4().compose(new THREE.Vector3(p.p[0],p.p[2],-p.p[1]),basis.clone().multiply(new THREE.Quaternion(p.q[1],p.q[2],p.q[3],p.q[0])).multiply(inv),new THREE.Vector3(1,1,1));if(node.parent){node.parent.updateWorldMatrix(true,false);world.premultiply(node.parent.matrixWorld.clone().invert());}world.decompose(node.position,node.quaternion,node.scale);node.updateMatrixWorld(true);}
 if(moved){viewDirty=true;if(studio)studio.dirty=true;renderer.shadowMap.needsUpdate=true;}
}
const nikonControls=[['X stage wheel','kx','x_angle',-12.2,12.2],['Y stage wheel','ky','y_angle',-10.6,10.6],['Coarse focus','coarse','coarse_angle',-12.56,5],['Fine focus','fine','fine_angle',-12.56,12.56]];
function controlText(input,value){return input.dataset.toggle==='true'?(value>(Number(input.min)+Number(input.max))/2?input.dataset.onLabel:input.dataset.offLabel):fmt(value)+' '+input.dataset.unit;}
function buildRenderViews(item){
 let select=$('render-view');
 if(!select){select=document.createElement('select');select.id='render-view';select.setAttribute('aria-label','Additional rendered views');$('detail-still').after(select);}
 const first=document.createElement('option');first.value='';first.textContent='More rendered views';select.replaceChildren(first);
 for(const view of item.render_views||[]){const option=document.createElement('option');option.value=view.url;option.textContent=view.label;select.append(option);}
 select.hidden=!item.render_views?.length;select.value='';
 select.onchange=()=>{if(!select.value)return;photograph=true;$('poster').src=select.value;$('poster').alt='Static Blender render: '+select.selectedOptions[0].textContent;$('poster').hidden=false;$('full-render').href=select.value;};
}
function buildControls(item){buildRenderViews(item);$('controls').replaceChildren();let list=item.controls.map(c=>({name:c.name,joint:item.links[c.link].joint.name,read:item.links[c.link].joint.name,limits:item.links[c.link].joint.range||[-6.283,6.283],scale:c.display_scale??(c.units==='m'?1000:180/Math.PI),unit:c.display_unit??(c.units==='m'?'mm':'°'),toggle:c.ui==='toggle',offLabel:c.off_label,onLabel:c.on_label}));if(item.id==='nikon')list=nikonControls.map(([name,joint,read,lo,hi])=>({name,joint,read,limits:[lo,hi],scale:1/(2*Math.PI),unit:'turn'}));
 if(item.id==='nikon'){const row=document.createElement('div');row.className='control';const label=document.createElement('label');label.textContent='Objective turret';label.htmlFor='objective-select';const select=document.createElement('select');select.id='objective-select';for(const [i,mag] of ['20×','40×','Empty port','Empty port','Empty port','4×','10×'].entries()){const o=document.createElement('option');o.value=i;o.textContent=(i+1)+' · '+mag;select.append(o);}select.onchange=()=>send('command',{action:{turret:+select.value}});row.append(label,select);$('controls').append(row);}
 list=list.filter(c=>c.joint!=='light_path_travel');
 if(item.light_path){const row=document.createElement('div');row.className='control';const label=document.createElement('label');label.textContent='Camera / eyepiece split';label.htmlFor='light-path-select';const select=document.createElement('select');select.id='light-path-select';for(const [i,fraction] of item.light_path.camera_fractions.entries()){const option=document.createElement('option');option.value=item.light_path.positions_m[i];option.textContent=Math.round(fraction*100)+'% camera · '+Math.round((1-fraction)*100)+'% eye';select.append(option);}select.value=.012;select.title=item.light_path.calibration;select.onchange=()=>send('command',{action:{light_path_travel:+select.value}});row.append(label,select);$('controls').append(row);}
 if(item.id==='tweezers')for(const [i,axis] of ['X','Y','Z'].entries())list.push({name:'Handle '+axis,read:'handle_'+i,axis:i,limits:i===2?[.005,.08]:[-.14,.14],scale:1000,unit:'mm'});
 if(item.id==='tweezers')for(const [i,name] of ['Tool roll','Tool pitch','Tool yaw'].entries())list.push({name,read:'tool_rotation_'+i,rotationAxis:i,limits:i===2?[-Math.PI,Math.PI]:[-Math.PI/4,Math.PI/4],scale:180/Math.PI,unit:'°'});
 for(const c of list){const row=document.createElement('div');row.className='control';const label=document.createElement('label'),text=document.createElement('span'),out=document.createElement('output');text.textContent=c.name;label.append(text,out);const input=document.createElement('input');input.type='range';input.min=c.limits[0]*c.scale;input.max=c.limits[1]*c.scale;input.step=(input.max-input.min)/(c.toggle?1:1500);input.value=0;input.dataset.toggle=String(!!c.toggle);input.dataset.offLabel=c.offLabel||'Off';input.dataset.onLabel=c.onLabel||'On';input.setAttribute('aria-label',c.name);input.dataset.read=c.read;input.dataset.scale=c.scale;input.dataset.unit=c.unit;if(c.axis!==undefined)input.dataset.fixtureAxis=c.axis;if(c.rotationAxis!==undefined)input.dataset.rotationAxis=c.rotationAxis;input.oninput=()=>{out.textContent=controlText(input,+input.value);};input.onchange=()=>{let action;if(c.rotationAxis!==undefined){const q=lastState?.poses?.tool?.q??[1,0,0,0];const e=new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[1],q[2],q[3],q[0]),'ZYX');e[['x','y','z'][c.rotationAxis]]=+input.value/c.scale;const result=new THREE.Quaternion().setFromEuler(e);action={tool_quaternion:[result.w,result.x,result.y,result.z]};}else if(c.axis!==undefined){const p=[...(lastState?.poses?.tool?.p??[0,0,.012])];p[c.axis]=+input.value/c.scale;action={tool_position:p};}else action={[c.joint]:+input.value/c.scale};send('command',{action});};row.append(label,input);$('controls').append(row);}
}
function state(s){if(!current||s.asset!==current.id)return;lastState=s;applyPoses(s.poses);if(flexibleDetails?.update(s.q)){viewDirty=true;if(renderer)renderer.shadowMap.needsUpdate=true;}$('connection').textContent='Live MuJoCo · in your browser';
 for(const input of $('controls').querySelectorAll('input')){let val=input.dataset.fixtureAxis!==undefined?s.poses?.tool?.p[+input.dataset.fixtureAxis]:s.q[input.dataset.read];if(input.dataset.rotationAxis!==undefined&&THREE&&s.poses?.tool){const q=s.poses.tool.q;const e=new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[1],q[2],q[3],q[0]),'ZYX');val=e[['x','y','z'][+input.dataset.rotationAxis]];}if(val===undefined)continue;if(document.activeElement!==input)input.value=val*input.dataset.scale;input.previousSibling.lastChild.textContent=controlText(input,val*input.dataset.scale);}
 if(s.objective?.indexed&&$('objective-select')&&document.activeElement!==$('objective-select'))$('objective-select').value=s.objective.station-1;
 const splitter=$('light-path-select');if(splitter&&document.activeElement!==splitter){const travel=s.q.light_path_travel;const nearest=current.light_path.positions_m.reduce((a,b)=>Math.abs(b-travel)<Math.abs(a-travel)?b:a);splitter.value=Math.abs(nearest-travel)<.0005?String(nearest):'';}
 $('pause').textContent=s.paused?'Resume':'Pause';const m=s.metrics||{};$('task-status').textContent=s.failure?'Stopped · '+s.failure:s.success?'Task completed':s.done?'Time limit reached':s.paused?'Paused':s.running?'Baseline running':s.task?'Manual task control':'Ready to explore';
 const rows=[['Simulation time',fmt(s.time,2)+' s'],...(m.error_m!==undefined?[['Position error',fmt(m.error_m*1000)+' mm']]:[]),...(m.gap_m!==undefined?[['Tip clearance',fmt(m.gap_m*1000)+' mm']]:[]),...(m.defocus_m!==undefined?[['Defocus',fmt(m.defocus_m*1e6,2)+' µm']]:[]),[m.peak_contact_N!==undefined?'Peak contact':'Contact force',fmt(m.peak_contact_N??Math.max(0,...s.contacts.map(c=>c.normal_N)))+' N']];$('metrics').replaceChildren(...rows.map(([k,v])=>{const d=document.createElement('div');d.className='metric';for(const t of [k,v]){const x=document.createElement('span');x.textContent=t;d.append(x);}return d;}));
 $('events').replaceChildren(...(s.events||[]).map(e=>{const li=document.createElement('li');li.textContent=fmt(e.time,2)+' s · '+e.event.replaceAll('_',' ');return li;}));if(s.guard_events?.length&&s.time-s.guard_events.at(-1).time<3&&!s.success){$('task-status').textContent=s.guard_events.at(-1).reason;}
}
$('back').onclick=()=>{$('workspace').hidden=true;$('gallery').hidden=false;selection++;modelAbort?.abort();current=null;physicsReady=false;cameraEnabled=false;runtime.close();$('connection').textContent='Gallery ready · runs in your browser';error('');};$('brand').onclick=ev=>{ev.preventDefault();$('back').click();};$('run').onclick=()=>send('task',{task:$('task').value,seed:+$('seed').value,run:true});$('manual').onclick=()=>send('task',{task:$('task').value,seed:+$('seed').value,run:false});$('pause').onclick=()=>send('pause');$('reset').onclick=()=>send('reset');$('overview').onclick=()=>{photograph=false;$('poster').hidden=true;cameraView(false);};$('detail').onclick=()=>{photograph=false;$('poster').hidden=true;cameraView(true);};$('still').onclick=()=>{const same=$('poster').getAttribute('src')===current.render&&!$('poster').hidden;photograph=!same;$('poster').src=current.render;$('full-render').href=current.render;$('poster').alt='Static Blender render; live state is available in Full instrument';$('poster').hidden=!photograph;};
$('detail-still').onclick=()=>{photograph=true;$('poster').src=current.detail_render;$('poster').alt='Blender detail render';$('poster').hidden=false;$('full-render').href=current.detail_render;};
$('task').onchange=updateDemo;
$('confirm-focus').onclick=()=>send('finish');
try{const embedded=$('instrument-catalog');const r=embedded?JSON.parse(embedded.textContent):await (await fetch('./catalog.json')).json();instruments=r.instruments;$('connection').textContent=r.host+' · ready';for(const item of instruments){let card=$('cards').querySelector('[data-asset="'+item.id+'"]');if(!card){card=document.createElement('button');card.className='card';card.innerHTML='<img loading="lazy" alt=""><div class="caption"><div class="tag"></div><h2></h2><p></p></div>';card.querySelector('img').src=item.preview;card.querySelector('img').alt=item.title;card.querySelector('h2').textContent=item.title;card.querySelector('.tag').textContent='Interactive instrument';card.querySelector('p').textContent=item.tasks.length+' tasks · explore mechanisms';$('cards').append(card);}card.onclick=event=>{event.preventDefault();openInstrument(item);};}window.viewerReady=true;}catch(e){$('connection').textContent='Interactive controls unavailable';error('The render gallery remains available. Reload to retry interactive controls: '+e.message);}

async function pollSpecimen(){for(;;){if(physicsReady&&cameraEnabled&&!operationBusy&&current?.specimen_camera&&!document.hidden&&!$('workspace').hidden){const key=current.id;try{const frame=await runtime.request('specimen',{channel:$('optical-channel').value});if(current?.id===key&&cameraEnabled){$('specimen-image').hidden=false;$('specimen-image').src=frame.image;$('specimen-caption').textContent=frame.throughput>0?frame.magnification+'× · '+fmt(frame.field_width_m*1e6,0)+' µm field · '+Math.round(frame.throughput*100)+'% light · '+(frame.display_role==='latest controller exposure'?'Controller exposure at '+fmt(frame.time_s,2)+' s':key==='probe'?'Measured needle motion; estimated optics':'Simulated specimen; estimated optics'):(frame.optical_status||'Optical path blocked').replaceAll('_',' ');}}catch(e){if(current?.id===key){cameraEnabled=false;$('enable-camera').hidden=false;$('specimen-caption').textContent='Image stopped: '+e.message;}}}await new Promise(r=>setTimeout(r,1000));}}
$('enable-camera').onclick=()=>{cameraEnabled=true;$('enable-camera').hidden=true;$('specimen-caption').textContent='Loading optical simulator…';};
pollSpecimen();
