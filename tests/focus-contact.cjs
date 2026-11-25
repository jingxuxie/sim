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
   const {default:load}=await import('./vendor/mujoco/mujoco.js'),{Simulation}=await import('./physics.js?v=alignment6');
   const mj=await load(),catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments;
   const sources={},cases=[],cache={};
   async function fetched(name){const r=await fetch(name);if(!r.ok)throw Error(name+' '+r.status);const bytes=await r.arrayBuffer();
    sources[new URL(name,location.href).pathname]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');return new TextDecoder().decode(bytes);}
   await fetched('./physics.js');
   async function create(asset,probeMode=null){
    if(!cache[asset]){const item=catalog.find(x=>x.id===asset);cache[asset]=[await fetched(item.physics),JSON.parse(await fetched(item.metadata))];}
    let [xml,meta]=cache[asset];
    if(probeMode){
     const probe=`<geom name="alignment6_optical_probe" type="cylinder" pos="${probeMode==='probe_offset'?'.100':'0'} -.110 .172" size=".006 .004" contype="1" conaffinity="2" solref=".004 1" solimp=".98 .995 .0002" friction=".5 .01 .001"/>`;
     xml=xml.replace('</worldbody>',probe+'</worldbody>');
    }
    const sim=new Simulation(mj,asset,xml,meta);
    if(probeMode==='contacts_disabled')for(const [name,geom] of Object.entries(sim.geoms))if(name.startsWith('scope_focus__Stereo_')){
     sim.m.geom_contype[geom.id]=0;sim.m.geom_conaffinity[geom.id]=0;
    }
    return sim;
   }
   const optical=c=>/[Oo]bjective|Stereo_front_glass/.test(c.a+' '+c.b);
   function drive(sim,action,seconds){
    sim.command(action);let samples=0,penetration=0,force=0,totalForce=0,maxRate=0,maxActuatorForce=0,forceLimits=true,firstContact=null;const pairs=new Set();
    const focusJoint={nikon:'stage_z',transfer:'scope_focus_travel',probe:'optic_focus_travel',zeiss:'focus_travel',bonder:'scope_focus_travel'}[sim.asset];
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
    const approach=drive(sim,{focus_travel:.007},30),stopped=sim.q('focus_travel'),expected=[20,50,10,100].includes(magnification);
    const release=drive(sim,{focus_travel:-.005},13),end=sim.q('focus_travel');
    // With10× active, the neighboring100× shoulder reaches the retaining
    // lever first. Native stopped-pose and+7mm detailed-mesh checks establish
    // this physical limit;5× alone clears the tested full approach.
    const front=magnification===10?'turret__Objective_front_shoulder_100':'turret__Objective_front_glass_'+magnification;
    const correctPair=approach.pairs.some(x=>(x.includes(front+' |')||x.endsWith(' | '+front))
     &&(magnification!==10||x.includes('stage_x__Specimen_thumb_lever_contact')));
    const passed=assertIndexed&&(expected?(correctPair&&approach.contact_samples>100&&stopped<(magnification===10?.0065:.005)):(approach.contact_samples===0&&stopped>.0055))
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&end<-.0045&&!sim.contacts().some(optical);
    complete(sim,{asset:'zeiss',station,magnification,expected_contact:expected,expected_objective_contact_geom:front,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
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
   for(const [station,magnification] of [[0,20],[1,40]])for(const x of [0,.039]){
    const sim=await create('nikon'),setup=[drive(sim,{coarse:-2*Math.PI},2.5),drive(sim,{turret:station},2),
     drive(sim,{kx:x/.020*2*Math.PI,ky:0},3)];
    const approach=drive(sim,{coarse:.8*2*Math.PI},30),stopped=sim.q('stage_z'),terminal=sim.contacts().filter(optical);
    const release=drive(sim,{coarse:-2*Math.PI},3),end=sim.q('stage_z');
    const obstacle=x===0?'substrate':'clip_-1',front='objective_'+station+'_front_glass';
    const passed=approach.contact_samples>100&&approach.pairs.some(x=>x.includes(front)&&x.includes(obstacle))
     &&approach.pairs.every(x=>x.includes('substrate')||x.includes('clip_'))&&terminal.length>0&&stopped<.0035
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&end<-.0045&&!sim.contacts().some(optical);
    complete(sim,{asset:'nikon',case:obstacle,station,magnification,stage_x_m:x,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   for(const [station,magnification] of [[0,20],[1,50]]){
    const sim=await create('zeiss'),setup=[drive(sim,{focus_travel:-.005},8),
     drive(sim,{turret_angle:-station*2*Math.PI/5},2),drive(sim,{stage_x_travel:.035,stage_y_travel:-.025},3)];
    const approach=drive(sim,{focus_travel:.007},30),stopped=sim.q('focus_travel'),terminal=sim.contacts().filter(optical);
    const release=drive(sim,{focus_travel:-.005},13),end=sim.q('focus_travel');
    const passed=approach.contact_samples>100&&approach.pairs.some(x=>x.includes('stage_x__Specimen_clamp_screw_contact')&&x.includes('turret__Objective_front_aperture_'+magnification))
     &&approach.pairs.every(x=>x.includes('stage_x__'))&&terminal.length>0&&stopped<.002
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&end<-.0045&&!sim.contacts().some(optical);
    complete(sim,{asset:'zeiss',case:'offset specimen holder',station,magnification,stage_x_y_m:[.035,-.025],setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   for(const [station,magnification,x,y,prefix,expectedStop] of [
    [0,20,0,-.025,'stage_x__Fixed_specimen_holder_piece_',.00389259],
    [4,100,-.035,.025,'stage_x__Curved_retaining_arm_piece_',.00048816]]){
    const sim=await create('zeiss'),angle=station===4?2*Math.PI/5:0;
    const setup=[drive(sim,{focus_travel:-.005},8),drive(sim,{turret_angle:angle},2),drive(sim,{stage_x_travel:x,stage_y_travel:y},3)];
    const approach=drive(sim,{focus_travel:.007},30),stopped=sim.q('focus_travel'),terminal=sim.contacts().filter(optical);
    const release=drive(sim,{focus_travel:-.005},13),end=sim.q('focus_travel');
    const passed=approach.contact_samples>100&&approach.pairs.some(x=>x.includes(prefix)&&x.includes('turret__Objective_front_glass_'+magnification))
     &&approach.pairs.every(x=>x.includes(prefix))&&terminal.length>0&&Math.abs(stopped-expectedStop)<.0002
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected)
     &&end<-.0045&&!sim.contacts().some(optical);
    complete(sim,{asset:'zeiss',case:'inline holder hull',station,magnification,stage_x_y_m:[x,y],contact_prefix:prefix,
     native_stop_reference_m:expectedStop,setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   // The bonder's real workholder is below the complete focus envelope. An
   // explicit temporary cylinder tests physical blocking, paired with moved
   // obstacle and disabled-contact controls. It is never delivered as hardware.
   for(const mode of ['existing_hardware','probe','probe_offset','contacts_disabled']){
    const sim=await create('bonder',mode==='existing_hardware'?null:mode),setup=[drive(sim,{},.5)];
    const rateDeclared=sim.fixtureControlRates.some(x=>x.name==='scope_focus_travel'&&x.rate===.005);
    const approach=drive(sim,{scope_focus_travel:-.015},6),stopped=sim.q('scope_focus_travel'),terminal=sim.contacts().filter(optical);
    const release=drive(sim,{scope_focus_travel:.020},9),end=sim.q('scope_focus_travel');
    const expected=mode==='probe';
    const passed=rateDeclared&&(expected?(approach.contact_samples>100&&Math.abs(stopped+.0075)<.0001&&terminal.length>0
      &&approach.pairs.some(x=>x.includes('alignment6_optical_probe')&&x.includes('scope_focus__Stereo_front_glass_contact')))
      :(approach.contact_samples===0&&Math.abs(stopped+.015)<.0001))
     &&[...setup,approach,release].every(p=>p.maximum_penetration_m<.0001&&p.peak_normal_force_N<200&&p.actuator_force_limits_respected&&p.maximum_actuator_force<=40.00001)
     &&approach.maximum_slew_per_s<=.005000001&&release.maximum_slew_per_s<=.005000001
     &&approach.maximum_slew_per_s>.004999999&&release.maximum_slew_per_s>.004999999
     &&end>.0195&&!sim.contacts().some(optical);
    complete(sim,{asset:'bonder',case:mode,expected_contact:expected,rate_declared:rateDeclared,
     temporary_probe:mode==='existing_hardware'?null:{position_m:[mode==='probe_offset'?.1:0,-.110,.172],radius_m:.006,half_height_m:.004,delivered_hardware:false},
     setup,approach,release,stopped_focus_m:stopped,retracted_focus_m:end},passed);
   }
   return {cases,sources};
  });
  Object.assign(report,result);report.passed=report.cases.length===24&&report.cases.every(x=>x.passed);save();
  console.log(JSON.stringify(report,null,2));assert.equal(report.passed,true);
 }catch(error){report.error=error.stack;throw error;}finally{save();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
