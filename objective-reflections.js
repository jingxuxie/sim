import * as THREE from 'three';
import {correctEnvironmentAxes} from './env-axis.js';

// View-independent local radiance for real objective assemblies. One texture
// array holds every filtered cubemap and its unfiltered radial-depth layer.
// The capture omits only its own barrel, retaining adjacent objectives.
const DESCRIPTORS={
 nikon:{assembly:'turret',prefix:'',radius:.0145},
 transfer:{assembly:'objective_turret',prefix:'objective_',radius:.017},
 zeiss:{assembly:'turret',prefix:'objective_',radius:.0145},
 probe:{assembly:'optic_focus',prefix:'objective_',radius:.0145}
};
// Three increments material.version while temporarily switching DoubleSide
// transparent materials between front/back passes. That is renderer bookkeeping,
// not changed scene radiance. Hash physical inputs and the maps actually used.
const PHYSICAL_VALUES=['roughness','metalness','opacity','alphaTest','side','visible','transparent','wireframe','flatShading','vertexColors','depthTest','depthWrite','normalMapType','bumpScale','displacementScale','displacementBias','envMapIntensity','aoMapIntensity','lightMapIntensity','emissiveIntensity','ior','specularIntensity','clearcoat','clearcoatRoughness','transmission','thickness','attenuationDistance','anisotropy','anisotropyRotation','sheen','sheenRoughness','iridescence','iridescenceIOR'];
const PHYSICAL_COLORS=['color','emissive','specularColor','sheenColor','attenuationColor'];
const PHYSICAL_MAPS=['map','normalMap','roughnessMap','metalnessMap','emissiveMap','alphaMap','aoMap','lightMap','bumpMap','displacementMap','envMap','clearcoatMap','clearcoatNormalMap','clearcoatRoughnessMap','iridescenceMap','iridescenceThicknessMap','sheenColorMap','sheenRoughnessMap','specularColorMap','specularIntensityMap','transmissionMap','thicknessMap','anisotropyMap'];
function excludedFromCapture(object,materials){return object.userData.rasterOnly||object.userData.physicsOverlay||materials.some(m=>(m.transmission||0)>.1||(m.transparent&&m.opacity<.98));}
function materialSignature(material,signature){
 signature.push(material.id,...PHYSICAL_VALUES.map(name=>material[name]??null));
 for(const name of PHYSICAL_COLORS){const value=material[name];signature.push(value?.r||0,value?.g||0,value?.b||0);}
 for(const name of ['normalScale','clearcoatNormalScale']){const value=material[name];signature.push(value?.x||0,value?.y||0);}
 signature.push(...(material.iridescenceThicknessRange||[0,0]));
 signature.push(JSON.stringify(Object.entries(material.defines||{}).sort((a,b)=>a[0].localeCompare(b[0]))));
 for(const name of PHYSICAL_MAPS){
  const texture=material[name];signature.push(texture?.id||0,texture?.version||0);
  if(texture){
   signature.push(texture.channel,texture.colorSpace,texture.rotation,texture.offset.x,texture.offset.y,texture.repeat.x,texture.repeat.y,texture.center.x,texture.center.y,texture.wrapS,texture.wrapT,texture.flipY,texture.matrixAutoUpdate);
   if(!texture.matrixAutoUpdate)signature.push(...texture.matrix.elements);
  }
 }
}
const quadVertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
const copyFragment=`uniform sampler2D radiance;uniform samplerCube radialDepth;uniform bool copyDepth;uniform float faceResolution;varying vec2 vUv;
void main(){
 if(!copyDepth){gl_FragColor=texture2D(radiance,vUv);return;}
 vec2 pixel=gl_FragCoord.xy;vec2 tile=floor(pixel/faceResolution);float face=tile.x+3.0*tile.y;
 if(face>5.0){gl_FragColor=vec4(-1.0);return;}
 vec2 uv=fract(pixel/faceResolution)*2.0-1.0;vec3 direction;
 if(face<.5)direction=vec3(1.0,uv.y,uv.x);
 else if(face<1.5)direction=vec3(-uv.x,1.0,-uv.y);
 else if(face<2.5)direction=vec3(-uv.x,uv.y,1.0);
 else if(face<3.5)direction=vec3(-1.0,uv.y,-uv.x);
 else if(face<4.5)direction=vec3(-uv.x,-1.0,uv.y);
 else direction=vec3(uv.x,uv.y,-1.0);
 gl_FragColor=vec4(textureCube(radialDepth,direction).a);
}`;

export class ObjectiveReflections {
 constructor(renderer,scene,{studio,resolution=256,parallax=false,correctAxes=true,minUpdateIntervalMs=40,maxProbesPerUpdate=1}={}){
  this.renderer=renderer;this.scene=scene;this.studio=studio;this.resolution=resolution;this.parallax=parallax;this.correctAxes=correctAxes;this.minUpdateIntervalMs=minUpdateIntervalMs;this.maxProbesPerUpdate=maxProbesPerUpdate;
  this.enabled=true;this.ready=false;this.failed=false;this.updateCount=0;this.captureCount=0;this.lastUpdateMs=0;this.lastCaptureMs=0;this.records=[];this.probes=[];this.captureMaterials=new Map();this.captureVersions=new WeakMap();this.receiverMaterials=[];
  this.readyUniform={value:false};this.enabledUniform={value:true};this.atlasUniform={value:null};this.generator=new THREE.PMREMGenerator(renderer);
  this.captureUniforms={labCaptureOrigin:{value:new THREE.Vector3()},labCaptureSeat:{value:new THREE.Vector3()},labCaptureAxis:{value:new THREE.Vector3()},labCaptureLength:{value:0},labCaptureRadius:{value:.015}};
  this.revision=0;this.pendingPreparation=0;this.deferredResources=[];this.disposed=false;this.dirty=true;this.nextProbe=0;this.signature=[];this.lastChange=0;this.lastCaptureAt=-Infinity;
  this.quadMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{radiance:{value:null},radialDepth:{value:null},copyDepth:{value:false},faceResolution:{value:resolution}},vertexShader:quadVertex,fragmentShader:copyFragment});
  this.quadScene=new THREE.Scene();this.quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.quadMaterial);this.quad.frustumCulled=false;this.quadScene.add(this.quad);this.quadCamera=new THREE.Camera();
  this.sky=new THREE.Mesh(new THREE.SphereGeometry(15,24,16),new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,toneMapped:false,uniforms:{map:{value:null},strength:{value:1},rotation:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(2*Math.PI/3))}},vertexShader:'varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'uniform highp sampler2D map;uniform float strength;uniform mat3 rotation;varying vec3 direction;void main(){vec3 d=normalize(rotation*direction);vec2 uv=vec2(atan(d.z,d.x)*.15915494309189535+.5,asin(clamp(d.y,-1.0,1.0))*.3183098861837907+.5);gl_FragColor=vec4(texture2D(map,uv).rgb*strength,-1.0);}'}));
  this.sky.userData.rasterOnly=true;
 }
 get enabled(){return this._enabled;}
 set enabled(value){this._enabled=!!value;if(this.enabledUniform)this.enabledUniform.value=this._enabled;}
 get needsFrame(){return this.enabled&&!this.failed&&!this.disposed&&this.probes.length>0&&(this.pendingPreparation>0||this.dirty);}
 get stats(){return {pending:this.needsFrame,enabled:this.enabled,ready:this.ready,failed:this.failed,preparing:this.pendingPreparation>0,dirty:this.dirty,nextProbe:this.nextProbe,updateCount:this.updateCount,captureCount:this.captureCount,lastUpdateMs:this.lastUpdateMs,lastCaptureMs:this.lastCaptureMs,additionalSamplers:1,probes:this.probes.map(p=>({index:p.index,center:p.center.toArray(),radius:p.radius,length:p.length,dirty:p.dirty,captured:p.captured,captureCount:p.captureCount})),resolution:this.resolution,parallax:this.parallax,correctAxes:this.correctAxes};}
 attach(model,{asset,sites}={}){
  this.disposeModel();this.model=model;this.asset=asset;
  const descriptor=DESCRIPTORS[asset];if(!descriptor||!sites)return;
  const assembly=model.getObjectByName(descriptor.assembly);if(!assembly)return;
  model.updateMatrixWorld(true);this.assembly=assembly;
  const convert=p=>new THREE.Vector3(p[0],p[2],-p[1]);
  for(let i=0;i<8;i++){
   const a=sites[descriptor.prefix+'seat_'+i],b=sites[descriptor.prefix+'tip_'+i];if(!a||!b)continue;
   const seat=convert(a),tip=convert(b),length=seat.distanceTo(tip);if(length<.02)continue;
   this.probes.push({index:i,seatLocal:assembly.worldToLocal(seat.clone()),tipLocal:assembly.worldToLocal(tip.clone()),seat,tip,center:seat.clone().lerp(tip,.5),axis:new THREE.Vector3(),length,radius:descriptor.radius,capturedCenter:seat.clone().lerp(tip,.5),dirty:true,captured:false,captureCount:0});
  }
  if(!this.probes.length)return;
  if(!this.renderer.capabilities.isWebGL2||this.renderer.capabilities.maxTextures<16){this.failed=true;return;}
  const n=this.resolution;
  this.atlas=new THREE.WebGLArrayRenderTarget(3*Math.max(n,112),4*n,(this.parallax?2:1)*this.probes.length,{depthBuffer:false,stencilBuffer:false});
  Object.assign(this.atlas.texture,{type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false});
  this.atlasUniform.value=this.atlas.texture;
  this.cube=new THREE.WebGLCubeRenderTarget(n,{type:THREE.HalfFloatType,generateMipmaps:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  this.camera=new THREE.CubeCamera(.0002,20,this.cube);this.camera.userData.rasterOnly=true;
  this.updateProbeTransforms();
  const copies=new Map();
  assembly.traverse(object=>{if(!object.isMesh)return;const original=object.material;
   const materials=[].concat(original).map(source=>{
    // Receiver eligibility is spatially restricted to the real barrel below.
    // Dielectric sleeves need their physical specular response as well.
    if(!source.isMeshStandardMaterial||(source.transmission||0)>.1||(source.transparent&&source.opacity<.98))return source;
    if(!copies.has(source)){const material=source.clone();material.onBeforeCompile=source.onBeforeCompile;material.customProgramCacheKey=source.customProgramCacheKey;this.installReceiver(material);copies.set(source,material);}return copies.get(source);
   });
   if(materials.some((m,i)=>m!==[].concat(original)[i])){this.records.push({object,original});object.material=Array.isArray(original)?materials:materials[0];}
  });
  this.receiverMaterials=[...copies.values()];this.invalidate();
 }
 installReceiver(material){
  const before=material.onBeforeCompile,key=material.customProgramCacheKey(),count=this.probes.length,n=this.resolution;
  material.customProgramCacheKey=()=>key+'|objective-local-array-v2-'+count+'-'+n+'-'+this.parallax+'-'+this.correctAxes;
  material.onBeforeCompile=(shader,renderer)=>{
   before.call(material,shader,renderer);
   Object.assign(shader.uniforms,{labObjectiveReady:this.readyUniform,labObjectiveEnabled:this.enabledUniform,labObjectiveAtlas:this.atlasUniform});
   this.probes.forEach((p,i)=>Object.assign(shader.uniforms,{['labObjectiveCenter'+i]:{value:p.capturedCenter},['labObjectiveSeat'+i]:{value:p.seat},['labObjectiveAxis'+i]:{value:p.axis},['labObjectiveShape'+i]:{value:new THREE.Vector2(p.radius,p.length)}}));
   shader.vertexShader='varying vec3 vLabObjectiveWorld;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvLabObjectiveWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
   let environment=THREE.ShaderChunk.envmap_physical_pars_fragment;if(this.correctAxes)environment=correctEnvironmentAxes(environment);
   const declarations=this.probes.map((p,i)=>`uniform vec3 labObjectiveCenter${i},labObjectiveSeat${i},labObjectiveAxis${i};uniform vec2 labObjectiveShape${i};`).join('\n');
   const selection=this.probes.map((p,i)=>`{
    vec3 relative=vLabObjectiveWorld-labObjectiveSeat${i};float axial=dot(relative,labObjectiveAxis${i});
    float distance=length(relative-labObjectiveAxis${i}*clamp(axial,0.0,labObjectiveShape${i}.y));
    if(axial>-.003&&axial<labObjectiveShape${i}.y+.003&&distance<labObjectiveShape${i}.x*1.6&&distance<nearest){nearest=distance;index=${i};center=labObjectiveCenter${i};}
   }`).join('\n');
   const helper=`uniform bool labObjectiveReady,labObjectiveEnabled;uniform highp sampler2DArray labObjectiveAtlas;varying vec3 vLabObjectiveWorld;
   ${declarations}
   #ifdef ENVMAP_TYPE_CUBE_UV
   vec3 labObjectiveBilinear(vec3 direction,float mipInt,int index){
    float face=getFace(direction);float filterInt=max(4.0-mipInt,0.0);mipInt=max(mipInt,4.0);float faceSize=exp2(mipInt);
    vec2 uv=getUV(direction,face)*(faceSize-2.0)+1.0;
    if(face>2.0){uv.y+=faceSize;face-=3.0;}uv.x+=face*faceSize+filterInt*48.0;uv.y+=4.0*(${n.toFixed(1)}-faceSize);
    uv/=vec2(${(3*Math.max(n,112)).toFixed(1)},${(4*n).toFixed(1)});
    return texture(labObjectiveAtlas,vec3(uv,float(index))).rgb;
   }
   vec3 labObjectiveFiltered(vec3 direction,float roughness,int index){
    float mip=clamp(roughnessToMip(roughness),-2.0,${Math.log2(n).toFixed(1)});float mipInt=floor(mip);
    vec3 first=labObjectiveBilinear(direction,mipInt,index);if(fract(mip)==0.0)return first;
    return mix(first,labObjectiveBilinear(direction,mipInt+1.0,index),fract(mip));
   }
   float labObjectiveDistance(vec3 direction,int index){
    float face=getFace(direction);vec2 uv=clamp(getUV(direction,face),vec2(.5/${n.toFixed(1)}),vec2(1.0-.5/${n.toFixed(1)}));
    ivec2 pixel=ivec2(uv*${n.toFixed(1)})+ivec2(int(face)%3,int(face)/3)*${n};
    return texelFetch(labObjectiveAtlas,ivec3(pixel,index+${count}),0).r;
   }
   vec3 labObjectiveRadiance(vec3 ray,float roughness,vec3 fallback){
    if(!labObjectiveReady||!labObjectiveEnabled)return fallback;
    int index=-1;float nearest=1e10;vec3 center=vec3(0.0);${selection}
    if(index<0)return fallback;
    vec3 direction=ray;
    ${this.parallax?`vec3 offset=vLabObjectiveWorld-center;
    for(int step=0;step<3;step++){
     float distance=labObjectiveDistance(normalize(direction),index);if(distance<=0.0)break;
     vec3 hit=normalize(direction)*distance;float travel=dot(hit-offset,ray);if(travel<=0.0)break;direction=offset+ray*travel;
    }`:''}
    return labObjectiveFiltered(normalize(direction),roughness,index);
   }
   #endif\n`;
   environment=environment.replace('return envMapColor.rgb * envMapIntensity;','return labObjectiveRadiance(reflectVec,roughness,envMapColor.rgb) * envMapIntensity;');
   shader.fragmentShader=shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>',helper+environment);
  };
  material.needsUpdate=true;
 }
 captureMaterial(source){
  if(this.captureMaterials.has(source)){
   const material=this.captureMaterials.get(source),before=material.onBeforeCompile,key=material.customProgramCacheKey;
   material.copy(source);material.onBeforeCompile=before;material.customProgramCacheKey=key;material.transparent=false;
   if(this.captureVersions.get(source)!==source.version){material.needsUpdate=true;this.captureVersions.set(source,source.version);}
   return material;
  }
  const material=source.clone();material.onBeforeCompile=()=>{};material.customProgramCacheKey=()=>'';material.transparent=false;
  this.studio.areaShadows.applyMaterial(material);
  const before=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.customProgramCacheKey=()=>key+'|objective-radiance-depth-capture';
  material.onBeforeCompile=(shader,renderer)=>{
   before.call(material,shader,renderer);Object.assign(shader.uniforms,this.captureUniforms);
   shader.vertexShader='varying vec3 vLabCaptureWorld;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvLabCaptureWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
   shader.fragmentShader='varying vec3 vLabCaptureWorld;uniform vec3 labCaptureOrigin,labCaptureSeat,labCaptureAxis;uniform float labCaptureLength,labCaptureRadius;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
    vec3 relative=vLabCaptureWorld-labCaptureSeat;float axial=dot(relative,labCaptureAxis);
    if(axial>-.0002&&axial<labCaptureLength+.0002&&length(relative-labCaptureAxis*axial)<labCaptureRadius)discard;`);
   shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>','#include <dithering_fragment>\ngl_FragColor.a=length(vLabCaptureWorld-labCaptureOrigin);');
   if(this.correctAxes)shader.fragmentShader=shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>',correctEnvironmentAxes(THREE.ShaderChunk.envmap_physical_pars_fragment));
  };
  this.captureMaterials.set(source,material);this.captureVersions.set(source,source.version);return material;
 }
 updateProbeTransforms(){
  this.assembly.updateMatrixWorld(true);
  for(const p of this.probes){p.seat.copy(p.seatLocal).applyMatrix4(this.assembly.matrixWorld);p.tip.copy(p.tipLocal).applyMatrix4(this.assembly.matrixWorld);p.center.copy(p.seat).lerp(p.tip,.5);p.axis.subVectors(p.tip,p.seat).normalize();}
 }
 poseChanged(){
  this.scene.updateMatrixWorld(true);const signature=[];
  this.scene.traverse(o=>{if(o.userData.rasterOnly||o.userData.physicsOverlay||(!o.isMesh&&!o.isLight))return;
   if(o.isMesh&&excludedFromCapture(o,[].concat(o.material)))return;
   signature.push(o.id,o.visible?1:0,...o.matrixWorld.elements);
   if(o.isLight)signature.push(o.intensity,o.color.r,o.color.g,o.color.b,o.width||0,o.height||0);
   if(o.isMesh){
    signature.push(o.geometry.id,o.geometry.index?.version||0,...Object.values(o.geometry.attributes).map(a=>a.version||a.data?.version||0),o.instanceMatrix?.version||0,...(o.morphTargetInfluences||[]));
    for(const material of [].concat(o.material))materialSignature(material,signature);
   }
  });
  signature.push(this.studio.pathEnvironment?.id||0,this.studio.pathEnvironment?.version||0,this.studio.pathEnvironmentIntensity||0);
  const previous=this.signature,changed=signature.length!==previous.length||signature.some((v,i)=>typeof v==='number'&&typeof previous[i]==='number'?Math.abs(v-previous[i])>1e-6:v!==previous[i]);
  if(changed)this.signature=signature;return changed;
 }
 invalidate(){this.dirty=true;for(const p of this.probes)p.dirty=true;this.lastChange=performance.now();}
 withCaptureState(callback){
  const r=this.renderer,s=this.scene,materialRecords=[],hidden=[];
  const state={target:r.getRenderTarget(),face:r.getActiveCubeFace(),mip:r.getActiveMipmapLevel(),tone:r.toneMapping,autoClear:r.autoClear,background:s.background,override:s.overrideMaterial,resolved:this.studio.areaShadows.resolved.value,viewport:r.getViewport(new THREE.Vector4()),scissor:r.getScissor(new THREE.Vector4()),scissorTest:r.getScissorTest()};
  try{
   s.traverse(o=>{if(!o.isMesh)return;const materials=[].concat(o.material);
    if(o.visible&&excludedFromCapture(o,materials)){hidden.push(o);o.visible=false;return;}
    if(materials.every(m=>m.isMeshStandardMaterial)){materialRecords.push([o,o.material]);const copies=materials.map(m=>this.captureMaterial(m));o.material=Array.isArray(o.material)?copies:copies[0];}
   });
   this.sky.material.uniforms.map.value=this.studio.pathEnvironment;this.sky.material.uniforms.strength.value=this.studio.pathEnvironmentIntensity;
   s.add(this.sky);s.background=null;s.overrideMaterial=null;r.toneMapping=THREE.NoToneMapping;r.autoClear=true;this.studio.areaShadows.resolved.value=false;
   return callback();
  }finally{
   for(const[o,m]of materialRecords)o.material=m;for(const o of hidden)o.visible=true;s.remove(this.sky);
   s.background=state.background;s.overrideMaterial=state.override;r.toneMapping=state.tone;r.autoClear=state.autoClear;this.studio.areaShadows.resolved.value=state.resolved;
   r.setRenderTarget(state.target,state.face,state.mip);r.setViewport(state.viewport);r.setScissor(state.scissor);r.setScissorTest(state.scissorTest);
  }
 }
 async prepareAsync(){
  if(this.disposed||this.failed||!this.probes.length)return false;
  const revision=this.revision;this.pendingPreparation++;
  try{
   const completion=this.withCaptureState(()=>{
    this.camera.position.copy(this.probes[0].center);this.camera.updateMatrixWorld(true);this.renderer.setRenderTarget(this.cube);
    return this.renderer.compileAsync(this.scene,this.camera.children[0]);
   });
   await completion;return revision===this.revision&&!this.disposed;
  }finally{this.pendingPreparation--;this.releaseDeferred();}
 }
 captureProbe(index){
  const p=this.probes[index],r=this.renderer;
  this.sky.position.copy(p.center);this.camera.position.copy(p.center);this.captureUniforms.labCaptureOrigin.value.copy(p.center);this.captureUniforms.labCaptureSeat.value.copy(p.seat);this.captureUniforms.labCaptureAxis.value.copy(p.axis);this.captureUniforms.labCaptureLength.value=p.length;this.captureUniforms.labCaptureRadius.value=p.radius;
  this.camera.update(r,this.scene);this.pmrem=this.generator.fromCubemap(this.cube.texture,this.pmrem||undefined);
  if(this.pmrem.width!==this.atlas.width||this.pmrem.height!==this.atlas.height)throw Error('Unexpected objective PMREM layout');
  this.quadMaterial.uniforms.radiance.value=this.pmrem.texture;this.quadMaterial.uniforms.radialDepth.value=this.cube.texture;
  this.quadMaterial.uniforms.copyDepth.value=false;r.setRenderTarget(this.atlas,index);r.render(this.quadScene,this.quadCamera);
  if(this.parallax){this.quadMaterial.uniforms.copyDepth.value=true;r.setRenderTarget(this.atlas,index+this.probes.length);r.render(this.quadScene,this.quadCamera);}this.captureCount++;p.captureCount++;p.captured=true;p.dirty=false;p.capturedCenter.copy(p.center);
 }
 update(force=false){
  if(!this.enabled||this.failed||this.disposed||this.pendingPreparation||!this.assembly||!this.probes.length)return false;
  if(this.poseChanged()){this.invalidate();this.updateProbeTransforms();}
  if(!force&&(!this.dirty||performance.now()-this.lastCaptureAt<this.minUpdateIntervalMs))return false;
  const start=performance.now();
  try{
   if(force){this.invalidate();this.updateProbeTransforms();this.nextProbe=0;}
   this.withCaptureState(()=>{
    const budget=force?this.probes.length:this.maxProbesPerUpdate;let captured=0,visited=0;
    while(captured<budget&&visited<this.probes.length){
     const index=this.nextProbe;this.nextProbe=(this.nextProbe+1)%this.probes.length;visited++;
     if(this.probes[index].dirty){this.captureProbe(index);captured++;}
    }
   });
   this.ready=this.probes.every(p=>p.captured);this.readyUniform.value=this.ready;this.dirty=this.probes.some(p=>p.dirty);this.updateCount++;
  }catch(error){this.failed=true;this.ready=false;this.readyUniform.value=false;throw error;}
  finally{this.lastUpdateMs=performance.now()-start;this.lastCaptureMs=this.lastUpdateMs;this.lastCaptureAt=performance.now();}
  return true;
 }
 release(resources){if(this.pendingPreparation)this.deferredResources.push(...resources.filter(Boolean));else for(const resource of resources)resource?.dispose();}
 releaseDeferred(){if(!this.pendingPreparation){for(const resource of this.deferredResources)resource.dispose();this.deferredResources=[];}}
 disposeModel(){
  this.revision++;this.ready=false;this.readyUniform.value=false;this.failed=false;
  for(const{object,original}of this.records)object.material=original;
  this.release([...this.receiverMaterials,...this.captureMaterials.values(),this.cube,this.pmrem,this.atlas]);this.captureMaterials.clear();
  this.records=[];this.probes=[];this.receiverMaterials=[];this.assembly=null;this.model=null;this.cube=null;this.pmrem=null;this.atlas=null;this.atlasUniform.value=null;this.signature=[];this.dirty=true;this.nextProbe=0;this.lastCaptureAt=-Infinity;
 }
 dispose(){if(this.disposed)return;this.disposeModel();this.disposed=true;this.release([this.generator,this.quad.geometry,this.quadMaterial,this.sky.geometry,this.sky.material]);}
}
