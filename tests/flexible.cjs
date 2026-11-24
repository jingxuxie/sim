// Test exported cable geometry in the browser coordinate system at travel limits.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.resolve(__dirname,'../test-results');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
 let checks;
 try{
  const page=await browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  checks=await page.evaluate(async native=>{
   const T=await import('three'),{GLTFLoader}=await import('./vendor/three/GLTFLoader.js'),{FlexibleDetails}=await import('./flexible-details.js?v=realism4');
   const catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments,results=[];
   const paths={transfer:['001_transfer_stage','transfer_station'],probe:['002_probe_station','probe_station']};
   for(const key of ['transfer','probe']){
    const item=catalog.find(x=>x.id===key),[folder,stem]=paths[key];
    const modelURL=native?new URL('../../'+folder+'/assets/'+stem+'.glb',location.href).href:item.glb;
    const metadataURL=native?new URL('../../'+folder+'/asset.json',location.href).href:item.metadata;
    const [bytes,meta]=await Promise.all([fetch(modelURL).then(r=>r.arrayBuffer()),fetch(metadataURL).then(r=>r.json())]);
    const scene=(await new GLTFLoader().parseAsync(bytes,location.href)).scene,flex=new FlexibleDetails(T);flex.attach(scene);
    if(flex.parts.length!==2)throw Error(key+' expected two independently deforming cables');
    const joints=Object.fromEntries(Object.values(meta.links).filter(x=>x.joint).map(x=>[x.joint.name,x.joint]));
    for(const part of flex.parts){
     const restWorld=[];for(let i=0;i<part.position.count;i++)restWorld.push(new T.Vector3().fromBufferAttribute(part.position,i).applyMatrix4(part.mesh.matrixWorld));
     for(const direction of [-1,1,0]){
      const q=Object.fromEntries(flex.parts.flatMap(p=>p.inputs.map(i=>[i.joint,0]))),expected=new T.Vector3();
      for(const input of part.inputs){const value=direction===0?0:joints[input.joint].range[direction<0?0:1];q[input.joint]=value;
       const worldAxis=input.axis.clone().transformDirection(part.mesh.matrixWorld);expected.addScaledVector(worldAxis,value);}
      flex.update(q);let maxError=0,fixedCount=0,movingCount=0,maxFixed=0,maxMoving=0;
      for(let i=0;i<part.position.count;i++){
       const displacement=new T.Vector3().fromBufferAttribute(part.position,i).applyMatrix4(part.mesh.matrixWorld).sub(restWorld[i]);
       maxError=Math.max(maxError,displacement.clone().sub(expected.clone().multiplyScalar(part.weights[i])).length());
       if(part.weights[i]<1e-7){fixedCount++;maxFixed=Math.max(maxFixed,displacement.length());}
       if(part.weights[i]>1-1e-7){movingCount++;maxMoving=Math.max(maxMoving,displacement.clone().sub(expected).length());}
      }
      results.push({check:key+' '+part.mesh.name+' travel '+direction,passed:fixedCount>0&&movingCount>0&&maxError<2e-7&&maxFixed<2e-7&&maxMoving<2e-7,max_vertex_error_m:maxError,fixed_vertices:fixedCount,moving_vertices:movingCount});
     }
    }
    scene.traverse(o=>{o.geometry?.dispose();});
   }
   return results;
  },!!process.env.LAB_NATIVE_FLEX);
 }finally{await browser.close();}
 const report={url,native_sources:!!process.env.LAB_NATIVE_FLEX,checks,passed:checks.every(x=>x.passed)};
 fs.writeFileSync(out+'/flexible.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert.equal(report.passed,true);
})().catch(e=>{console.error(e);process.exit(1);});
