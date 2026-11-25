// Dynamic objective/obstacle contact, sampled at every 1 ms physics step.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const out=process.env.LAB_TEST_OUTPUT,url=process.env.LAB_TEST_URL;
const report={url,passed:false,cases:[],sources:{},harness_sha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
const save=()=>fs.writeFileSync(path.join(out,'focus-contact.json'),JSON.stringify(report,null,2)+'\n');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
 try{
  const page=await browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  const result=await page.evaluate(async()=>{
   const {default:load}=await import('./vendor/mujoco/mujoco.js'),{Simulation}=await import('./physics.js?v=clearance1');
   const mj=await load(),catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments;
   const sources={},cases=[],cache={};
   async function fetched(name){const r=await fetch(name);if(!r.ok)throw Error(name+' '+r.status);const bytes=await r.arrayBuffer();
    sources[new URL(name,location.href).pathname]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');return new TextDecoder().decode(bytes);}
   await fetched('./physics.js');
   async function create(asset){
    if(!cache[asset]){const item=catalog.find(x=>x.id===asset);cache[asset]=[await fetched(item.physics),JSON.parse(await fetched(item.metadata))];}
    return new Simulation(mj,asset,...cache[asset]);
   }
   const optical=c=>/Objective/.test(c.a+' '+c.b);
   function drive(sim,action,seconds){
    sim.command(action);let samples=0,penetration=0,force=0,totalForce=0,maxRate=0,maxActuatorForce=0,forceLimits=true,firstContact=null;const pairs=new Set();
    const focusJoint={transfer:'scope_focus_travel',probe:'optic_focus_travel',zeiss:'focus_travel'}[sim.asset];
    for(let k=0;k<Math.round(seconds/sim.opt.timestep);k++){
     const previous=sim.fixtureControlRates.map(x=>sim.d.ctrl[x.actuator]);sim.beforeStep();
     sim.fixtureControlRates.forEach((x,i)=>maxRate=Math.max(maxRate,Math.abs(sim.d.ctrl[x.actuator]-previous[i])/sim.opt.timestep));
     mj.mj_step(sim.m,sim.d);
     for(let i=0;i<sim.m.nu;i++){
      const value=sim.d.actuator_force[i];maxActuatorForce=Math.max(maxActuatorForce,Math.abs(value));
      if(sim.m.actuator_forcelimited[i]&&(value<sim.m.actuator_forcerange[2*i]-1e-6||value>sim.m.actuator_forcerange[2*i+1]+1e-6))forceLimits=false;
     }
     let total=0;
     for(const c of sim.contacts())if(optical(c)){
      if(firstContact===null)firstContact={phase_time_s:(k+1)*sim.opt.timestep,focus_m:sim.q(focusJoint),
       actuator_control_m:sim.d.ctrl[sim.drives[focusJoint]],focus_velocity_m_s:sim.d.qvel[sim.joints[focusJoint].dofadr[0]],
       pair:[c.a,c.b].sort(),penetration_m:c.penetration_m,normal_force_N:c.normal_N};
      samples++;penetration=Math.max(penetration,c.penetration_m);force=Math.max(force,c.normal_N);total+=c.normal_N;pairs.add([c.a,c.b].sort().join(' | '));
     }
     totalForce=Math.max(totalForce,total);
    }
    return {contact_samples:samples,maximum_penetration_m:penetration,peak_normal_force_N:force,peak_total_optical_normal_force_N:totalForce,
     maximum_slew_per_s:maxRate,maximum_actuator_force:maxActuatorForce,actuator_force_limits_respected:forceLimits,first_contact:firstContact,pairs:[...pairs].sort()};
   }
   function complete(sim,data,passed){data.passed=!!passed&&sim.warnings().every(x=>x===0)&&Array.from(sim.d.qpos).every(Number.isFinite);
    data.warnings=sim.warnings();cases.push(data);sim.dispose();}
   for(const kind of ['stamp','sample']){
    const sim=await create('transfer'),setup=[drive(sim,{},.5)];
    const rateDeclared=sim.fixtureControlRates.some(x=>x.name==='scope_focus_travel'&&x.rate===.005);
    if(kind==='sample'){setup.push(drive(sim,{sample_x_travel:-.0125,sample_y_travel:-.0125,sample_theta_angle:Math.PI/4,stamp_x_travel:.0125,stamp_y_travel:.0125},2));setup.push(drive(sim,{stamp_tilt_angle:-5*Math.PI/180,stamp_z_travel:-.010},3));}
    const approach=drive(sim,{scope_focus_travel:-.025},8),stopped=sim.q('scope_focus_travel');
    const terminal=sim.contacts(),release=drive(sim,{scope_focus_travel:.010},8),end=sim.q('scope_focus_travel');
    const obstacle=kind==='stamp'?'stamp_tilt__':'sample_theta__';
    const passed=rateDeclared&&approach.pairs.some(x=>x.includes(obstacle))&&stopped>-.024
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0002&&p.peak_normal_force_N<200&&p.peak_total_optical_normal_force_N<300&&p.actuator_force_limits_respected)
     &&terminal.some(optical)&&terminal.every(c=>c.penetration_m<.0001)
     &&approach.maximum_slew_per_s<=.005000001&&release.maximum_slew_per_s<=.005000001
     &&approach.maximum_slew_per_s>.004999999&&release.maximum_slew_per_s>.004999999
     &&end>.008&&!sim.contacts().some(optical);
    complete(sim,{asset:'transfer',case:kind,rate_declared:rateDeclared,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   for(const [station,magnification] of [20,50,5,10,100].entries()){
    const sim=await create('zeiss'),setup=[drive(sim,{focus_travel:-.005},8)];
    const angle=(((-station*2*Math.PI/5+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI))-Math.PI;
    setup.push(drive(sim,{turret_angle:angle},2));const assertIndexed=Math.abs(sim.q('turret_angle')-angle)<.025;
    const approach=drive(sim,{focus_travel:.007},30),stopped=sim.q('focus_travel'),expected=[20,50,100].includes(magnification);
    const release=drive(sim,{focus_travel:-.005},13),end=sim.q('focus_travel');
    const correctPair=approach.pairs.some(x=>x.includes('turret__Objective_front_glass_'+magnification+' |')||x.endsWith(' | turret__Objective_front_glass_'+magnification));
    const passed=assertIndexed&&(expected?(correctPair&&approach.contact_samples>100&&stopped<.005):(approach.contact_samples===0&&stopped>.0055))
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&end<-.0045&&!sim.contacts().some(optical);
    complete(sim,{asset:'zeiss',station,magnification,expected_contact:expected,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   for(const [x,y,theta] of [[0,0,0],[-.0125,.0125,-.35],[-.0125,.0125,0],[.0125,.0125,0],[.0125,.0125,.35]]){
    const sim=await create('probe'),setup=[drive(sim,{chuck_x_travel:x,chuck_y_travel:y,chuck_theta_angle:theta},3)];
    const rateDeclared=sim.fixtureControlRates.some(x=>x.name==='optic_focus_travel'&&x.rate===.005);
    const approach=drive(sim,{optic_focus_travel:-.020},8),stopped=sim.q('optic_focus_travel');
    const terminal=sim.contacts().filter(optical),release=drive(sim,{optic_focus_travel:0},8),end=sim.q('optic_focus_travel');
    const passed=rateDeclared&&terminal.length>0&&approach.contact_samples>50&&stopped>-.0197
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&approach.maximum_slew_per_s<=.005000001&&release.maximum_slew_per_s<=.005000001
     &&approach.maximum_slew_per_s>.004999999&&release.maximum_slew_per_s>.004999999
     &&Math.abs(end)<.0001&&!sim.contacts().some(optical);
    complete(sim,{asset:'probe',chuck_x_y_m:[x,y],theta_rad:theta,rate_declared:rateDeclared,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   return {cases,sources};
  });
  Object.assign(report,result);report.passed=report.cases.length===12&&report.cases.every(x=>x.passed);save();
  console.log(JSON.stringify(report,null,2));assert.equal(report.passed,true);
 }catch(error){report.error=error.stack;throw error;}finally{save();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
