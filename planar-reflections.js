import * as THREE from 'three';

// One-bounce local radiance for broad, truly planar receivers. This deliberately
// changes no source mesh, source PBR value, physics transform, or scene light.
// Captures contain actual current-pose geometry, including geometry outside the
// main camera. Transparent background means missing geometry keeps the HDR.
const shader = `
uniform highp sampler2D labPlanarColor, labPlanarDepth;
uniform mat4 labPlanarProjection, labPlanarInverseProjection, labPlanarCameraWorld;
uniform vec4 labPlanarPlane;
uniform vec2 labPlanarResolution;
uniform float labPlanarEnabled, labPlanarTolerance, labPlanarExtent, labPlanarFocal;
varying vec3 vLabPlanarWorld;

vec3 labPlanarRadiance(vec3 environment, vec3 viewDir, vec3 normal, float roughness, vec3 bitangent, float anisotropy) {
 if(labPlanarEnabled<.5)return environment;
 float planeDistance=dot(labPlanarPlane.xyz,vLabPlanarWorld)+labPlanarPlane.w;
 if(abs(planeDistance)>labPlanarTolerance)return environment;
 // Geometry eligibility cannot follow normal-map grain or the anisotropic
 // bent normal. The exact planar projection remains spatially continuous.
 vec3 facet=normalize(cross(dFdx(vLabPlanarWorld),dFdy(vLabPlanarWorld)));
 if(abs(dot(facet,labPlanarPlane.xyz))<.9995)return environment;
 vec4 clip=labPlanarProjection*vec4(vLabPlanarWorld,1.0);
 if(clip.w<=0.0)return environment;
 vec2 uv=clip.xy/clip.w*.5+.5;
 if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0))))return environment;

 float depth=texture2D(labPlanarDepth,uv).r;
 float distanceToScene=labPlanarExtent*.25;
 float projectedDistance=clip.w+distanceToScene;
 if(depth<.999999){
  vec4 q=labPlanarInverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);
  vec3 hit=(labPlanarCameraWorld*vec4(q.xyz/q.w,1.0)).xyz;
  distanceToScene=length(hit-vLabPlanarWorld);
  projectedDistance=(labPlanarProjection*vec4(hit,1.0)).w;
 }
 // A single captured depth cannot reproject arbitrary bent/normal-map rays:
 // adjacent rays jump between unrelated source surfaces. Use the exact macro
 // plane projection and filter the original roughness lobe continuously.
 // Original mapped normals still participate in the PBR/Fresnel response.
 float aspect=sqrt(max(.1,1.0-.9*anisotropy));
 float pixels=roughness*roughness*distanceToScene/max(projectedDistance,.0001)*labPlanarResolution.y*labPlanarFocal;
 float minorPixels=pixels*aspect,majorPixels=pixels/aspect;
 float lod=clamp(log2(max(minorPixels,1.0)),0.0,log2(max(labPlanarResolution.x,labPlanarResolution.y)));
 vec4 local=textureLod(labPlanarColor,uv,lod);
 if(anisotropy>.001){
  // Blender's original GGX axes: alphaT=r²/aspect, alphaB=r²*aspect.
  // The minor-axis mip footprint is extended along the physical tangent by a
  // normalized Gaussian quadrature. RGB and coverage use identical weights.
  // This preserves the geometric reflection center and never displaces it by
  // a bent normal evaluated against an unrelated sampled depth.
  vec3 worldB=inverseTransformDirection(bitangent,viewMatrix);
  worldB-=labPlanarPlane.xyz*dot(worldB,labPlanarPlane.xyz);
  if(dot(worldB,worldB)>.0001){
   worldB=normalize(worldB);vec3 worldT=normalize(cross(worldB,labPlanarPlane.xyz));
   vec3 worldView=inverseTransformDirection(viewDir,viewMatrix);
   vec3 ray=reflect(-worldView,labPlanarPlane.xyz);
   vec4 center=labPlanarProjection*vec4(vLabPlanarWorld+ray*distanceToScene,1.0);
   vec3 derivative=dot(worldView,worldT)*labPlanarPlane.xyz+dot(worldView,labPlanarPlane.xyz)*worldT;
   vec4 delta=labPlanarProjection*vec4(derivative,0.0);
   vec2 axis=(delta.xy*center.w-center.xy*delta.w)/max(center.w*center.w,.0001);
   axis*=labPlanarResolution;
   if(dot(axis,axis)>.00001){
    axis=normalize(axis);
    // A box mip's variance is width²/12; add only the variance missing from
    // the requested major axis, keeping the isotropic energy scale unchanged.
    vec2 stepUV=axis*sqrt(max(0.0,majorPixels*majorPixels-minorPixels*minorPixels)/12.0)/labPlanarResolution;
    local=local*.4;
    local+=(textureLod(labPlanarColor,uv+stepUV,lod)+textureLod(labPlanarColor,uv-stepUV,lod))*.24;
    local+=(textureLod(labPlanarColor,uv+stepUV*2.0,lod)+textureLod(labPlanarColor,uv-stepUV*2.0,lod))*.06;
   }
  }
 }
 float edge=min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y));
 float edgeWeight=smoothstep(0.0,2.0/max(labPlanarResolution.x,labPlanarResolution.y),edge);
 // Mips filter radiance and coverage together. Replacing covered HDR avoids
 // adding a second environment term. Built-in PBR subsequently applies the
 // original material's Fresnel, roughness, AO and multiple-scattering response.
 return mix(environment,local.rgb+environment*(1.0-local.a),edgeWeight);
}
`;

function sourceMaterialCopy(source) {
 const material=source.clone();
 // Material.clone does not inherit compile callbacks, but explicitly remove
 // any application-added callback so captures never sample the main-camera
 // cavity/SSR or recursively use another planar capture.
 material.onBeforeCompile=()=>{};
 material.customProgramCacheKey=()=>'';
 return material;
}

export class PlanarReflections {
 constructor(renderer,scene,{resolution=768,areaShadows=null,prepareCaptureMaterial=null}={}) {
  this.renderer=renderer;this.scene=scene;this.resolution=resolution;
  this.receivers=[];this.materialEntries=new Map();this.captureMaterials=new Map();
  this.enabled=true;this.captureCount=0;this.updateCount=0;this.extent=1;this.disposed=false;this.failed=false;this.lastError=null;this.lastUpdateMs=0;this.prepareCaptureMaterial=prepareCaptureMaterial;
  // Reuse actual emitter depth maps, but select the direct branch with the
  // hardware-safe sample count. Main-camera resolved visibility is inapplicable
  // from a reflected camera. No second atlas or source lights are constructed.
  this.captureShadows=areaShadows?Object.assign(Object.create(areaShadows),{
   resolve:null,resolved:{value:false},materials:new WeakSet()
  }):null;
 }

 addReceiver({object,point=new THREE.Vector3(),normal=new THREE.Vector3(0,1,0),materials=null,label=object.name||'Planar receiver',area=0,persistent=false}={}) {
  if(!object?.isMesh)throw Error('A planar receiver must be an existing mesh');
  const target=new THREE.WebGLRenderTarget(this.resolution,this.resolution,{
   type:THREE.HalfFloatType,minFilter:THREE.LinearMipmapLinearFilter,
   magFilter:THREE.LinearFilter,generateMipmaps:true,depthBuffer:true
  });
  target.texture.name=label+' current scene radiance';
  target.depthTexture=new THREE.DepthTexture(this.resolution,this.resolution,THREE.UnsignedIntType);
  const entry={object,point:point.clone(),normal:normal.clone().normalize(),label,area,persistent,target,camera:new THREE.PerspectiveCamera(),worldPlane:new THREE.Plane(),captures:0,uniforms:{
   labPlanarColor:{value:target.texture},labPlanarDepth:{value:target.depthTexture},
   labPlanarProjection:{value:new THREE.Matrix4()},labPlanarInverseProjection:{value:new THREE.Matrix4()},labPlanarCameraWorld:{value:new THREE.Matrix4()},
   labPlanarPlane:{value:new THREE.Vector4()},labPlanarResolution:{value:new THREE.Vector2(this.resolution,this.resolution)},
   labPlanarEnabled:{value:0},labPlanarTolerance:{value:Math.max(2e-6,this.extent*1e-5)},labPlanarExtent:{value:this.extent},labPlanarFocal:{value:1}
  }};
  this.receivers.push(entry);
  for(const material of materials||[].concat(object.material)) {
   if(!material?.isMeshStandardMaterial)continue;
   // First broad plane for a shared merged material wins. Other fragments of
   // that material are rejected by the geometric world-plane predicate.
   if(this.materialEntries.has(material))continue;
   this.materialEntries.set(material,entry);
   const previous=material.onBeforeCompile,key=material.customProgramCacheKey;
   entry.hooks ||= [];
   const compile=(program,r)=>{
    previous.call(material,program,r);Object.assign(program.uniforms,entry.uniforms);
    program.vertexShader='varying vec3 vLabPlanarWorld;\n'+program.vertexShader;
    program.vertexShader=program.vertexShader.replace('#include <worldpos_vertex>',`#include <worldpos_vertex>\nvLabPlanarWorld=(modelMatrix*vec4(transformed,1.0)).xyz;`);
    // Hook the shared IBL radiance function. getIBLAnisotropyRadiance already
    // supplies Three's material-specific bent normal, and clearcoat uses its
    // own roughness. Diffuse irradiance and analytic area lights remain intact.
    let ibl=THREE.ShaderChunk.envmap_physical_pars_fragment;
    const start=ibl.indexOf('vec3 getIBLRadiance('),end=ibl.indexOf('#ifdef USE_ANISOTROPY',start);
    const original=ibl.slice(start,end).replace('vec3 getIBLRadiance(', 'vec3 labPlanarEnvironmentRadiance(');
    const wrapper='vec3 getIBLRadiance(const in vec3 viewDir,const in vec3 normal,const in float roughness){return labPlanarRadiance(labPlanarEnvironmentRadiance(viewDir,normal,roughness),viewDir,normal,roughness,vec3(0.0),0.0);}\n';
    const anisotropic=ibl.slice(end).replace('return getIBLRadiance( viewDir, bentNormal, roughness );','return labPlanarRadiance(labPlanarEnvironmentRadiance(viewDir,bentNormal,roughness),viewDir,normal,roughness,bitangent,anisotropy);');
    ibl=ibl.slice(0,start)+original+wrapper+anisotropic;
    program.fragmentShader=program.fragmentShader.replace('#include <envmap_physical_pars_fragment>',shader+'\n'+ibl);
   };
   // A late physics-site attachment may reuse the same source material after
   // its old receiver was disposed. Three caches each material's uniforms by
   // program key; a new target needs a new key so onBeforeCompile binds this
   // receiver's live uniforms rather than the retired target's uniforms.
   const cache=()=>key.call(material)+'|lab-planar-radiance-ellipse-v1|'+entry.target.texture.uuid;
   material.onBeforeCompile=compile;material.customProgramCacheKey=cache;material.needsUpdate=true;
   entry.hooks.push({material,previous,key,compile,cache});
  }
  return entry;
 }

 attach(model,options={}) {
  this.disposeModel();this.failed=false;this.lastError=null;
  const planes=findHorizontalPlanes(model,options);for(const plane of planes)this.addReceiver(plane);
  return this.stats;
 }

 get stats() {return {enabled:this.enabled&&!this.disposed,ready:this.receivers.some(e=>e.uniforms.labPlanarEnabled.value>.5),failed:this.failed,lastError:this.lastError,updateCount:this.updateCount,captureCount:this.captureCount,receiverCount:this.receivers.length,lastUpdateMs:this.lastUpdateMs,receivers:this.receivers.map(e=>({label:e.label,area:e.area,captures:e.captures,enabled:e.uniforms.labPlanarEnabled.value>.5,plane:e.uniforms.labPlanarPlane.value.toArray()}))};}

 update(modelOrCamera,optionalCamera) {
  const camera=optionalCamera||modelOrCamera;
  if(this.disposed||!this.enabled||this.failed){for(const e of this.receivers)e.uniforms.labPlanarEnabled.value=0;return;}
  const started=performance.now();
  const r=this.renderer,s=this.scene,old={target:r.getRenderTarget(),background:s.background,override:s.overrideMaterial,color:r.getClearColor(new THREE.Color()),alpha:r.getClearAlpha(),tone:r.toneMapping,xr:r.xr.enabled,auto:r.autoClear,viewport:r.getViewport(new THREE.Vector4()),scissor:r.getScissor(new THREE.Vector4()),scissorTest:r.getScissorTest()};
  const swapped=[],hidden=[];
  s.updateMatrixWorld(true);camera.updateMatrixWorld();
  // Swap only for the capture draw and restore even if a shader throws. These
  // copies share immutable textures/geometry with the actual visible objects.
  try {
  s.traverseVisible(o=>{
   if(o.userData.rasterOnly||o.userData.physicsOverlay){hidden.push(o);o.visible=false;return;}
   if(!o.isMesh)return;
   const materials=[].concat(o.material),copies=materials.map(m=>{
    let copy=this.captureMaterials.get(m);
    if(!copy){copy=sourceMaterialCopy(m);try{this.prepareCaptureMaterial?.(copy,m);this.captureShadows?.applyMaterial(copy);}catch(error){copy.dispose();throw error;}this.captureMaterials.set(m,copy);}
    else {const version=copy.userData.planarSourceVersion;copy.copy(m);if(version!==m.version)copy.needsUpdate=true;}
    copy.userData.planarSourceVersion=m.version;
    return copy;
   });
   swapped.push([o,o.material]);o.material=Array.isArray(o.material)?copies:copies[0];
  });
   r.xr.enabled=false;r.autoClear=true;r.toneMapping=THREE.NoToneMapping;
   s.background=null;s.overrideMaterial=null;r.setClearColor(0x000000,0);r.setScissorTest(false);
   for(const e of this.receivers) {
    const point=e.point.clone().applyMatrix4(e.object.matrixWorld);
    const normal=e.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(e.object.matrixWorld)).normalize();
    const plane=e.worldPlane.setFromNormalAndCoplanarPoint(normal,point);
    const eye=camera.getWorldPosition(new THREE.Vector3());
    if(plane.distanceToPoint(eye)<=this.extent*1e-5){e.uniforms.labPlanarEnabled.value=0;continue;}
    const forward=camera.getWorldDirection(new THREE.Vector3()),up=new THREE.Vector3(0,1,0).transformDirection(camera.matrixWorld);
    const reflectPoint=p=>p.addScaledVector(normal,-2*plane.distanceToPoint(p));
    const reflectedEye=reflectPoint(eye.clone()),look=reflectPoint(eye.clone().add(forward));
    const virtual=e.camera;virtual.copy(camera,false);virtual.position.copy(reflectedEye);virtual.up.copy(up.reflect(normal));virtual.lookAt(look);virtual.updateMatrixWorld();
    virtual.matrixWorldInverse.copy(virtual.matrixWorld).invert();virtual.projectionMatrix.copy(camera.projectionMatrix);
    // Oblique near plane clips away the receiver itself and all geometry on
    // the viewer's opposite side; nothing is deleted from source geometry.
    const clipPlane=plane.clone();clipPlane.constant-=Math.max(2e-6,this.extent*1e-5);clipPlane.applyMatrix4(virtual.matrixWorldInverse);
    const clip=new THREE.Vector4(clipPlane.normal.x,clipPlane.normal.y,clipPlane.normal.z,clipPlane.constant),p=virtual.projectionMatrix.elements;
    const q=new THREE.Vector4((Math.sign(clip.x)+p[8])/p[0],(Math.sign(clip.y)+p[9])/p[5],-1,(1+p[10])/p[14]);
    clip.multiplyScalar(2/clip.dot(q));p[2]=clip.x;p[6]=clip.y;p[10]=clip.z+1;p[14]=clip.w;
    virtual.projectionMatrixInverse.copy(virtual.projectionMatrix).invert();
    const u=e.uniforms;u.labPlanarProjection.value.multiplyMatrices(virtual.projectionMatrix,virtual.matrixWorldInverse);u.labPlanarInverseProjection.value.copy(virtual.projectionMatrixInverse);u.labPlanarCameraWorld.value.copy(virtual.matrixWorld);u.labPlanarPlane.value.set(normal.x,normal.y,normal.z,plane.constant);u.labPlanarExtent.value=this.extent;u.labPlanarTolerance.value=Math.max(2e-6,this.extent*1e-5);u.labPlanarFocal.value=camera.projectionMatrix.elements[5]*.5;
    r.setRenderTarget(e.target);r.clear(true,true,false);r.render(s,virtual);u.labPlanarEnabled.value=1;this.captureCount++;e.captures++;
   }
   this.updateCount++;
  } catch(error) {
   this.failed=true;this.lastError=String(error.message||error);for(const e of this.receivers)e.uniforms.labPlanarEnabled.value=0;throw error;
  } finally {
   for(const [o,m] of swapped)o.material=m;for(const o of hidden)o.visible=true;
   s.background=old.background;s.overrideMaterial=old.override;r.xr.enabled=old.xr;r.autoClear=old.auto;r.toneMapping=old.tone;r.setClearColor(old.color,old.alpha);r.setRenderTarget(old.target);r.setViewport(old.viewport);r.setScissor(old.scissor);r.setScissorTest(old.scissorTest);this.lastUpdateMs=performance.now()-started;
  }
 }

 clearReceivers(keepPersistent=false) {
  for(const e of this.receivers){if(keepPersistent&&e.persistent)continue;e.target.dispose();for(const h of e.hooks||[]){if(h.material.onBeforeCompile===h.compile)h.material.onBeforeCompile=h.previous;if(h.material.customProgramCacheKey===h.cache)h.material.customProgramCacheKey=h.key;h.material.needsUpdate=true;this.materialEntries.delete(h.material);}}
  for(const material of this.captureMaterials.values())material.dispose();
  this.captureMaterials.clear();this.receivers=keepPersistent?this.receivers.filter(e=>e.persistent):[];
 }
 disposeModel(){this.clearReceivers(true);}
 dispose(){if(this.disposed)return;this.disposed=true;this.clearReceivers();}
}

// Export merging groups multiple surfaces by material. Select actual coplanar
// triangles, never whole bounding-box tops or material-name guesses.
export function findHorizontalPlanes(root,{minArea=.006,maxPlanes=3}={}) {
 root.updateMatrixWorld(true);const candidates=[],a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),edge=new THREE.Vector3(),n=new THREE.Vector3();
 root.traverse(object=>{
  if(!object.isMesh||!object.geometry?.attributes.position)return;
  const geometry=object.geometry,position=geometry.attributes.position,index=geometry.index,groups=new Map(),count=index?index.count:position.count;
  for(let i=0;i<count;i+=3){
   a.fromBufferAttribute(position,index?index.getX(i):i).applyMatrix4(object.matrixWorld);b.fromBufferAttribute(position,index?index.getX(i+1):i+1).applyMatrix4(object.matrixWorld);c.fromBufferAttribute(position,index?index.getX(i+2):i+2).applyMatrix4(object.matrixWorld);
   n.subVectors(b,a).cross(edge.subVectors(c,a));const area=n.length()*.5;if(area<1e-10)continue;n.normalize();if(n.y<.99999)continue;
   const y=(a.y+b.y+c.y)/3,key=Math.round(y/1e-5);let group=groups.get(key);if(!group){group={area:0,weighted:new THREE.Vector3(),height:key*1e-5,triangles:0,bounds:new THREE.Box3()};groups.set(key,group);}
   group.area+=area;group.weighted.addScaledVector(a,area/3).addScaledVector(b,area/3).addScaledVector(c,area/3);group.triangles++;
   group.bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c);
  }
  for(const group of groups.values())if(group.area>=minArea){
   const worldPoint=group.weighted.divideScalar(group.area),inverse=object.matrixWorld.clone().invert();
   candidates.push({object,point:worldPoint.clone().applyMatrix4(inverse),normal:new THREE.Vector3(0,1,0).applyMatrix3(new THREE.Matrix3().getNormalMatrix(inverse)).normalize(),area:group.area,triangles:group.triangles,bounds:group.bounds,worldHeight:worldPoint.y,label:object.name+' plane '+worldPoint.y.toFixed(5)});
  }
 });
 candidates.sort((a,b)=>b.area-a.area);const selected=[],materials=new Set();
 for(const candidate of candidates){
  // Some exported assemblies retain the original slab underneath a detailed,
  // drilled top plate. The covered slab can have MORE triangle area because it
  // has no holes. Prefer the actual closely overlaid upper surface when its
  // projected footprint covers the lower candidate nearly completely.
  const box=candidate.bounds,size=box.getSize(new THREE.Vector3()),footprint=size.x*size.z;
  const covered=candidates.some(upper=>{
   const rise=upper.worldHeight-candidate.worldHeight;if(rise<=1e-5||rise>Math.min(size.x,size.z)*.08||upper.area<candidate.area*.85)return false;
   const overlap=Math.max(0,Math.min(box.max.x,upper.bounds.max.x)-Math.max(box.min.x,upper.bounds.min.x))*Math.max(0,Math.min(box.max.z,upper.bounds.max.z)-Math.max(box.min.z,upper.bounds.min.z));
   return overlap>footprint*.95;
  });
  if(covered||[].concat(candidate.object.material).some(m=>materials.has(m)))continue;
  selected.push(candidate);for(const m of [].concat(candidate.object.material))materials.add(m);if(selected.length>=maxPlanes)break;
 }
 return selected;
}
