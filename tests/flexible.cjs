// Combined cable travel/rotation checks with independent native attachment poses.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.resolve(__dirname,'../test-results');
fs.mkdirSync(out,{recursive:true});
const report={url,started_utc:new Date().toISOString(),checks:[],passed:false};
const save=()=>fs.writeFileSync(out+'/flexible.json',JSON.stringify(report,null,2)+'\n');save();
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
 try{
  const page=await browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  report.checks=await page.evaluate(async()=>{
   const T=await import('three'),{GLTFLoader}=await import('./vendor/three/GLTFLoader.js'),{FlexibleDetails}=await import('./flexible-details.js?v=contact1');
   const {default:load}=await import('./vendor/mujoco/mujoco.js'),mj=await load();
   const catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments,results=[];
   const toThree=p=>new T.Vector3(p[0],p[2],-p[1]);
   const names=(m,kind,count)=>Object.fromEntries(Array.from({length:count},(_,i)=>{const v=m[kind](i),name=v.name;v.delete();return[name,i];}));
   for(const key of ['nikon','transfer','probe']){
    const item=catalog.find(x=>x.id===key);
    const [bytes,meta,xml]=await Promise.all([fetch(item.glb).then(r=>r.arrayBuffer()),fetch(item.metadata).then(r=>r.json()),fetch(item.physics).then(r=>r.text())]);
    const scene=(await new GLTFLoader().parseAsync(bytes,location.href)).scene,flex=new FlexibleDetails(T);flex.attach(scene);
    const count={nikon:1,transfer:4,probe:2}[key];if(flex.parts.length!==count)throw Error(key+' expected '+count+' flexible meshes');
    const m=mj.MjModel.from_xml_string(xml),d=new mj.MjData(m),bodies=names(m,'body',m.nbody),jids=names(m,'jnt',m.njnt);
    const joints=Object.fromEntries(Object.entries(jids).map(([name,id])=>[name,{range:Array.from(m.jnt_range.slice(2*id,2*id+2))}]));
    const zero=Object.fromEntries(flex.parts.flatMap(p=>[...p.inputs.map(i=>i.joint),...(p.rotation?.joints||[])].map(n=>[n,0])));
    for(const part of flex.parts){
     const data=part.mesh.userData,restWorld=[];
     flex.update(zero);
     for(let i=0;i<part.position.count;i++)restWorld.push(new T.Vector3().fromBufferAttribute(part.position,i).applyMatrix4(part.mesh.matrixWorld));
     const cases=part.rotation?[[-1,-1],[-1,1],[1,-1],[1,1],[0,-1],[0,1],[0,0]]:[[-1,0],[1,0],[0,0]];
     for(const [translation,rotation] of cases){
      const q={...zero},delta=new T.Vector3();
      for(const input of data.flex_joints||(data.flex_joint?[{name:data.flex_joint,axis:data.flex_axis||[0,0,1]}]:[])){
       const value=translation===0?0:joints[input.name].range[translation<0?0:1];q[input.name]=value;delta.addScaledVector(toThree(input.axis),value);
      }
      let angle=0;
      for(const name of data.flex_rotation?.joints||[]){const range=name===meta.service_envelope?.coarse_joint?meta.service_envelope.coarse_range_rad:joints[name].range;q[name]=rotation===0?0:range[rotation<0?0:1];angle+=q[name];}
      flex.update(q);mj.mj_resetData(m,d);
      for(const [name,value] of Object.entries(q))d.qpos[m.jnt_qposadr[jids[name]]]=value;
      mj.mj_forward(m,d);
      const pivot=data.flex_rotation?toThree(data.flex_rotation.pivot_m):new T.Vector3();
      const axis=data.flex_rotation?toThree(data.flex_rotation.axis).normalize():new T.Vector3(0,1,0);
      let maxError=0,fixedCount=0,movingCount=0,maxFixed=0,minHeight=Infinity;
      for(let i=0;i<part.position.count;i++){
       const actual=new T.Vector3().fromBufferAttribute(part.position,i).applyMatrix4(part.mesh.matrixWorld);
       minHeight=Math.min(minHeight,actual.y);
       const expected=restWorld[i].clone().sub(pivot).applyAxisAngle(axis,angle*part.weights[i]).add(pivot).addScaledVector(delta,part.weights[i]);
       maxError=Math.max(maxError,actual.distanceTo(expected));
       if(part.weights[i]<1e-7){fixedCount++;maxFixed=Math.max(maxFixed,actual.distanceTo(restWorld[i]));}
       if(part.weights[i]>1-1e-7)movingCount++;
      }
      let endpointError=0;
      if(data.flex_end_body){
       const id=bodies[data.flex_end_body];if(id===undefined)throw Error('Missing native attachment body');
       const local=new T.Vector3(...data.flex_end_local_m),p=Array.from(d.xpos.slice(3*id,3*id+3)),r=Array.from(d.xmat.slice(9*id,9*id+9));
       const native=local.applyMatrix3(new T.Matrix3().set(...r)).add(new T.Vector3(...p));
       const expected=toThree(data.flex_path_m.at(-1)).sub(pivot).applyAxisAngle(axis,angle).add(pivot).add(delta);
       endpointError=expected.distanceTo(toThree(native.toArray()));
      }else if(part.rotation)throw Error('Rotating hose lacks native endpoint metadata');
      results.push({check:key+' '+part.mesh.name+' translation '+translation+' rotation '+rotation,passed:fixedCount>0&&movingCount>0&&maxError<2e-7&&maxFixed<2e-7&&endpointError<2e-7&&(key!=='nikon'||minHeight>0),max_vertex_error_m:maxError,native_attachment_error_m:endpointError,fixed_vertices:fixedCount,moving_vertices:movingCount,minimum_world_height_m:minHeight});
     }
    }
    flex.update(zero);let maxRest=0;
    for(const p of flex.parts)for(let i=0;i<p.rest.length;i++)maxRest=Math.max(maxRest,Math.abs(p.rest[i]-p.position.array[i]));
    results.push({check:key+' returns to rest without accumulated deformation',passed:maxRest<2e-7,max_local_error_m:maxRest});
    d.delete();m.delete();scene.traverse(o=>o.geometry?.dispose());
   }
   return results;
  });
 }finally{await browser.close();}
 report.checked_utc=new Date().toISOString();report.passed=report.checks.length>0&&report.checks.every(x=>x.passed);save();console.log(JSON.stringify(report,null,2));assert.equal(report.passed,true);
})().catch(e=>{report.error=e.message;report.passed=false;save();console.error(e);process.exit(1);});
