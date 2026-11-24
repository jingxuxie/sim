import loadMuJoCo from './vendor/mujoco/mujoco.js';
import {Simulation} from './physics.js?v=contact1';
import {loadPyodide} from './vendor/pyodide/pyodide.mjs';

let sim, py, pythonCore, pythonLoading, task=false, auto=false, paused=false, lastTick=performance.now(), lastPost=0, lastState;
const status=message=>postMessage({type:'status',message});
const publicState=s=>{
  const {arrays,targets,mocap_target,mocap_quat_target,...visible}=s;
  return {...visible,running:auto,paused,engine:'MuJoCo 4.0.1 · WebAssembly'};
};
function publish(s){lastState=s;postMessage({type:'state',state:publicState(s)});lastPost=performance.now();}
async function fetchText(url){const r=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error(`Could not load ${url}: HTTP ${r.status}`);return r.text();}

globalThis.physics_bridge=(op,payload)=>{
  if(!sim)throw Error('Load an instrument first');
  const p=JSON.parse(payload);let out;
  switch(op){
    case 'metadata':out=sim.metadata();break;
    case 'snapshot':out=sim.snapshot();break;
    case 'reset':out=sim.reset();break;
    case 'step':out=sim.step(p.action,p.seconds);break;
    case 'command':out=sim.command(p.action);break;
    case 'applyReset':out=sim.applyReset(p);break;
    default:throw Error('Unknown physics operation');
  }
  return JSON.stringify(out);
};

async function loadPythonCore(){
  // Initialize the Python WASM core before MuJoCo. This ordering avoids a
  // Chromium 134 worker crash when the second engine is initialized later.
  // NumPy/SciPy/Pillow and task code remain deferred until they are requested.
  pythonCore??=loadPyodide({indexURL:new URL('./vendor/pyodide/',import.meta.url).href,enableRunUntilComplete:false,stdout:()=>{},stderr:message=>console.warn(message)});
  return pythonCore;
}
async function loadPython(){
  if(py)return;
  if(pythonLoading)return pythonLoading;
  pythonLoading=(async()=>{
    status('Loading task and optical simulator (first use, about 20 MB)…');
    const runtime=await loadPythonCore();
    await runtime.loadPackage(['numpy','scipy','pillow'],{messageCallback:message=>status(message)});
    const sources=await Promise.all(['sim.py','tasks.py','imaging.py','optics.py','session.py'].map(async name=>[name,await fetchText(new URL('./python/'+name+'?v=contact1',import.meta.url))]));
    runtime.FS.mkdirTree('/app');for(const [name,source] of sources)runtime.FS.writeFile('/app/'+name,source);
    runtime.runPython("import sys\nsys.path.insert(0, '/app')\nimport session");py=runtime;
    status('Task and optical simulator ready');
  })().catch(e=>{pythonLoading=null;throw e;});
  return pythonLoading;
}
function python(op,args={}){
  py.globals.set('browser_request',JSON.stringify({op,...args}));
  return JSON.parse(py.runPython('session.rpc(browser_request)'));
}

// A bounded clock prevents a hidden tab or slow optical exposure from triggering
// an unbounded catch-up. Simulation time advances only when MuJoCo is stepped.
function clock(){
  try {
    if(sim&&!paused){
      const now=performance.now(),count=Math.min(5,Math.floor((now-lastTick)/20)),start=now;
      for(let i=0;i<count;i++){
        const state=task?python('tick',{auto}):sim.step();lastState=state;
        if(state.done){auto=false;paused=true;publish(state);break;}
        if(performance.now()-start>24)break;
      }
      if(count)lastTick=performance.now();
      if(lastState&&performance.now()-lastPost>90)publish(lastState);
    }else lastTick=performance.now();
  }catch(e){paused=true;auto=false;postMessage({type:'fatal',message:e.message});}
  setTimeout(clock,10);
}
clock();

let queue=Promise.resolve();
self.onmessage=({data:{id,op,...p}})=>{
  queue=queue.then(async()=>{
    let result;
    switch(op){
      case 'init':{
        status('Starting live MuJoCo physics…');
        await loadPythonCore();
        const [mj,xml,meta]=await Promise.all([loadMuJoCo(),fetchText(new URL(p.physics,import.meta.url)),fetchText(new URL(p.metadata,import.meta.url)).then(JSON.parse)]);
        sim=new Simulation(mj,p.asset,xml,meta);lastTick=performance.now();result=sim.snapshot();publish(result);status('Live physics ready');break;
      }
      case 'state':result=lastState||sim.snapshot();break;
      case 'snapshot':result=sim.snapshot();break;
      case 'startAudit':sim.audit={steps:0,unintended_contacts:0,peak_contact_N:0,examples:[]};result=sim.audit;break;
      case 'audit':result=sim.audit;break;
      case 'command':
        if(task&&lastState?.done){python('reset');task=false;}
        auto=false;paused=false;sim.command(p.action);result=task?python('result'):sim.snapshot();publish(result);break;
      case 'pause':paused=!paused;result=task?python('result'):sim.snapshot();publish(result);break;
      case 'reset':
        auto=false;paused=false;task=false;if(py)python('reset');result=sim.reset();publish(result);break;
      case 'task':
        paused=true;auto=false;await loadPython();
        result=python('start',{name:p.task,seed:p.seed??0});task=true;auto=p.run!==false;paused=p.paused===true;lastTick=performance.now();publish(result);break;
      case 'finish':
        if(!task)throw Error('Start the focus task before submitting focus');
        auto=false;paused=false;result=python('finish');publish(result);break;
      case 'specimen':
        await loadPython();result=python('specimen',{asset:sim.asset,channel:p.channel||'camera',auto});
        lastTick=performance.now();break;
      case 'step':
        // Deterministic stepping used by automated browser validation.
        paused=true;result=sim.step(p.action||{},p.seconds??.02);publish(result);break;
      case 'taskTick':
        paused=true;result=python('tick',{auto:p.auto!==false});publish(result);break;
      default:throw Error('Unknown worker operation: '+op);
    }
    postMessage({type:'reply',id,result:['snapshot','specimen','startAudit','audit'].includes(op)?result:publicState(result)});
  }).catch(e=>{postMessage({type:'reply',id,error:e.message});status('Operation stopped: '+e.message);});
};
