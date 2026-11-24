// MuJoCo mechanics in SI units. Controllers match the native instrument runtime.
// Only reset/initialization writes qpos; controls use torque, actuators or a weld.
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const tau=2*Math.PI, wrap=x=>((x+Math.PI)%tau+tau)%tau-Math.PI;
const nikonNames={x:'stage_x',y:'stage_y',z:'stage_z',kx:'x_angle',ky:'y_angle',coarse:'coarse_angle',fine:'fine_angle',turret:'turret_angle'};
export class Simulation {
  constructor(mj,asset,xml,meta={}) {
    this.mj=mj;this.asset=asset;this.meta=meta;
    this.m=mj.MjModel.from_xml_string(xml);this.d=new mj.MjData(this.m);
    this.opt=this.m.opt; // borrowed; do not delete separately from the model
    // MULTICCD is on by default in MuJoCo 4; clear its disable bit explicitly.
    this.opt.disableflags&=~mj.mjtDisableBit.mjDSBL_MULTICCD.value;
    if(asset==='tweezers'){this.opt.impratio=10;this.opt.noslip_iterations=5;}
    this.force=new mj.DoubleBuffer(6);
    this.joints={};this.bodies={};this.sites={};this.geoms={};this.actuators={};this.equalities={};this.drives={};
    const m=this.m;
    for(const [kind,count,map] of [['jnt',m.njnt,this.joints],['body',m.nbody,this.bodies],['site',m.nsite,this.sites],['geom',m.ngeom,this.geoms],['actuator',m.nu,this.actuators],['eq',m.neq,this.equalities]]){
      for(let i=0;i<count;i++){
        const a=m[kind](i),name=a.name;map[name]={id:i,name};a.delete();
        if(kind==='jnt')Object.assign(map[name],{qposadr:[m.jnt_qposadr[i]],dofadr:[m.jnt_dofadr[i]],type:m.jnt_type[i]});
        if(kind==='geom')Object.assign(map[name],{pos:Array.from(m.geom_pos.slice(3*i,3*i+3)),size:Array.from(m.geom_size.slice(3*i,3*i+3))});
      }
    }
    const byId=Object.values(this.joints);
    for(let i=0;i<m.nu;i++)this.drives[byId[m.actuator_trnid[2*i]].name]=i;
    this.reset();
  }
  dispose(){this.force.delete();this.d.delete();this.m.delete();}
  q(name){return this.d.qpos[this.joints[name].qposadr[0]];}
  reset(){
    this.mj.mj_resetData(this.m,this.d);this.guardEvents=[];this.lockPrev={};this.audit=null;
    this.targets=Object.fromEntries(Object.keys(this.drives).map(k=>[k,0]));
    this.mocapTarget=[0,0,.012];this.quatTarget=[1,0,0,0];this.fixtureTargets={};this.turretTarget=null;
    this.prev=[0,0];this.zcmd=0;
    if(this.joints.light_path_travel){this.d.qpos[this.joints.light_path_travel.qposadr[0]]=.012;this.targets.light_path_travel=.012;this.d.ctrl[this.drives.light_path_travel]=.012;}
    for(const [name,value] of Object.entries(this.meta.initial_joint_positions||{})){
      this.d.qpos[this.joints[name].qposadr[0]]=value;
      if(name in this.drives){this.targets[name]=value;this.d.ctrl[this.drives[name]]=value;}
    }
    if(this.asset==='tweezers'){
      this.d.mocap_pos.set(this.mocapTarget);this.d.mocap_quat.set(this.quatTarget);
      this.d.qpos.set(this.quatTarget,this.joints.tool_free.qposadr[0]+3);
    }
    this.mj.mj_forward(this.m,this.d);return this.snapshot();
  }
  command(action){
    const accepted={};
    for(const [name,raw] of Object.entries(action)){
      if(name==='tool_position'||name==='tool_quaternion'){
        const length=name==='tool_position'?3:4;
        if(this.asset!=='tweezers'||!Array.isArray(raw)||raw.length!==length||!raw.every(Number.isFinite))throw Error('Invalid tool fixture command');
        if(name==='tool_position')this.mocapTarget=raw.map((x,i)=>clamp(x,i===2?.005:-.14,i===2?.08:.14));
        else {const norm=Math.hypot(...raw);if(!norm)throw Error('Tool quaternion must be nonzero');this.quatTarget=raw.map(x=>x/norm);}
        accepted[name]=name==='tool_position'?this.mocapTarget:this.quatTarget;continue;
      }
      let value=Number(raw);if(!Number.isFinite(value))throw Error('Commands must be finite');
      if(this.asset==='nikon'){
        if(['kx','ky','coarse','fine'].includes(name)){this.fixtureTargets[name]=value;accepted[name]=value;continue;}
        if(name==='turret'){
          if(!Number.isInteger(value)||value<0||value>6)throw Error('Choose objective socket 0–6');
          const angle=this.q('turret_angle');this.turretTarget=angle+wrap(value*tau/7-angle);accepted[name]=value;continue;
        }
        if(name!=='light_path_travel')throw Error('Unknown Nikon control: '+name);
      }
      if(!(name in this.drives))throw Error('Unknown fixture actuator: '+name);
      let reason;
      if(this.asset==='transfer'&&this.meta.rotation_mechanism){
        const locked=this.q('rotation_lock_angle')>=this.meta.rotation_mechanism.lock_threshold_rad;
        if(name==='sample_theta_angle'&&locked)reason='Release the rotation clamp before coarse rotation';
        if(name==='rotation_fine_knob_angle'&&!locked)reason='Lock the coarse rotation before fine adjustment';
      }
      if(this.asset==='afm'){
        if(name==='door_angle'&&value<-.04&&this.q('door_latch_angle')<.5&&this.q('door_angle')>-.04)reason='Release enclosure latch first';
        if(name==='drawer_travel'&&value>.004&&(this.q('scanner_latch_angle')<.65||this.q('door_angle')>-1.1))reason='Open door and release scanner latch first';
        if(name==='door_angle'&&value>-1.1&&this.q('drawer_travel')>.005)reason='Return scanner drawer before closing door';
        if(name==='scanner_latch_angle'&&value<.65&&this.q('drawer_travel')>.005)reason='Return scanner drawer before engaging latch';
      }
      if(reason){this.guardEvents.push({time:this.d.time,control:name,reason});this.guardEvents=this.guardEvents.slice(-5);continue;}
      const i=this.drives[name];if(this.m.actuator_ctrllimited[i])value=clamp(value,this.m.actuator_ctrlrange[2*i],this.m.actuator_ctrlrange[2*i+1]);
      this.targets[name]=value;accepted[name]=value;
    }
    return accepted;
  }
  lock(name,active){
    const i=this.equalities[name].id;
    // MuJoCo 4 stores 12 values per equality (native 3.x used 11).
    // Use the runtime constant so a clamp holds the measured position.
    if(active&&!this.lockPrev[name])this.m.eq_data[i*this.mj.mjNEQDATA]=this.d.qpos[this.m.jnt_qposadr[this.m.eq_obj1id[i]]];
    this.d.eq_active[i]=active?1:0;this.lockPrev[name]=active;
  }
  beforeStep(){
    const d=this.d,dt=this.opt.timestep;
    if(this.asset==='transfer'&&this.meta.rotation_mechanism){
      const locked=this.q('rotation_lock_angle')>=this.meta.rotation_mechanism.lock_threshold_rad;
      this.lock('rotation_coarse_lock',locked);this.lock('rotation_fine_lock',!locked);
    }
    if(this.asset==='afm'){
      const door=this.q('door_angle'),out=this.q('drawer_travel')>.005;
      this.lock('door_lock',(this.q('door_latch_angle')<.5&&door>-.04)||(out&&door>-1.15));
      this.lock('drawer_lock',this.q('scanner_latch_angle')<.65||door>-1.1);
    }
    if(this.asset==='nikon'){
      for(const [key,target] of Object.entries(this.fixtureTargets)){
        const j=this.joints[nikonNames[key]],v=j.dofadr[0],e=target-d.qpos[j.qposadr[0]],vel=d.qvel[v];
        d.qfrc_applied[v]=clamp(.0055*(clamp(e*13,-14,14)-vel),-.062,.062);
        if(Math.abs(e)<.0015&&Math.abs(vel)<.035){d.qfrc_applied[v]=0;delete this.fixtureTargets[key];}
      }
      const c=this.q('coarse_angle'),f=this.q('fine_angle');
      this.zcmd=clamp(this.zcmd+((c-this.prev[0])*.005+(f-this.prev[1])*.0001)/tau,-.010,.004);this.prev=[c,f];
      d.ctrl[this.actuators.focus_drive.id]=this.zcmd;
      const t=this.q('turret_angle'),w=d.qvel[this.joints.turret_angle.dofadr[0]];
      let torque=-.037*Math.sin(7*t)-.004*w;
      if(this.turretTarget!==null){const e=this.turretTarget-t;torque=clamp(.42*e-.023*w,-.1,.1);if(Math.abs(e)<.0015&&Math.abs(w)<.04)this.turretTarget=null;}
      d.ctrl[this.actuators.turret_index_motor.id]=torque;
      d.ctrl[this.drives.light_path_travel]=this.targets.light_path_travel;
    } else for(const [name,i] of Object.entries(this.drives)){
      if(this.asset==='afm'||this.asset==='tweezers'){
        const rate=this.asset==='tweezers'?.04:name==='drawer_travel'?.05:name==='door_angle'?.8:2;
        d.ctrl[i]+=clamp(this.targets[name]-d.ctrl[i],-rate*dt,rate*dt);
      }else d.ctrl[i]=this.targets[name];
    }
    if(this.asset==='tweezers'){
      const pos=d.mocap_pos,delta=this.mocapTarget.map((x,i)=>x-pos[i]),fraction=Math.min(1,.025*dt/Math.max(Math.hypot(...delta),1e-12));
      for(let i=0;i<3;i++)pos[i]+=delta[i]*fraction;
      const current=d.mocap_quat;let target=this.quatTarget,dot=target.reduce((s,x,i)=>s+x*current[i],0);
      if(dot<0){target=target.map(x=>-x);dot=-dot;}
      const half=Math.acos(clamp(dot,-1,1)),u=Math.min(1,.8*dt/Math.max(2*half,1e-12));
      const q=target.map((x,i)=>half<1e-6?(1-u)*current[i]+u*x:(Math.sin((1-u)*half)*current[i]+Math.sin(u*half)*x)/Math.sin(half));
      const norm=Math.hypot(...q);current.set(q.map(x=>x/norm));
    }
  }
  step(action={},seconds=.02){
    this.command(action);
    for(let i=0,n=Math.max(1,Math.round(seconds/this.opt.timestep));i<n;i++){
      this.beforeStep();this.mj.mj_step(this.m,this.d);
      if(this.audit){
        this.audit.steps++;
        for(const c of this.contacts()){
          const names=c.a+c.b;
          this.audit.peak_contact_N=Math.max(this.audit.peak_contact_N,c.normal_N);
          if(['jaw_left__','jaw_right__','tool__'].some(x=>names.includes(x))&&names.includes('base__')){
            this.audit.unintended_contacts++;
            if(this.audit.examples.length<5)this.audit.examples.push({time:this.d.time,...c});
          }
        }
      }
    }
    return this.snapshot();
  }
  objective(){
    if(this.asset!=='nikon')return null;
    const angle=this.q('turret_angle'),nearest=Math.round(angle/(tau/7)),err=angle-nearest*tau/7,indexed=Math.abs(err)<Math.PI/240,slot=((nearest%7)+7)%7;
    return {station:indexed?slot+1:null,magnification:indexed?[20,40,null,null,null,4,10][slot]:null,indexed,index_error_deg:err*180/Math.PI};
  }
  contacts(){
    const out=[],contacts=this.d.contact,names=Object.keys(this.geoms);
    try {for(let i=0;i<contacts.size();i++){
      const c=contacts.get(i);
      try {this.mj.mj_contactForce(this.m,this.d,i,this.force);out.push({a:names[c.geom1],b:names[c.geom2],normal_N:this.force.GetView()[0],penetration_m:Math.max(0,-c.dist)});}finally{c.delete();}
    }}finally{contacts.delete();}
    return out;
  }
  warnings(){
    const out=[],warnings=this.d.warning; // borrowed vector owned by MjData
    for(let i=0;i<warnings.size();i++){const w=warnings.get(i);out.push(w.number);w.delete();}return out;
  }
  snapshot(){
    const d=this.d;
    return {asset:this.asset,time:d.time,q:Object.fromEntries(Object.values(this.joints).filter(j=>j.type!==0).map(j=>[j.name,d.qpos[j.qposadr[0]]])),
      sites:Object.fromEntries(Object.values(this.sites).map(s=>[s.name,Array.from(d.site_xpos.slice(s.id*3,s.id*3+3))])),
      poses:Object.fromEntries(Object.values(this.bodies).filter(b=>b.id).map(b=>[b.name,{p:Array.from(d.xpos.slice(b.id*3,b.id*3+3)),q:Array.from(d.xquat.slice(b.id*4,b.id*4+4))}])),
      objective:this.objective(),contacts:this.contacts(),warnings:this.warnings(),guard_events:this.guardEvents,
      targets:{...this.targets},mocap_target:[...this.mocapTarget],mocap_quat_target:[...this.quatTarget],
      arrays:{qpos:Array.from(d.qpos),qvel:Array.from(d.qvel),xpos:Array.from(d.xpos),xmat:Array.from(d.xmat),site_xmat:Array.from(d.site_xmat)}};
  }
  metadata(){return {asset:this.asset,meta:this.meta,joints:this.joints,bodies:this.bodies,sites:this.sites,geoms:this.geoms,drives:this.drives};}
  applyReset(patch){
    // Used only by task.reset to set seeded initial conditions, never by a policy.
    this.d.qpos.set(patch.qpos);this.targets={...patch.targets};
    if(this.asset==='nikon'){this.prev=[this.q('coarse_angle'),this.q('fine_angle')];this.zcmd=this.q('stage_z');}
    this.mj.mj_forward(this.m,this.d);return this.snapshot();
  }
}
