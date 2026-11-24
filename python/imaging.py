"""Thin-specimen camera observations and image-driven microscope controllers.

The camera is an explicit scalar, incoherent, rotationally symmetric optical
surrogate. It does not infer phase/depth from a photograph. Objective NAs, camera
field size, photon count and the synthetic example specimen are benchmark
parameters, not calibrations of the photographed instruments.
"""
from functools import lru_cache
from pathlib import Path
import math
import numpy as np
from PIL import Image, ImageDraw
from scipy.fft import next_fast_len, rfft2, irfft2
from scipy.ndimage import gaussian_filter, sobel
from scipy.special import j0, roots_legendre
from optics import specimen

OBJECTIVES = {4: .10, 5: .12, 10: .25, 20: .40, 40: .65, 50: .65, 100: .80}

def _objective_state(sim):
    if sim.asset=='nikon':
        result=sim.controller.objective()
        return bool(result['indexed']),result['magnification']
    meta=sim.meta.get('imaging',{})
    if sim.asset=='probe':return True,meta.get('magnifications',[10])[0]
    fallback={'zeiss':('turret_angle',[20,50,5,10,100]),
              'transfer':('objective_angle',[10,20,50,None])}
    if sim.asset not in fallback:raise ValueError('No microscope camera for '+sim.asset)
    joint,mags=fallback[sim.asset];mags=meta.get('objective_magnifications',mags)
    angles=meta.get('objective_index_angles_rad',[-k*math.tau/len(mags) for k in range(len(mags))])
    q=sim.q(meta.get('objective_joint',joint))
    errors=np.arctan2(np.sin(q-np.asarray(angles)),np.cos(q-np.asarray(angles)))
    k=int(np.argmin(np.abs(errors)))
    return abs(errors[k])<meta.get('objective_index_tolerance_rad',.025),mags[k]

def optical_path_state(sim, channel='camera'):
    """Measured optical routing without image rendering, suitable for task grading.

    A sliding prism is treated as seated within 0.5 mm of a declared detent.
    Both outputs are blocked between those windows: transit vignetting is an
    explicit surrogate, not a measured transmission curve. Throughputs account
    for objective indexing as well as the selector, and conserve input energy
    with ``camera_throughput + eyepiece_throughput + blocked_fraction == 1``.
    """
    if channel not in ('camera','eyepiece'):raise ValueError('Channel must be camera or eyepiece')
    meta=sim.meta.get('imaging',{})
    fractions=([0.,.8,1.] if sim.asset=='nikon' else meta.get('camera_fractions',[0.,.5,1.]))
    positions=meta.get('light_path_positions_m',meta.get('splitter_travel_m',[0.,.006,.012]))
    position=sim.q(meta.get('light_path_joint','light_path_travel'))
    distances=np.abs(np.asarray(positions)-position);k=int(np.argmin(distances))
    tolerance=float(meta.get('splitter_index_tolerance_m',.0005))
    seated=bool(distances[k]<=tolerance)
    camera=float(fractions[k]) if seated else 0.;eye=1.-camera if seated else 0.
    objective_indexed,mag=_objective_state(sim)
    present=mag is not None;indexed=objective_indexed and seated and present
    illumination=meta.get('illumination');source_fraction=1.;source_on=True
    if illumination:
        source_on=sim.q(illumination['power_joint'])>=illumination['power_threshold_rad']
        lo,hi=illumination['intensity_range']
        level=float(np.clip((sim.q(illumination['intensity_joint'])-lo)/(hi-lo),0,1))
        minimum=illumination['minimum_fraction']
        source_fraction=(minimum+(1-minimum)*level) if source_on else 0.
    cam_throughput=camera*source_fraction if objective_indexed and present else 0.
    eye_throughput=eye*source_fraction if objective_indexed and present else 0.
    throughput=cam_throughput if channel=='camera' else eye_throughput
    if not objective_indexed:status='objective_in_transit'
    elif not present:status='empty_objective_port'
    elif not seated:status='splitter_in_transit'
    elif not source_on:status='illuminator_off'
    elif throughput==0:status=channel+'_port_dark'
    else:status='image_available'
    return dict(channel=channel,indexed=bool(indexed),objective_indexed=bool(objective_indexed),
                objective_present=present,splitter_indexed=seated,splitter_position_m=float(position),
                splitter_detent=k if seated else None,splitter_tolerance_m=tolerance,
                camera_fraction=camera,eyepiece_fraction=eye,camera_throughput=cam_throughput,
                eyepiece_throughput=eye_throughput,throughput=throughput,
                illumination_fraction=source_fraction,illuminator_on=bool(source_on),
                blocked_fraction=1.-cam_throughput-eye_throughput,optical_status=status,
                splitter_model='discrete prism ports; blackout between detent windows')

def probe_specimen(seed=0,size=2048,width_m=.012):
    """Texture of the built 12 mm fixture chip, including its two landing pads.

    Dimensions mirror pad_chip and the probe build, rather than the unrelated
    demonstration micrograph used by the upright microscope image tasks.
    """
    rng=np.random.default_rng(seed)
    grain=rng.normal(0,.8,(size,size,1))
    im=Image.fromarray(np.uint8(np.clip(np.array([79,83,116])+grain,0,255)))
    draw=ImageDraw.Draw(im);center=(size-1)/2;scale=size/width_m
    def rect(x,y,w,h,color):
        draw.rectangle((center+(x-w/2)*scale,center+(y-h/2)*scale,
                        center+(x+w/2)*scale,center+(y+h/2)*scale),fill=color)
    for sign in (-1,1):
        for i in range(6):
            x=(i-2.5)*.012/7
            rect(x,sign*.012*.36,.0007,.001,(189,161,91))
            rect(x,sign*.012*.20,.00009,.003,(174,150,87))
    rect(0,0,.012*.45,.012*.3,(92,70,121))
    for x in (-.0004,.0004):
        rect(x,0,.00030,.00048,(191,164,96))
        rect(x,0,.000286,.000466,(206,179,111))
    return im

def linearize(rgb):
    x=np.asarray(rgb,dtype=np.float32)/255
    return np.where(x<=.04045,x/12.92,((x+.055)/1.055)**2.4)

def encode(linear):
    x=np.clip(linear,0,1)
    x=np.where(x<=.0031308,12.92*x,1.055*x**(1/2.4)-.055)
    return np.uint8(np.clip(x*255+.5,0,255))

@lru_cache(maxsize=96)
def radial_psf(pixel_m, defocus_m, na, wavelength_m):
    """Pixel-integrated scalar pupil PSF, evaluated by radial quadrature.

    Integrating the circular pupil directly avoids truncating it at the camera's
    Nyquist frequency when diffraction structure is smaller than one pixel.
    Angular-spectrum phase also avoids a paraxial defocus error at higher NA.
    """
    z=abs(defocus_m);n=1.0
    radius=z*na/math.sqrt(n*n-na*na)+7*wavelength_m/na
    half=max(3,int(math.ceil(radius/pixel_m)))
    phase_span=2*math.pi*z/wavelength_m*(1-math.sqrt(1-na*na))
    order=max(96,min(1536,int(phase_span/2.5)+96))
    nodes,weights=roots_legendre(order)
    rho=(nodes+1)/2;weights=weights/2*rho
    dr=min(pixel_m/4,wavelength_m/(8*na))
    radial=np.arange(0,math.sqrt(2)*(half+1)*pixel_m+dr,dr)
    phase=np.exp(2j*math.pi*defocus_m/wavelength_m*(np.sqrt(1-(na*rho)**2)-1))
    # Work in bounded radial chunks, independent of the two-dimensional kernel size.
    intensity=np.empty(len(radial))
    for start in range(0,len(radial),1024):
        arg=2*math.pi*na/wavelength_m*np.outer(radial[start:start+1024],rho)
        intensity[start:start+1024]=abs(j0(arg)@(weights*phase))**2
    axis=np.arange(-half,half+1,dtype=float)*pixel_m;xx,yy=np.meshgrid(axis,axis)
    kernel=np.zeros_like(xx)
    # Four subpixel integrations in each direction retain energy at coarse sampling.
    for dx in (-.375,-.125,.125,.375):
        for dy in (-.375,-.125,.125,.375):
            r=np.hypot(xx+dx*pixel_m,yy+dy*pixel_m)
            kernel+=np.interp(r,radial,intensity)
    kernel=np.maximum(kernel,0);kernel/=kernel.sum()
    return kernel.astype(np.float32)

def sharpness(rgb):
    """Smoothed Tenengrad; suppresses shot/read noise before measuring gradients."""
    a=linearize(rgb).mean(axis=2);a=gaussian_filter(a,.7)
    return float(np.mean(sobel(a,0)**2+sobel(a,1)**2))

class MicroscopeCamera:
    def __init__(self, asset, source=None, source_width_m=None, size=256, seed=0,
                 sensor_width_m=.013, photons=50000, noise=True):
        if asset not in ('nikon','zeiss','transfer','probe'):raise ValueError('No microscope camera for '+asset)
        self.asset=asset;self.size=int(size);self.objective_na=dict(OBJECTIVES)
        self.width_m=float(source_width_m if source_width_m is not None else (.012 if asset=='probe' else .002))
        if self.size<32 or self.size>1024 or not math.isfinite(self.width_m) or self.width_m<=0:raise ValueError('Invalid camera dimensions')
        if sensor_width_m<=0 or photons<=0:raise ValueError('Sensor width and photon budget must be positive')
        self.sensor_width_m=sensor_width_m;self.photons=photons;self.noise=noise
        self.rng=np.random.default_rng(seed)
        if source:
            self.source=Image.open(Path(source)).convert('RGB');self.kind='supplied intensity image'
        elif asset=='probe':
            self.source=probe_specimen(seed,width_m=self.width_m);self.kind='synthetic texture of built probe fixture chip and landing pads'
        else:
            self.source=specimen(seed,size=1024);self.kind='synthetic silicon / alignment target'
            # A visible green alignment fiducial defines the optional centering task.
            d=ImageDraw.Draw(self.source);c=self.source.width//2
            d.rectangle((c-18,c-3,c+18,c+3),fill=(42,205,88))
            d.rectangle((c-3,c-18,c+3,c+18),fill=(42,205,88))
            d.rectangle((c-30,c-30,c+30,c+30),outline=(210,180,108),width=2)
        self.background=tuple(np.uint8(np.median(np.asarray(self.source).reshape(-1,3),axis=0)))

    def configuration(self, sim):
        for key,value in sim.meta.get('imaging',{}).get('objective_na_by_mag',{}).items():
            value=float(value)
            if not math.isfinite(value) or not 0<value<1:raise ValueError('Invalid air-objective numerical aperture')
            self.objective_na[int(key)]=value
        indexed,mag=_objective_state(sim);mag=mag if indexed else None
        if self.asset=='nikon':xy=[sim.q('stage_x'),sim.q('stage_y')];z=sim.q('stage_z')
        elif self.asset=='zeiss':xy=[sim.q('stage_x_travel'),sim.q('stage_y_travel')];z=sim.q('focus_travel')
        else:
            opt=sim.meta.get('imaging',{})
            sample=opt.get('sample_surface_site',opt.get('sample_site','device_chip_center'))
            axis=opt.get('optical_axis_site','inspection_axis' if self.asset=='probe' else 'optical_axis')
            xy=(sim.site(sample)-sim.site(axis))[:2]
            z=-sim.q('optic_focus_travel' if self.asset=='probe' else 'scope_focus_travel')
        return mag,xy,z

    def capture(self, sim, focal_plane_m=0., target_stage_xy=(0.,0.), channel='camera'):
        mag,xy,z=self.configuration(sim);rotation=0.;geometry=None
        if self.asset in ('probe','transfer'):
            opt=sim.meta.get('imaging',{})
            sample_name=opt.get('sample_surface_site',opt.get('sample_site','device_chip_center'))
            matrix=sim.d.site(sample_name).xmat.reshape(3,3)
            rotation=math.atan2(matrix[1,0],matrix[0,0])
            if self.asset=='probe':
                axis=sim.site(opt.get('optical_axis_site','inspection_axis'))
                sample=sim.site(sample_name);origin=np.array([axis[0],axis[1],sample[2]])
                geometry=dict(needles=[dict(name=side,start=(sim.site(side+'_shank_start')-origin).tolist(),
                                           tip=(sim.site(side+'_tip')-origin).tolist()) for side in ('left','right')],
                              pads={side:(sim.site(side+'_pad')-origin).tolist() for side in ('left','right')})
        return self.capture_state(mag,xy,z,focal_plane_m,target_stage_xy,channel=channel,
                                  routing=optical_path_state(sim,channel),rotation_rad=rotation,probe_geometry=geometry)

    def _specimen_linear(self,mag,xy,defocus_m,target_stage_xy,rotation_rad):
        size=self.size;na=self.objective_na[mag];pixel=self.sensor_width_m/mag/size
        z=round(defocus_m/1e-7)*1e-7
        blur_radius=abs(z)*na/math.sqrt(1-na*na)
        if blur_radius>pixel*size*2:
            return linearize(np.broadcast_to(np.asarray(self.background),(size,size,3))), 'far defocus; finite texture field averaged'
        kernels=[radial_psf(pixel,z,na,lam) for lam in (620e-9,540e-9,460e-9)]
        pad=max(k.shape[0]//2 for k in kernels)+2;n=size+2*pad
        # Fetch the wider physical specimen before convolution: features outside
        # the image may contribute, without FFT wraparound. Rotation follows the
        # measured specimen frame for the probe and transfer stages.
        texel=self.width_m/self.source.width;scale=pixel/texel
        c,s=math.cos(rotation_rad),math.sin(rotation_rad);inverse=np.array([[c,s],[-s,c]])
        matrix=inverse@np.diag([-scale,scale])
        center=np.asarray(target_stage_xy)-np.asarray(xy)
        offset=np.array(self.source.size)/2+inverse@center/texel-matrix@np.full(2,(n-1)/2)
        transform=(*matrix[0],offset[0],*matrix[1],offset[1])
        tile=self.source.transform((n,n),Image.Transform.AFFINE,transform,Image.Resampling.BILINEAR,fillcolor=self.background)
        a=linearize(tile);out=np.empty((size,size,3),np.float32)
        for channel,k in enumerate(kernels):
            h,w=a.shape[:2];kh,kw=k.shape;shape=(next_fast_len(h+kh-1),next_fast_len(w+kw-1))
            blurred=irfft2(rfft2(a[:,:,channel],shape)*rfft2(k,shape),shape)
            offset=(kh-1)//2+pad;out[:,:,channel]=blurred[offset:offset+size,offset:offset+size]
        return out,'image available'

    def _probe_layers(self,out,geometry,pixel,na,defocus_m):
        """Spatially varying defocus of measured needle projections.

        Each tapered shank is clipped near the field and split into depth layers.
        Gaussian blur matches the second moment of a geometric defocus disc;
        this is a 2.5D occlusion approximation, not coherent metal scattering.
        """
        size=self.size;guard=max(16,size//3);canvas=size+2*guard
        center=(size-1)/2;field=size*pixel;ground_truth=dict(probe_tips={},probe_pads={})
        def project(point):return np.array([center-point[0]/pixel,center+point[1]/pixel])
        for side,point in geometry['pads'].items():ground_truth['probe_pads'][side]=dict(pixel_xy=project(point).tolist())
        # The more elevated needle is in front under this top-down projection.
        for needle in sorted(geometry['needles'],key=lambda x:x['tip'][2]):
            start=np.asarray(needle['start']);tip=np.asarray(needle['tip']);delta=start-tip;length=float(np.linalg.norm(delta))
            tip_pixel=project(tip)
            ground_truth['probe_tips'][needle['name']]=dict(pixel_xy=tip_pixel.tolist(),height_above_sample_m=float(tip[2]),
                                                           defocus_m=float(tip[2]+defocus_m),shank_start_pixel_xy=project(start).tolist())
            # Liang-Barsky interval for the straight centreline, enlarged so that
            # offscreen nearby features can still blur into the observation.
            lo,hi=0.,1.;bound=field*1.5
            for axis in (0,1):
                if abs(delta[axis])<1e-12:
                    if abs(tip[axis])>bound:lo,hi=1.,0.;break
                else:
                    limits=sorted(((-bound-tip[axis])/delta[axis],(bound-tip[axis])/delta[axis]))
                    lo=max(lo,limits[0]);hi=min(hi,limits[1])
            if hi<=lo:continue
            # Match the visible tapered shaft in the 3D geometry: r=60 um at the
            # tip, 400 um at 10 mm, then widening toward the 1.25 mm holder end.
            def radius(t):return float(np.interp(t*length,[0,.010,max(.010,length-.005),length],[.00006,.0004,.00125,.00125]))
            alpha_sum=np.zeros((canvas,canvas),np.float32);color_sum=np.zeros((canvas,canvas,3),np.float32)
            cuts=np.linspace(lo,hi,25)
            for t0,t1 in zip(cuts,cuts[1:]):
                p0=tip+delta*t0;p1=tip+delta*t1;v0=project(p0)+guard;v1=project(p1)+guard
                direction=v1-v0;norm=np.linalg.norm(direction)
                if norm<1e-8:continue
                normal=np.array([-direction[1],direction[0]])/norm;r0=radius(t0)/pixel;r1=radius(t1)/pixel
                polygon=[v0+normal*r0,v1+normal*r1,v1-normal*r1,v0-normal*r0]
                depth=(p0[2]+p1[2])/2+defocus_m
                disc=abs(depth)*na/math.sqrt(1-na*na)/pixel
                sigma=math.sqrt((.21*550e-9/na/pixel)**2+(disc/2)**2)
                # Subpixel rasterization matters only near focus; the defocus
                # convolution already integrates coarser off-focus boundaries.
                oversample=3 if sigma<1.5 else 1
                mask=Image.new('L',(canvas*oversample,canvas*oversample));d=ImageDraw.Draw(mask)
                d.polygon([tuple(p*oversample) for p in polygon],fill=255)
                if t0==0:
                    rr=r0*oversample;cc=v0*oversample;d.ellipse((cc[0]-rr,cc[1]-rr,cc[0]+rr,cc[1]+rr),fill=255)
                if oversample>1:mask=mask.resize((canvas,canvas),Image.Resampling.LANCZOS)
                alpha=np.asarray(mask,dtype=np.float32)/255
                # The guarded field bounds cost for nearly invisible distant
                # shank segments while retaining energy over the image.
                alpha=gaussian_filter(alpha,max(.25,min(sigma,canvas)),mode='constant',truncate=3.)
                shade=np.array([.19,.215,.24])*(.92+.08*math.cos(t0*17))
                alpha_sum+=alpha;color_sum+=alpha[:,:,None]*shade
            alpha=np.clip(alpha_sum,0,1)[guard:guard+size,guard:guard+size]
            color=color_sum[guard:guard+size,guard:guard+size]/np.maximum(alpha_sum[guard:guard+size,guard:guard+size,None],1e-6)
            out=out*(1-alpha[:,:,None])+color*alpha[:,:,None]
        return out,ground_truth

    def capture_state(self,mag,xy,z,focal_plane_m=0.,target_stage_xy=(0.,0.),*,channel='camera',routing=None,
                      rotation_rad=0.,probe_geometry=None):
        """Render sensor state without mutating simulation; optional routing is measured.

        Legacy callers supplying only objective/stage state receive unit exposure
        at the requested sensor. Use capture(sim) for physical light-path routing.
        """
        if channel not in ('camera','eyepiece'):raise ValueError('Channel must be camera or eyepiece')
        size=self.size;defocus=float(z-focal_plane_m)
        meta=dict(source=self.kind,model='scalar incoherent circular pupil',calibrated=False,
                  magnification=mag,defocus_m=defocus,image_axes=[-1,1],source_width_m=self.width_m,
                  channel=channel,sample_rotation_rad=float(rotation_rad))
        route=dict(routing or dict(channel=channel,throughput=1.,optical_status='image_available',
                                  splitter_model='sensor-state replay without a measured selector'))
        meta.update(route)
        if mag is not None:
            na=self.objective_na[mag];pixel=self.sensor_width_m/mag/size
            meta.update(na=na,pixel_m=pixel,field_width_m=pixel*size)
        if mag is None or route['throughput']<=0:
            status='no indexed objective' if mag is None else route['optical_status'].replace('_',' ')
            return dict(rgb=np.zeros((size,size,3),np.uint8),status=status,sharpness=0.,**meta)
        out,status=self._specimen_linear(mag,xy,defocus,target_stage_xy,rotation_rad)
        if probe_geometry is not None:
            out,truth=self._probe_layers(out,probe_geometry,pixel,na,defocus);meta['ground_truth']=truth
            meta['probe_model']='measured top-down tapered-shank projection; segmented Gaussian geometric defocus and alpha occlusion'
            meta['probe_model_limits']='estimated NA and reflectance; Gaussian disc-moment blur; no coherent scattering, calibrated illumination or stereo parallax'
        elif self.asset=='transfer':meta['scene_layers']='thin specimen only; stamp occlusion is not modeled'
        out=np.maximum(out,0)*float(route['throughput'])
        if self.noise:
            out=self.rng.poisson(out*self.photons)/self.photons+self.rng.normal(0,.0005,out.shape)
        rgb=encode(out)
        return dict(rgb=rgb,status=status,sharpness=sharpness(rgb),**meta)

class AutofocusController:
    """Coarse-to-fine image search. Receives images and stage encoders, no focal goal."""
    def __init__(self, capture, focus_position, asset):
        self.capture=capture;self.position=focus_position;self.asset=asset
        self.candidates=list(np.linspace(-.0007,.0007,15));self.samples=[]
        self.round=0;self.target=self.candidates.pop(0);self.settled=0;self.done=False
        self.history=[];self.drive=0.

    def action(self):
        if not self.done:
            self.settled=self.settled+1 if abs(self.position()-self.target)<2e-6 else 0
            if self.settled>=6:
                image=self.capture();score=sharpness(image['rgb']);position=self.position();self.samples.append((position,score))
                self.history.append(dict(z_m=position,sharpness=score));self.settled=0
                if not self.candidates:
                    best=max(self.samples,key=lambda x:x[1])[0];self.samples=[];self.round+=1
                    if self.round==1:self.candidates=list(np.linspace(best-.0001,best+.0001,9))
                    elif self.round==2:self.candidates=list(np.linspace(best-.000025,best+.000025,11))
                    elif self.round==3:self.candidates=list(np.linspace(best-.000005,best+.000005,9))
                    else:self.target=best;self.done=True
                if self.candidates:self.target=float(self.candidates.pop(0))
        if self.asset=='nikon':return {'coarse':self.target/.005*math.tau}
        # Encoder feedback compensates the load on the estimated Zeiss focus rack.
        # This loop uses only proprioception; the desired focal plane remains hidden.
        self.drive+=float(np.clip(.5*(self.target-self.position()),-.00004,.00004))
        return {'focus_travel':self.drive}

class ImageCenterController:
    """Center the synthetic fiducial using pixels and calibrated stage gearing."""
    def __init__(self,capture,stage_position):
        self.capture=capture;self.position=stage_position;self.tick=0;self.target=np.asarray(stage_position())
    def action(self):
        if self.tick%5==0:
            obs=self.capture();a=obs['rgb'].astype(float)
            mask=(a[:,:,1]>a[:,:,0]*1.6)&(a[:,:,1]>a[:,:,2]*1.4)&(a[:,:,1]>110)
            yy,xx=np.nonzero(mask)
            if len(xx)>=5:
                error=(np.array([xx.mean(),yy.mean()])-(np.array(a.shape[:2])[::-1]-1)/2)*obs['pixel_m']
                self.target=np.asarray(self.position())+np.clip(error*[1,-1]*.8,-.00012,.00012)
        self.tick+=1
        return dict(kx=float(self.target[0]/.020*math.tau),ky=float(self.target[1]/.016*math.tau))
