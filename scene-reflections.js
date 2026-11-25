import * as THREE from 'three';
import {PlanarReflections} from './planar-reflections.js';
import {ObjectiveReflections} from './objective-reflections.js';

// Scene reflections are independent of MuJoCo and the paused path tracer.
// Reflection captures use the current rendered instrument transforms. The
// original source PBR values and physical state are never modified here.
export class SceneReflections {
 constructor(renderer,scene,{studio,ground=studio.ground,onInvalidate=()=>{}}={}) {
  this.renderer=renderer;this.scene=scene;this.studio=studio;
  this.onInvalidate=onInvalidate;this.revision=0;this.preparing=null;
  this.enabled=true;this.failed=false;this.lastError=null;this.model=null;
  this.generation=0;this.lastPose=-1;this.lastEnvironment=null;this.lastCamera=null;this.lastCurvedPose=-1;this.lastCurvedEnvironment=null;
  try {
   this.planar=new PlanarReflections(renderer,scene,{areaShadows:studio.areaShadows,resolution:768});
   this.planar.addReceiver({object:ground,normal:new THREE.Vector3(0,0,1),persistent:true,label:'Laboratory bench'});
   this.curved=new ObjectiveReflections(renderer,scene,{studio,resolution:256,parallax:false,correctAxes:true});
  } catch(error) {this.curved?.dispose();this.planar?.dispose();throw error;}
 }
 get needsFrame(){return !!this.model&&this.enabled&&!this.failed&&!this.preparing&&this.curved.needsFrame;}
 get stats() {
  const planar=this.planar.stats,curved=this.curved.stats;
  return {enabled:this.enabled,ready:this.enabled&&!this.failed&&(planar.ready&&!planar.failed||curved.ready&&!curved.failed),failed:this.failed,lastError:this.lastError,generation:this.generation,asset:this.asset,planar,curved};
 }
 attach(model,{asset,sites}={}) {
  this.disposeModel();if(this.failed||!this.enabled)return;
  this.model=model;this.asset=asset;this.pendingSites=!sites;
  this.planar.extent=this.studio.extent;
  // Objective materials are cloned per assembly before planar receiver
  // selection, so the two local-reflection hooks do not share a material.
  this.curved.attach(model,{asset,sites});
  this.planar.attach(model,{maxPlanes:2});
  const revision=this.revision;
  this.preparing=this.curved.prepareAsync().then(()=>{
   if(revision!==this.revision)return;
   this.preparing=null;this.onInvalidate();
  }).catch(error=>{
   if(revision!==this.revision)return;
   this.preparing=null;this.curved.failed=true;this.curved.enabled=false;
   console.warn('Objective reflections unavailable; keeping room reflections.',error);this.onInvalidate();
  });
  this.lastPose=-1;this.lastCamera=null;this.lastEnvironment=null;this.lastCurvedPose=-1;this.lastCurvedEnvironment=null;this.generation++;
 }
 update(camera,{poseVersion=0,sites=null,force=false,photo=false}={}) {
  if(!this.model||!this.enabled||this.failed)return false;
  if(this.pendingSites&&sites)try{this.attach(this.model,{asset:this.asset,sites});}
  catch(error){this.disableAfterGraphicsError();console.warn('Scene reflections unavailable; keeping room reflections.',error);return false;}
  const environment=this.scene.environment;
  const poseChanged=force||poseVersion!==this.lastPose||environment!==this.lastEnvironment;
  const curvedChanged=force||poseVersion!==this.lastCurvedPose||environment!==this.lastCurvedEnvironment;
  camera.updateMatrixWorld();
  const values=[...camera.matrixWorld.elements,...camera.projectionMatrix.elements];
  const cameraChanged=!this.lastCamera||values.some((v,i)=>Math.abs(v-this.lastCamera[i])>1e-10);
  if(!poseChanged&&!cameraChanged&&(photo||!curvedChanged&&!this.curved.needsFrame))return false;
  let changed=false;
  // Curved probes are independent of the viewer camera and only need new
  // radiance when geometry or illumination moves. Planar capture cameras
  // follow the viewer because their perspective is an exact mirror image.
  if(!photo&&!this.preparing&&(curvedChanged||this.curved.needsFrame)&&!this.curved.failed) {
   try {
    changed=this.curved.update(force)||changed;
    if(!this.curved.needsFrame){this.lastCurvedPose=poseVersion;this.lastCurvedEnvironment=environment;}
   }
   catch(error) {this.curved.failed=true;this.curved.enabled=false;console.warn('Objective reflections unavailable; keeping room reflections.',error);}
  }
  if((poseChanged||cameraChanged)&&!this.planar.failed) {
   try {this.planar.update(this.model,camera);changed=true;}
   catch(error) {this.planar.failed=true;this.planar.enabled=false;console.warn('Table reflections unavailable; keeping room reflections.',error);}
  }
  this.lastPose=poseVersion;this.lastEnvironment=environment;this.lastCamera=values;
  if(changed)this.generation++;
  return changed;
 }
 disableAfterGraphicsError() {
  this.failed=true;this.lastError='The graphics driver rejected scene reflections';
  this.disposeModel();this.planar.enabled=false;this.curved.enabled=false;
  for(const entry of this.planar.receivers)entry.uniforms.labPlanarEnabled.value=0;
 }
 disposeModel() {
  this.revision++;this.preparing=null;
  // Restore planar callbacks before restoring the objective source material
  // identities. Neither module owns source textures or geometry.
  this.planar.disposeModel();this.curved.disposeModel();
  for(const entry of this.planar.receivers)entry.uniforms.labPlanarEnabled.value=0;
  this.model=null;this.asset=null;this.pendingSites=false;this.lastCamera=null;this.lastPose=-1;
 }
 dispose() {this.disposeModel();this.planar.dispose();this.curved.dispose();this.enabled=false;}
}
