"""Instrument-level tasks and deterministic bench-controller baselines.
Success is evaluated from measured MuJoCo state/contact, never from commands.
These are fixture baselines, not robot or learned-policy demonstrations.
"""
import math
import numpy as np
from sim import Simulation
TASKS={
 'nikon.center':dict(asset='nikon',title='Center a specimen',seconds=8,tolerance_m=.00015),
 'nikon.focus':dict(asset='nikon',title='Focus a specimen',seconds=8,tolerance_m=.000005),
 'nikon.objective':dict(asset='nikon',title='Index an objective',seconds=8,tolerance_rad=.013),
 'nikon.image_focus':dict(asset='nikon',title='Autofocus from specimen images',seconds=60,tolerance_m=.000003,baseline='image sharpness search',requires_finish=True),
 'nikon.image_center':dict(asset='nikon',title='Center an image fiducial',seconds=12,tolerance_m=.000010,baseline='image fiducial feedback'),
 'transfer.align':dict(asset='transfer',title='Align stamp over target',seconds=12,tolerance_m=.00015),
 'transfer.touch':dict(asset='transfer',title='Touch stamp and retract',seconds=20,tolerance_m=.00015),
 'probe.align':dict(asset='probe',title='Align two probe tips',seconds=10,tolerance_m=.00008),
 'probe.touch':dict(asset='probe',title='Establish two contacts and retract',seconds=12,tolerance_m=.00008),
 'zeiss.center':dict(asset='zeiss',title='Center a specimen',seconds=10,tolerance_m=.00015),
 'zeiss.focus':dict(asset='zeiss',title='Focus a specimen',seconds=10,tolerance_m=.00001),
 'zeiss.image_focus':dict(asset='zeiss',title='Autofocus from specimen images',seconds=45,tolerance_m=.000003,baseline='image sharpness search',requires_finish=True),
 'bonder.align':dict(asset='bonder',title='Align wedge over bond pad',seconds=8,tolerance_m=.00015),
 'bonder.two_bonds':dict(asset='bonder',title='Two-pad bonding sequence',seconds=14,tolerance_m=.00020),
 'afm.access':dict(asset='afm',title='Release and open scanner',seconds=14),
 'afm.cycle':dict(asset='afm',title='Open, inspect, close and latch',seconds=20),
 'tweezers.pick':dict(asset='tweezers',title='Grip and lift a chip',seconds=12,tolerance_m=.001),
 'tweezers.place':dict(asset='tweezers',title='Transfer chip to tray',seconds=20,tolerance_m=.001),
}
class InstrumentTask:
    def __init__(self,name,seed=0,fixtures=True,camera_options=None,record_images=False):
        if name not in TASKS:raise KeyError(name)
        self.name=name;self.spec=TASKS[name];self._camera_options=dict(camera_options or {});self._record_images=record_images
        self.sim=Simulation(self.spec['asset'],fixtures);self.reset(seed)
    def reset(self,seed=0):
        self.sim.reset(seed);self.seed=seed;self.steps=0;self.visited=set();self.hold=0;self.success=False;self.failure=None;self.events=[];self.phase=0
        self._camera=None;self._image_controller=None;self.camera_frames=[]
        self.finish_requested=False
        rng=np.random.default_rng(seed);self.goal=rng.uniform([- .006,-.004],[.006,.004]);self.focus_goal=float(rng.uniform(-.0006,.0006));self.objective=int(rng.choice([1,5,6]));self.max_force=0
        if self.name=='nikon.image_center':self.goal=rng.uniform(-.00012,.00012,2)
        seeded_pose={}
        if self.name.startswith('transfer'):
            for key,val in zip(['sample_x_travel','sample_y_travel'],rng.uniform(-.002,.002,2)):
                seeded_pose[key]=float(val)
        if self.name.startswith('probe'):
            self.goal=rng.uniform(-.001,.001,2)
            for k,v in zip(['chuck_x_travel','chuck_y_travel'],self.goal):
                seeded_pose[k]=float(v)
        # Seed the complete screw assembly, including translating spindles.
        # These are reset-time initial conditions; policies never assign qpos.
        graph={}
        for coupling in self.sim.meta.get('couplings',[]):
            i,o,r=coupling['input'],coupling['output'],coupling['ratio']
            if r:
                graph.setdefault(i,[]).append((o,r));graph.setdefault(o,[]).append((i,1/r))
        pending=list(seeded_pose)
        while pending:
            name=pending.pop()
            for other,ratio in graph.get(name,[]):
                value=seeded_pose[name]*ratio
                if other not in seeded_pose:seeded_pose[other]=value;pending.append(other)
                elif not math.isclose(seeded_pose[other],value,rel_tol=1e-10,abs_tol=1e-12):raise ValueError('Inconsistent coupled reset pose')
        for name,value in seeded_pose.items():
            self.sim.d.qpos[self.sim.m.joint(name).qposadr[0]]=value
            if name in self.sim.drives:
                self.sim.targets[name]=value;self.sim.d.ctrl[self.sim.drives[name]]=value
        import mujoco as mj
        mj.mj_forward(self.sim.m,self.sim.d)
        self.initial_chip_z=self.sim.site('device_chip_center')[2] if self.sim.asset=='tweezers' else 0
        if self.sim.asset=='tweezers':
            self._tweezer_release=None;self._tweezer_had_bilateral=False
        self.result={};return self.observe()
    def event(self,name):
        if name not in self.visited:self.visited.add(name);self.events.append(dict(event=name,time=round(float(self.sim.d.time),4)))
    def metrics(self):
        s=self.sim;n=self.name;contacts=s.contact_info();force=max([c['normal_N'] for c in contacts]+[0]);self.max_force=max(self.max_force,force)
        result=dict(success=False,failure=None,peak_contact_N=self.max_force)
        if not np.all(np.isfinite(s.d.qpos)) or np.any(s.d.warning.number):result['failure']='simulation_warning';return result
        if n in ('nikon.center','zeiss.center','nikon.image_center'):
            v=np.array([s.q(k) for k in (('stage_x','stage_y') if s.asset=='nikon' else ('stage_x_travel','stage_y_travel'))]);err=np.linalg.norm(v-self.goal)
            result.update(error_m=float(err),success=err<self.spec['tolerance_m'])
        elif n in ('nikon.focus','zeiss.focus','nikon.image_focus','zeiss.image_focus'):
            z=s.q('stage_z' if s.asset=='nikon' else 'focus_travel');err=abs(z-self.focus_goal)
            result.update(defocus_m=err,success=err<self.spec['tolerance_m'])
            if n.endswith('image_focus'):
                from imaging import optical_path_state
                path=optical_path_state(s);valid=path['indexed'] and path['camera_throughput']>0
                result['objective_indexed']=bool(path['objective_indexed']);result['camera_throughput']=float(path['camera_throughput']);result['focus_submitted']=self.finish_requested
                result['success']=bool(result['success'] and valid and self.finish_requested)
        elif n=='nikon.objective':result.update(success=s.controller.objective()['station']==self.objective+1 and s.controller.objective()['indexed'])
        elif n.startswith('transfer'):
            d=s.site('stamp_contact')-s.site('transfer_target');err=float(np.linalg.norm(d[:2]));touch=any('Stamp_silicone' in c['a']+c['b'] and 'device_chip' in c['a']+c['b'] and c['normal_N']>.005 for c in contacts)
            if touch and err<.0003:self.event('stamp_contact')
            result.update(error_m=err,gap_m=float(d[2]),success=err<.00015 if n.endswith('align') else 'stamp_contact' in self.visited and d[2]>.002)
            if force>12:result['failure']='excessive_stamp_force'
        elif n.startswith('probe'):
            errors=[];gaps=[]
            for side in ('left','right'):
                d=s.site(side+'_tip')-s.site(side+'_pad');errors.append(float(np.linalg.norm(d[:2])));gaps.append(float(d[2]))
                if any(side+'_z__Probe_tip' in c['a']+c['b'] and 'device_chip' in c['a']+c['b'] and c['normal_N']>.001 for c in contacts):self.event(side+'_contact')
            result.update(error_m=max(errors),gap_m=min(gaps),success=max(errors)<.00008 if n.endswith('align') else all(side+'_contact' in self.visited for side in ('left','right')) and min(gaps)>.0008)
            if force>3:result['failure']='excessive_probe_force'
        elif n.startswith('bonder'):
            pos=s.site('bond_tip');p1=s.site('bond_pad_1');p2=s.site('bond_pad_2')
            for k,p in enumerate([p1,p2],1):
                touch=any('Bond_wedge_contact' in c['a']+c['b'] and 'device_chip' in c['a']+c['b'] and .002<c['normal_N']<3 for c in contacts)
                if np.linalg.norm((pos-p)[:2])<.0002 and touch:self.event('bond_'+str(k)+'_contact')
            active_pad=1 if n.endswith('align') or 'bond_1_contact' not in self.visited else 2
            current=p1 if active_pad==1 else p2
            result.update(error_m=float(np.linalg.norm((pos-current)[:2])),active_pad=active_pad,first_pad_distance_m=float(np.linalg.norm((pos-p1)[:2])),gap_m=float(pos[2]-current[2]),success=np.linalg.norm((pos-p1)[:2])<.00015 if n.endswith('align') else all('bond_'+str(k)+'_contact' in self.visited for k in (1,2)) and pos[2]-p1[2]>.001)
            if force>5:result['failure']='excessive_bond_force'
        elif n.startswith('afm'):
            opened=s.q('drawer_travel')>.09 and s.q('door_angle')<-1.3
            if opened:self.event('scanner_accessible')
            shut=s.q('drawer_travel')<.002 and abs(s.q('door_angle'))<.025 and s.q('scanner_latch_angle')<.15 and s.q('door_latch_angle')<.15
            result.update(success=opened if n.endswith('access') else 'scanner_accessible' in self.visited and shut,drawer_m=s.q('drawer_travel'),door_rad=s.q('door_angle'))
        elif n.startswith('tweezers'):
            obstacles=[c for c in contacts if any(k in c['a']+c['b'] for k in ('jaw_left__','jaw_right__','tool__')) and 'base__' in c['a']+c['b']]
            if any(c['normal_N']>.002 and c['penetration_m']>2e-5 for c in obstacles):
                result['failure']='tool_collided_with_work_surface'
            result['unintended_tool_contact_count']=len(obstacles)
            chip=s.site('device_chip_center');target=s.site('placement_target');err=float(np.linalg.norm(chip[:2]-target[:2]));both=all(any(side+'__Flat_precision_tip' in c['a']+c['b'] and 'chip__device_chip' in c['a']+c['b'] for c in contacts) for side in ('jaw_left','jaw_right'))
            if both:self.event('bilateral_grasp')
            if chip[2]>.012 and both:self.event('chip_lifted')
            body=s.m.body('chip').id;center=s.d.xpos[body];rotation=s.d.xmat[body].reshape(3,3)
            tilt=math.acos(float(np.clip(rotation[2,2],-1,1)))
            bottom=float(center[2]-np.dot(np.abs(rotation[2]),s.m.geom('chip__device_chip').size))
            insert=s.m.geom('base__Target_insert');floor=float(insert.pos[2]+insert.size[2])
            if 'chip_lifted' in self.visited and self._tweezer_had_bilateral and not both and self._tweezer_release is None:
                self._tweezer_release=dict(time_s=float(s.d.time),center_z_m=float(center[2]),
                    bottom_gap_m=bottom-floor,tilt_deg=math.degrees(tilt))
                self.event('chip_released')
            self._tweezer_had_bilateral=both
            drop=max(0.,self._tweezer_release['center_z_m']-float(center[2])) if self._tweezer_release else 0.
            velocity=s.d.qvel[s.m.joint('chip_free').dofadr[0]:][:6]
            supported=any('chip__device_chip' in c['a']+c['b'] and 'base__Target_insert' in c['a']+c['b'] and c['normal_N']>1e-5 for c in contacts)
            settled='chip_lifted' in self.visited and err<.001 and abs(chip[2]-target[2])<.0006 and not both and supported and tilt<math.radians(3) and np.linalg.norm(velocity[:3])<.003 and np.linalg.norm(velocity[3:])<.3
            retracted=min(s.site(side+'_tip')[2] for side in ('jaw_left','jaw_right'))-chip[2]>.006
            if settled:self.event('chip_settled_on_tray')
            if settled and retracted:self.event('tool_retracted')
            place=settled and retracted and self._tweezer_release is not None and drop<=.0008
            result.update(success=('chip_lifted' in self.visited and chip[2]>.012 and both) if n.endswith('pick') else place,error_m=err,chip_z_m=float(chip[2]),bilateral_contact=both,
                settling_drop_m=drop,release=self._tweezer_release,chip_tilt_deg=math.degrees(tilt),tray_support_contact=supported,tool_retracted=bool(retracted))
            if n.endswith('place') and drop>.0008:result['failure']='excessive_chip_drop'
            if chip[2]<-.003:result['failure']='dropped_outside_work_surface'
        result['success']=bool(result['success'])
        return result
    def request_finish(self,value=True):
        if not self.spec.get('requires_finish'):raise ValueError('This task has no focus submission action')
        if not isinstance(value,(bool,np.bool_)):raise ValueError('finish must be a boolean')
        self.finish_requested=bool(value)
    def step(self,action=None):
        action=dict(action or {})
        if 'finish' in action:self.request_finish(action.pop('finish'))
        self.sim.step(action);self.steps+=1;result=self.metrics();self.hold=self.hold+1 if result['success'] and not result['failure'] else 0
        self.success=self.hold>=15;self.failure=result['failure'];self.result=result
        truncated=self.sim.d.time>=self.spec['seconds'];terminated=self.success or bool(self.failure)
        return self.observe(),(1.0 if self.success else -result.get('error_m',result.get('defocus_m',0))),terminated,truncated,result
    def observe(self):return {**self.sim.observe(), 'task':self.name,'goal_xy_m':self.goal.tolist(),'focus_goal_m':self.focus_goal,'objective_index':self.objective,'events':self.events,'metrics':self.result}
    def camera_observation(self):
        """Image policy input; excludes focal-plane and target-position ground truth.

        The existing observe() API is the privileged state interface used for
        grading/debugging. Camera pixels are requested explicitly, not at every
        physics step. Configure a supplied micrograph through camera_options.
        """
        from imaging import MicroscopeCamera
        if self._camera is None:self._camera=MicroscopeCamera(self.sim.asset,**{'seed':self.seed,**self._camera_options})
        result=self._camera.capture(self.sim,focal_plane_m=self.focus_goal if 'focus' in self.name else 0.,target_stage_xy=self.goal if 'center' in self.name else (0.,0.))
        oracle=result.pop('defocus_m',None);ground_truth=result.pop('ground_truth',None);result['time_s']=float(self.sim.d.time)
        if self._record_images:self.camera_frames.append(dict(observation=result.copy(),evaluation=dict(defocus_m=oracle,error_m=self.metrics().get('error_m'),ground_truth=ground_truth)))
        return result
    def baseline_action(self):
        s=self.sim;n=self.name;t=s.d.time
        if '.image_' in n:
            from imaging import AutofocusController,ImageCenterController
            if self._image_controller is None:
                if n.endswith('image_focus'):
                    key='stage_z' if s.asset=='nikon' else 'focus_travel'
                    self._image_controller=AutofocusController(self.camera_observation,lambda:s.q(key),s.asset)
                else:self._image_controller=ImageCenterController(self.camera_observation,lambda:[s.q('stage_x'),s.q('stage_y')])
            action=self._image_controller.action()
            if n.endswith('image_focus'):
                for i in range(1,self._image_controller.round+1):self.event('image_focus_scan_'+str(i)+'_complete')
                action['finish']=self._image_controller.done
            return action
        if n=='nikon.center':return dict(kx=float(self.goal[0]/.020*math.tau),ky=float(self.goal[1]/.016*math.tau))
        if n=='nikon.focus':return dict(coarse=float(self.focus_goal/.005*math.tau))
        if n=='nikon.objective':return dict(turret=self.objective)
        if n=='zeiss.center':return dict(stage_x_travel=float(self.goal[0]),stage_y_travel=float(self.goal[1]))
        if n=='zeiss.focus':return dict(focus_travel=self.focus_goal)
        if n.startswith('transfer'):
            d=s.site('stamp_contact')-s.site('transfer_target')
            act={k:s.q(k)-float(err)*.7 for k,err in zip(['stamp_x_travel','stamp_y_travel'],d[:2])}
            if n.endswith('touch'):
                # The contact site is the stamp's lower surface; seek 5 um of
                # soft contact, then retract on the measured contact event.
                gap=-.000005 if t>3 and 'stamp_contact' not in self.visited else .004
                act['stamp_z_travel']=s.q('stamp_z_travel')+float(np.clip(gap-d[2],-.0002,.0002))
            return act
        if n.startswith('probe'):
            act={}
            for side in ('left','right'):
                d=s.site(side+'_tip')-s.site(side+'_pad')
                for k,err in zip(['x','y'],d[:2]):act[side+'_'+k+'_travel']=s.q(side+'_'+k+'_travel')-float(err)*.7
                if n.endswith('touch'):
                    # The 120 um tip sphere first touches at a 96 um site gap.
                    # A 90 um target seeks light contact, then both tips retract.
                    gap=.00009 if not all(x+'_contact' in self.visited for x in ('left','right')) else .0012
                    key=side+'_z_travel';act[key]=s.q(key)+float(np.clip(gap-d[2],-.00002,.00002))
                else:
                    # Initial observation-alignment challenge is in goal targets on the sample.
                    for k,offset in zip(['x','y'],self.goal):act['chuck_'+k+'_travel']=float(offset)
            return act
        if n.startswith('bonder'):
            tip=s.site('bond_tip');first='bond_1_contact' not in self.visited;second='bond_2_contact' not in self.visited
            pad=s.site('bond_pad_1' if first else 'bond_pad_2');d=tip-pad
            gap=.0024
            if n.endswith('two_bonds'):
                if abs(d[0])<.00015 and (first or second):gap=-.000004
            if not first and second and 'between_bonds_retracted' not in self.visited:
                if d[2]>.0015:self.event('between_bonds_retracted')
                else:d[0]=0;d[1]=0;gap=.0024
            act={}
            for i,axis in enumerate('xyz'):
                error=d[i]-(gap if i==2 else 0);act['handle_'+axis+'_travel']=s.q('handle_'+axis+'_travel')-float(np.clip(error*8,-.00032,.00032))
            return act
        if n.startswith('afm'):
            seq=[({'door_latch_angle':1.1},1.3),({'door_angle':-1.8},3.0),({'scanner_latch_angle':1.2},1.2),({'drawer_travel':.10},3.)]
            if n.endswith('cycle'):seq += [({'drawer_travel':0},3.),({'scanner_latch_angle':0},1.1),({'door_angle':0},3.),({'door_latch_angle':0},1.)]
            elapsed=0
            for act,duration in seq:
                elapsed+=duration
                if t<elapsed:return act
            return {}
        if n.startswith('tweezers'):
            chip=s.site('device_chip_center');offset=np.array([chip[0]-.059,chip[1],0]);closed=-.042
            if t<1.5:return dict(tool_position=(offset+[0,0,.00925]).tolist(),jaw_left_angle=0,jaw_right_angle=0)
            if t<3.2:return dict(jaw_left_angle=closed,jaw_right_angle=closed)
            if t<5.0:return dict(tool_position=[0,0,.022],jaw_left_angle=closed,jaw_right_angle=closed)
            if n.endswith('pick'):return {}
            # Approach through the tray's open Y end. A slight downward pitch
            # keeps the broad blade above the receiving surface while its tips
            # deliver the chip close to it. The chip moves only through contact.
            pitch=math.radians(8);half_yaw=math.pi/4
            quaternion=[math.cos(half_yaw)*math.cos(pitch/2),-math.sin(half_yaw)*math.sin(pitch/2),math.cos(half_yaw)*math.sin(pitch/2),math.sin(half_yaw)*math.cos(pitch/2)]
            if t<8.5:return dict(tool_position=[.062,.024-.059*math.cos(pitch),.030],tool_quaternion=quaternion)
            if t<10.5:
                # Use the measured chip pose, including grasp slip and tilt,
                # to leave its lowest corner 60 micrometres above the insert.
                body=s.m.body('chip').id;rotation=s.d.xmat[body].reshape(3,3)
                extent=float(np.dot(np.abs(rotation[2]),s.m.geom('chip__device_chip').size))
                insert=s.m.geom('base__Target_insert');floor=float(insert.pos[2]+insert.size[2])
                desired=np.array([.062,.024,floor+extent+.00006])
                origin=s.d.xpos[s.m.body('tool').id]+desired-s.d.xpos[body]
                return dict(tool_position=origin.tolist())
            if t<12.0:return dict(jaw_left_angle=0,jaw_right_angle=0)
            return dict(tool_position=[float(s.mocap_target[0]),float(s.mocap_target[1]),.035])
        return {}
