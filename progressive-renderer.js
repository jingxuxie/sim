import * as THREE from 'three';
import {WebGLPathTracer,DenoiseMaterial} from './vendor/pathtracer/pathtracer.module.js';
import {MeshBVH} from './vendor/pathtracer/bvh.module.js';
import {FullScreenQuad} from './vendor/three/Pass.js';

// This module is loaded only after the user requests Photo quality. MuJoCo and
// the ordinary live renderer remain independent of the progressive renderer.
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const aborted=()=>new DOMException('Photo preparation cancelled','AbortError');
const textureKeys=['map','normalMap','roughnessMap','metalnessMap','emissiveMap','transmissionMap','thicknessMap','clearcoatMap','clearcoatNormalMap','clearcoatRoughnessMap','alphaMap'];

class BVHWorker {
 constructor(){this.worker=new Worker(new URL('./vendor/pathtracer/bvh.worker.js',import.meta.url),{type:'module'});this.pending=null;}
 generate(geometry,options={}){
  if(!this.worker)return Promise.reject(aborted());
  if(this.pending)return Promise.reject(Error('A photo acceleration build is already running'));
  return new Promise((resolve,reject)=>{
   this.pending={reject};
   const finish=(error,result)=>{this.pending=null;this.worker&&(this.worker.onmessage=null);error?reject(error):resolve(result);};
   this.worker.onerror=e=>finish(Error('Photo worker: '+(e.message||'could not load')));
   this.worker.onmessage=({data})=>{
    if(data.error){finish(Error(data.error.message||String(data.error)));return;}
    options.onProgress?.(data.progress);
    if(!data.serialized)return;
    try{
     geometry.attributes.position.array=data.position;
     if(data.serialized.index){
      if(geometry.index)geometry.index.array=data.serialized.index;
      else geometry.setIndex(new THREE.BufferAttribute(data.serialized.index,1));
     }
     const bvh=MeshBVH.deserialize(data.serialized,geometry,{setIndex:false});
     geometry.boundingBox=bvh.getBoundingBox(new THREE.Box3());finish(null,bvh);
    }catch(error){finish(error);}
   };
   const position=geometry.attributes.position.array,index=geometry.index?.array||null;
   const buffers=[position.buffer,...(index?[index.buffer]:[])];
   // These arrays belong to the path tracer's merged copy, never the live GLB.
   this.worker.postMessage({position,index,options:{...options,onProgress:null,includedProgressCallback:true,groups:geometry.groups.map(x=>({...x}))}},buffers);
  });
 }
 dispose(){this.worker?.terminate();this.worker=null;this.pending?.reject(aborted());this.pending=null;}
}

function excluded(object){
 for(let node=object;node;node=node.parent)if(!node.visible||node.userData?.physicsOverlay||node.userData?.rasterOnly)return true;
 return false;
}

// Pathtracer 0.0.23 has a misspelled public dispose() and omits owned helper
// targets. Dispose only its private allocations, never imported source assets.
function disposeTracer(tracer){
 if(!tracer)return;
 const materials=new Set();
 for(const pass of [tracer._pathTracer,tracer._lowResPathTracer]){
  if(!pass)continue;
  materials.add(pass.material);materials.add(pass._blendQuad?.material);pass.dispose();
 }
 for(const material of materials){
  if(!material)continue;
  for(const key of ['bvh','attributesArray','materialIndexAttribute','materials','envMapInfo','stratifiedTexture','stratifiedOffsetTexture'])material[key]?.dispose?.();
  material.lights?.tex?.dispose();
  for(const key of ['textures','iesProfiles']){
   const texture=material[key];if(texture?.disposeTarget)texture.disposeTarget();else texture?.dispose();
  }
  material.dispose();
 }
 tracer._quad?.dispose();tracer._quad?.material.dispose();
 tracer._internalBackground?.dispose();tracer._colorBackground?.dispose();
 const generator=tracer._generator;
 generator?.geometry?.dispose();
 for(const geometry of generator?.staticGeometryGenerator?._intermediateGeometry?.values()||[])geometry.dispose();
 const dummy=generator?.staticGeometryGenerator?._dummyMesh;dummy?.geometry.dispose();dummy?.material.dispose();
}

export class ProgressiveRenderer {
 constructor(renderer,{onStatus=()=>{},maxPixels=1500000,maxSamples=512,tiles=4,textureSize=1024,bounces=5,prepareTimeout=60000,denoise=true,photographicContrast=1.28}={}){
  if(!renderer.capabilities.isWebGL2||!renderer.extensions.get('EXT_color_buffer_float'))throw Error('Photo quality needs WebGL 2 floating-point render targets');
  this.renderer=renderer;this.onStatus=onStatus;this.maxPixels=maxPixels;this.maxSamples=maxSamples;this.tileCount=tiles;this.textureSize=textureSize;this.bounces=bounces;this.prepareTimeout=prepareTimeout;
  this.denoiseEnabled=denoise;this.photographicContrast=photographicContrast;this.denoiseQuad=null;this.denoiseTarget=null;
  this.tracer=null;this.worker=null;this.ready=false;this.preparing=false;this.disposed=false;this._ownedGeometry=[];this._stats={worker:true,meshes:0,triangles:0,uvRemaps:0,mixedUVMaterials:0,prepareMs:0,width:0,height:0};
 }
 get samples(){return this.tracer?.samples||0;}
 get compiling(){return !!this.tracer?.isCompiling;}
 get stats(){return {...this._stats,samples:this.samples,maxSamples:this.maxSamples,ready:this.ready,preparing:this.preparing,compiling:this.compiling,denoised:this.denoiseEnabled&&this.samples>=8,photographicContrast:this.photographicContrast};}
 async prepare(source,camera,{environment=null,environmentIntensity=1,environmentRotation=new THREE.Euler(),signal}={}){
  if(this.disposed||signal?.aborted)throw aborted();
  if(this.preparing)throw Error('Photo preparation is already running');
  this.preparing=true;this.ready=false;const started=performance.now();
  const cancel=()=>{this.worker?.dispose();};
  let timeout=false;
  const timer=setTimeout(()=>{timeout=true;cancel();},this.prepareTimeout);signal?.addEventListener('abort',cancel,{once:true});
  const check=()=>{if(this.disposed||signal?.aborted)throw aborted();if(timeout)throw Error('Photo preparation took too long; use Live view on this device');};
  try{
   this.onStatus('Preparing photo quality…');await tick();check();
   this.worker?.dispose();disposeTracer(this.tracer);this.tracer=null;
   for(const geometry of this._ownedGeometry)geometry.dispose();this._ownedGeometry=[];
   source.updateMatrixWorld(true);camera.updateMatrixWorld(true);
   const scene=new THREE.Scene();scene.background=source.background?.isColor?source.background.clone():new THREE.Color(.18,.18,.18);scene.backgroundRotation=new THREE.Euler();scene.environment=environment;scene.environmentIntensity=environmentIntensity;scene.environmentRotation=environmentRotation.clone();
   const objects=[];source.traverse(o=>{if(!excluded(o)&&(o.isMesh||o.isRectAreaLight||o.isDirectionalLight||o.isSpotLight||o.isPointLight))objects.push(o);});
   const stats={worker:true,meshes:0,triangles:0,uvRemaps:0,mixedUVMaterials:0,prepareMs:0,width:0,height:0};
   for(let i=0;i<objects.length;i++){
    check();const original=objects[i];let clone;
    if(original.isMesh){
     const materials=[].concat(original.material);
     if(!original.geometry?.attributes.position||materials.some(m=>m.isShaderMaterial||!m.visible))continue;
     let geometry=original.geometry;
     const channels=new Set();for(const material of materials)for(const key of textureKeys)if(material[key])channels.add(material[key].channel||0);
     if(channels.size===1&&![...channels].includes(0)){
      const channel=[...channels][0],attribute=geometry.getAttribute('uv'+channel);
      if(attribute){
       const remapped=new THREE.BufferGeometry();remapped.index=geometry.index;
       for(const [name,value] of Object.entries(geometry.attributes))if(name!=='tangent')remapped.setAttribute(name,value);
       remapped.setAttribute('uv',attribute);remapped.groups=geometry.groups.map(group=>({...group}));remapped.drawRange={...geometry.drawRange};
       this._ownedGeometry.push(remapped);geometry=remapped;stats.uvRemaps++;
      }
     }else if(channels.size>1)stats.mixedUVMaterials++;
     clone=new THREE.Mesh(geometry,original.material);stats.meshes++;stats.triangles+=(geometry.index?.count||geometry.attributes.position.count)/3;
    }else{
     clone=original.clone(false);
     if(original.target){clone.target=new THREE.Object3D();clone.target.position.setFromMatrixPosition(original.target.matrixWorld);scene.add(clone.target);}
    }
    clone.name=original.name;clone.matrix.copy(original.matrixWorld);clone.matrix.decompose(clone.position,clone.quaternion,clone.scale);clone.matrixAutoUpdate=false;scene.add(clone);
    if(i%128===127)await tick();
   }
   if(!stats.meshes)throw Error('No visible instrument surfaces are available for Photo quality');
   check();this._stats=stats;this.scene=scene;
   const tracer=this.tracer=new WebGLPathTracer(this.renderer);this.worker=new BVHWorker();tracer.setBVHWorker(this.worker);
   tracer.textureSize.set(this.textureSize,this.textureSize);tracer.bounces=this.bounces;tracer.transmissiveBounces=6;tracer.filterGlossyFactor=.35;tracer.tiles.set(this.tileCount,this.tileCount);tracer.dynamicLowRes=false;tracer.rasterizeScene=false;tracer.renderToCanvas=true;tracer.minSamples=1;tracer.fadeDuration=0;tracer.renderDelay=0;tracer.stableNoise=true;
   // The instruments use metre units; the upstream 100 µm ray bias can erase
   // thin covers and contact details. A 1 µm bias retains these visible parts.
   tracer._pathTracer.material.fragmentShader=tracer._pathTracer.material.fragmentShader.replace('#define RAY_OFFSET 1e-4','#define RAY_OFFSET 1e-6');
   // Match the live view's display look after AgX and before the sRGB transfer.
   // Neither this look nor the optional spatial denoiser changes radiance
   // accumulation, geometry, physical material parameters, or light energy.
   const contrast=Number(this.photographicContrast).toFixed(3);
   const look=color=>`vec3 filmLow=pow(clamp(${color},0.0,1.0),vec3(${contrast}));vec3 filmHigh=pow(clamp(1.0-${color},0.0,1.0),vec3(${contrast}));${color}=filmLow/max(filmLow+filmHigh,vec3(0.00001));`;
   tracer._quad.material.fragmentShader=tracer._quad.material.fragmentShader.replace('return linearToOutputTexel( res );',look('res.rgb')+'return linearToOutputTexel( res );');
   if(!this.denoiseQuad){
    const material=new DenoiseMaterial({sigma:1.2,kSigma:1.667,threshold:.06});
    material.toneMapped=false;
    material.fragmentShader=material.fragmentShader.replace('#include <tonemapping_fragment>','').replace('#include <colorspace_fragment>','');
    this.denoiseQuad=new FullScreenQuad(material);
    this.denoiseTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
   }
   const rawDisplay=tracer.renderToCanvasCallback;
   tracer.renderToCanvasCallback=(target,renderer,quad)=>{
    if(!this.denoiseEnabled||tracer.samples<8){rawDisplay(target,renderer,quad);return;}
    const material=this.denoiseQuad.material;material.map=target.texture;material.threshold=.04+.2/Math.sqrt(tracer.samples);
    // Filter at the radiance texture's resolution, then use the same clamped
    // bilinear display as raw tracing. Direct filter-to-canvas rendering would
    // magnify nearest-neighbour blocks on retina or resolution-capped views.
    this.denoiseTarget.setSize(target.width,target.height);
    const autoClear=renderer.autoClear,oldTarget=renderer.getRenderTarget(),oldMap=quad.material.map;renderer.autoClear=false;
    try{
     renderer.setRenderTarget(this.denoiseTarget);this.denoiseQuad.render(renderer);renderer.setRenderTarget(oldTarget);
     quad.material.map=this.denoiseTarget.texture;rawDisplay(this.denoiseTarget,renderer,quad);
    }finally{renderer.setRenderTarget(oldTarget);quad.material.map=oldMap;renderer.autoClear=autoClear;}
   };
   tracer._generator.bvhOptions={maxLeafTris:4};
   this.resize();this.onStatus('Preparing photo quality…');await tick();check();
   await tracer.setSceneAsync(scene,camera,{onProgress:value=>{if(!this.disposed&&!signal?.aborted)this.onStatus('Preparing photo quality '+Math.round(value*100)+'%…');}});
   check();this.ready=true;this._stats.prepareMs=performance.now()-started;this.onStatus('Refining photo lighting…');return this.stats;
  }catch(error){
   this.ready=false;this.worker?.dispose();this.worker=null;
   disposeTracer(this.tracer);this.tracer=null;
   if(timeout&&!signal?.aborted)throw Error('Photo preparation took too long; use Live view on this device');
   throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.preparing=false;}
 }
 resize(){
  if(!this.tracer)return;
  const size=this.renderer.getDrawingBufferSize(new THREE.Vector2());
  this.tracer.renderScale=Math.min(1,Math.sqrt(this.maxPixels/Math.max(1,size.x*size.y)));
  this._stats.width=Math.max(1,Math.floor(size.x*this.tracer.renderScale));this._stats.height=Math.max(1,Math.floor(size.y*this.tracer.renderScale));
 }
 updateCamera(camera){if(this.ready){this.tracer.setCamera(camera);this.resize();}}
 reset(){this.tracer?.reset();}
 setDenoise(enabled){this.denoiseEnabled=!!enabled;}
 renderSample(){
  if(!this.ready||this.disposed||this.renderer.getContext().isContextLost())return false;
  if(this.samples>=this.maxSamples)return this.present();
  this.resize();this.tracer.renderSample();return true;
 }
 present(){
  if(!this.ready||this.disposed)return false;
  const previous=this.tracer.pausePathTracing;this.tracer.pausePathTracing=true;
  try{this.tracer.renderSample();}finally{this.tracer.pausePathTracing=previous;}
  return true;
 }
 dispose(){
  if(this.disposed)return;this.disposed=true;this.ready=false;this.worker?.dispose();this.worker=null;
  // prepare() owns cleanup while its asynchronous build is being cancelled.
  if(!this.preparing){disposeTracer(this.tracer);this.tracer=null;}
  this.denoiseQuad?.dispose();this.denoiseQuad?.material.dispose();this.denoiseQuad=null;
  this.denoiseTarget?.dispose();this.denoiseTarget=null;
  for(const geometry of this._ownedGeometry)geometry.dispose();this._ownedGeometry=[];this.scene=null;
 }
}
