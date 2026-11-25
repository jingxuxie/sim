import * as THREE from 'three';
import {SSAOPass} from './vendor/three/SSAOPass.js';
import {ReflectionGBuffer} from './screen-reflections.js?v=lighting2';

// Screen-space visibility belongs to indirect lighting. Multiplying the final
// image also dirties direct highlights and can turn polished edges grey.
export class CavityLighting extends SSAOPass {
 constructor(scene,camera){
  super(scene,camera,512,512,32);this.needsSwap=false;this.materials=new WeakSet();
  this.normalRenderTarget.dispose();this.normalMaterial.dispose();
  this.reflectionBuffer=new ReflectionGBuffer(512,512);
  this.normalRenderTarget=this.reflectionBuffer.target;this.normalMaterial=this.reflectionBuffer.material;
  this.normalTexture=this.normalRenderTarget.texture[0];this.materialTexture=this.normalRenderTarget.texture[1];
  this.facetNormalTexture=this.normalRenderTarget.texture[2];
  this.ssaoMaterial.uniforms.tNormal.value=this.normalTexture;this.ssaoMaterial.uniforms.tDepth.value=this.normalRenderTarget.depthTexture;
  this.depthRenderMaterial.uniforms.tDepth.value=this.normalRenderTarget.depthTexture;
  this.screenSize={value:new THREE.Vector2(512,512)};
  this.ssaoMaterial.fragmentShader=this.ssaoMaterial.fragmentShader.replace('1.0 - occlusion','1.0 - 0.65 * occlusion');
 }
 setSize(width,height){super.setSize(width,height);this.screenSize.value.set(width,height);}
 render(renderer){
  const target=renderer.getRenderTarget(),shadowEnabled=renderer.shadowMap.enabled,override=this.scene.overrideMaterial,hidden=[];let cached=false;
  this.scene.traverse(o=>{if(o.isMesh&&o.visible&&(o.userData.rasterOnly||o.userData.physicsOverlay||[].concat(o.material).some(m=>(m.transmission||0)>.05||(m.transparent&&m.opacity<.98)))){hidden.push(o);o.visible=false;}});
  try{
   renderer.shadowMap.enabled=false;this.overrideVisibility();cached=true;
   this.renderOverride(renderer,this.normalMaterial,this.normalRenderTarget,0x7777ff,1);
   this.restoreVisibility();cached=false;
   const u=this.ssaoMaterial.uniforms;u.kernelRadius.value=this.kernelRadius;u.minDistance.value=this.minDistance;u.maxDistance.value=this.maxDistance;
   this.renderPass(renderer,this.ssaoMaterial,this.ssaoRenderTarget);
   this.renderPass(renderer,this.blurMaterial,this.blurRenderTarget);
  }finally{
   if(cached)this.restoreVisibility();for(const o of hidden)o.visible=true;
   this.scene.overrideMaterial=override;renderer.shadowMap.enabled=shadowEnabled;renderer.setRenderTarget(target);
  }
 }
 dispose(){super.dispose();this.reflectionBuffer.white.dispose();}
 apply(root){root.traverse(o=>{if(o.isMesh)for(const m of [].concat(o.material))this.applyMaterial(m);});}
 applyMaterial(material){
  if(!material?.isMeshStandardMaterial||this.materials.has(material))return;
  this.materials.add(material);const previous=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.customProgramCacheKey=()=>key+'|lab-indirect-cavities-v1';
  material.onBeforeCompile=(shader,renderer)=>{
   previous.call(material,shader,renderer);
   shader.uniforms.labCavityMap={value:this.blurRenderTarget.texture};shader.uniforms.labCavitySize=this.screenSize;
   shader.fragmentShader='uniform sampler2D labCavityMap;\nuniform vec2 labCavitySize;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <aomap_fragment>',`#include <aomap_fragment>
    float labCavity=texture2D(labCavityMap,gl_FragCoord.xy/labCavitySize).r;
    reflectedLight.indirectDiffuse *= labCavity;
    #if defined(USE_ENVMAP) && defined(STANDARD)
     float labSpecularVisibility=computeSpecularOcclusion(saturate(dot(geometryNormal,geometryViewDir)),labCavity,material.roughness);
     reflectedLight.indirectSpecular *= labSpecularVisibility;
     #ifdef USE_CLEARCOAT
      clearcoatSpecularIndirect *= labCavity;
     #endif
     #ifdef USE_SHEEN
      sheenSpecularIndirect *= labCavity;
     #endif
    #endif`);
  };material.needsUpdate=true;
 }
}
