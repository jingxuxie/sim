// Validate overlay vertices/properties against the compiled MuJoCo WASM model.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const url=process.env.LAB_TEST_URL||'http://localhost:8000/';
const out=process.env.LAB_TEST_OUTPUT||path.resolve(__dirname,'../test-results');fs.mkdirSync(out,{recursive:true});
const report={url,started_utc:new Date().toISOString(),checks:[],passed:false};
const save=()=>fs.writeFileSync(out+'/contact-shapes.json',JSON.stringify(report,null,2)+'\n');save();
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
 try{
  const page=await browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  report.checks=await page.evaluate(async()=>{
   const T=await import('three'),{ContactOverlay}=await import('./contact-overlay.js?v=contact1');
   const {default:load}=await import('./vendor/mujoco/mujoco.js'),mj=await load(),results=[];
   const catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments;
   const toNative=p=>new T.Vector3(p.x,-p.z,p.y);
   const maxDiff=(a,b)=>Math.max(...a.map((x,i)=>Math.abs(x-b[i])));
   const names=(m,kind,count)=>Object.fromEntries(Array.from({length:count},(_,i)=>{const v=m[kind](i),name=v.name;v.delete();return[name,i];}));
   for(const item of catalog){
    const [xml,data]=await Promise.all([fetch(item.physics).then(r=>r.text()),fetch(item.collision).then(r=>r.json())]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(xml)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==data.physics_sha256)throw Error(item.id+' collision data belongs to different physics XML');
    const m=mj.MjModel.from_xml_string(xml),d=new mj.MjData(m),scene=new T.Scene(),overlay=new ContactOverlay(T,scene,data);
    const geoms=names(m,'geom',m.ngeom),bodies=names(m,'body',m.nbody);
    const types=Object.fromEntries(['plane','sphere','capsule','ellipsoid','cylinder','box'].map(k=>[mj.mjtGeom['mjGEOM_'+k.toUpperCase()].value,k]));
    let metadataError=0;
    for(const shape of data.shapes){
     const i=geoms[shape.name];if(i===undefined||shape.type!==types[m.geom_type[i]]||bodies[shape.body]!==m.geom_bodyid[i])throw Error(item.id+' shape identity mismatch');
     for(const [name,size] of [['size',3],['pos',3],['quat',4],['friction',3]])metadataError=Math.max(metadataError,maxDiff(shape[name],Array.from(m['geom_'+name].slice(size*i,size*i+size))));
     for(const name of ['contype','conaffinity','condim'])if(shape[name]!==m['geom_'+name][i])throw Error(item.id+' '+name+' differs');
    }
    for(const [name,body] of Object.entries(data.bodies)){
     const i=bodies[name];metadataError=Math.max(metadataError,Math.abs(body.mass_kg-m.body_mass[i]),maxDiff(body.diagonal_inertia_kg_m2,Array.from(m.body_inertia.slice(3*i,3*i+3))));
     let movable=false;for(let b=i;b;b=m.body_parentid[b])movable||=m.body_jntnum[b]>0;
     if(body.anchored_to_world===movable)throw Error(item.id+' anchored status differs');
    }
    const collidable=Array.from({length:m.ngeom},(_,i)=>i).filter(i=>m.geom_contype[i]||m.geom_conaffinity[i]);
    results.push({check:item.id+' compiled collision properties and XML fingerprint',passed:data.shapes.length===collidable.length&&metadataError<1e-10,shapes:data.shapes.length,max_property_error:metadataError});
    for(const fraction of [0,-.8,.8]){
     mj.mj_resetData(m,d);
     for(let j=0;j<m.njnt;j++)if(m.jnt_type[j]===mj.mjtJoint.mjJNT_HINGE.value||m.jnt_type[j]===mj.mjtJoint.mjJNT_SLIDE.value){
      const lo=m.jnt_range[2*j],hi=m.jnt_range[2*j+1];
      d.qpos[m.jnt_qposadr[j]]=fraction===0?0:m.jnt_limited[j]?(lo+hi)/2+fraction*(hi-lo)/2:fraction;
     }
     mj.mj_forward(m,d);const poses={};
     for(const [name,id] of Object.entries(bodies))poses[name]={p:Array.from(d.xpos.slice(3*id,3*id+3)),q:Array.from(d.xquat.slice(4*id,4*id+4))};
     overlay.update(poses);overlay.root.updateMatrixWorld(true);let maxCenter=0,maxSurface=0;
     for(const shape of data.shapes){
      const i=geoms[shape.name],mesh=overlay.root.getObjectByName(shape.name),center=new T.Vector3(...d.geom_xpos.slice(3*i,3*i+3));
      maxCenter=Math.max(maxCenter,toNative(mesh.getWorldPosition(new T.Vector3())).distanceTo(center));
      const inverse=new T.Matrix3().set(...d.geom_xmat.slice(9*i,9*i+9)).transpose(),vertices=mesh.geometry.attributes.position,s=shape.size;
      for(let v=0;v<vertices.count;v++){
       const p=toNative(new T.Vector3().fromBufferAttribute(vertices,v).applyMatrix4(mesh.matrixWorld)).sub(center).applyMatrix3(inverse),a=[Math.abs(p.x),Math.abs(p.y),Math.abs(p.z)];let error;
       if(shape.type==='box')error=Math.max(Math.min(...a.map((x,k)=>Math.abs(x-s[k]))),...a.map((x,k)=>x-s[k]));
       else if(shape.type==='sphere')error=Math.abs(p.length()-s[0]);
       else if(shape.type==='ellipsoid')error=Math.abs(Math.hypot(...a.map((x,k)=>x/s[k]))-1)*Math.max(...s);
       else if(shape.type==='cylinder'){const r=Math.hypot(p.x,p.y);error=Math.max(Math.min(Math.abs(r-s[0]),Math.abs(a[2]-s[1])),r-s[0],a[2]-s[1]);}
       else if(shape.type==='capsule')error=Math.abs(Math.hypot(p.x,p.y,Math.max(0,a[2]-s[1]))-s[0]);
       else error=a[2];
       maxSurface=Math.max(maxSurface,error);
      }
     }
     results.push({check:item.id+' contact overlay transforms at pose '+fraction,passed:maxCenter<1e-10&&maxSurface<2e-7,max_center_error_m:maxCenter,max_surface_error_m:maxSurface});
    }
    overlay.dispose();if(scene.children.length)throw Error('Overlay not disposed');d.delete();m.delete();
   }
   return results;
  });
 }finally{await browser.close();}
 report.checked_utc=new Date().toISOString();report.passed=report.checks.length>0&&report.checks.every(x=>x.passed);save();console.log(JSON.stringify(report,null,2));assert.equal(report.passed,true);
})().catch(e=>{report.error=e.message;report.passed=false;save();console.error(e);process.exit(1);});
