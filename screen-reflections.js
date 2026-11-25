import * as THREE from 'three';
import {Pass,FullScreenQuad} from './vendor/three/Pass.js';

const vertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
const common=`
 uniform highp sampler2D tDepth,tNormal,tMaterial;
 uniform mat4 cameraProjection,cameraInverseProjection,cameraWorld;
 uniform float extent;
 varying vec2 vUv;
 vec3 positionAt(vec2 uv,float depth){vec4 p=cameraInverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);return p.xyz/p.w;}
 float viewZ(float depth){return -cameraProjection[3][2]/(depth*2.0-1.0+cameraProjection[2][2]);}
 vec3 normalAt(vec2 uv){return normalize(texture2D(tNormal,uv).xyz*2.0-1.0);}
`;

// Additional material data shares the existing cavity normal/depth draw. The
// override reads source reflectance/roughness maps and follows current poses.
// Rays use macro geometry normals: normal-map grain belongs to the visible PBR
// shading, not a single screen ray. Unreliable curved/anisotropic receivers
// retain their full HDR lighting instead of receiving incomplete reflections.
export class ReflectionGBuffer {
 constructor(width=512,height=512){
  this.target=new THREE.WebGLMultipleRenderTargets(width,height,3,{type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});
  // Shadow receiver planes need the actual rasterized facet, not a smooth
  // shading normal or a plane estimated across neighboring triangles. Keep
  // this additional attachment at full precision; existing buffers are intact.
  this.target.texture[2].type=THREE.FloatType;
  this.target.texture[2].name='Rasterized geometric facet normals';
  this.target.depthTexture=new THREE.DepthTexture(width,height,THREE.UnsignedIntType);
  this.white=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);this.white.needsUpdate=true;
  const uniforms=THREE.UniformsUtils.clone(THREE.ShaderLib.normal.uniforms);
  Object.assign(uniforms,{
   labColor:{value:new THREE.Color(1,1,1)},labDielectricF0:{value:new THREE.Color(.04,.04,.04)},labMetalness:{value:0},labRoughness:{value:1},labEnvIntensity:{value:1},labIsotropic:{value:1},labAlphaTest:{value:0},labOpacity:{value:1},
   labHasNormal:{value:0},labHasBump:{value:0},labAOIntensity:{value:0},
   labBaseMap:{value:this.white},labMetalMap:{value:this.white},labRoughMap:{value:this.white},labAOMap:{value:this.white},
   normalMap:{value:this.white},normalScale:{value:new THREE.Vector2(1,1)},bumpMap:{value:this.white},bumpScale:{value:0}
  });
  for(const key of ['Base','Metal','Rough','AO','Normal','Bump']){uniforms['lab'+key+'Transform']={value:new THREE.Matrix3()};uniforms['lab'+key+'Channel']={value:0};}
  const uvDeclarations=['Base','Metal','Rough','AO'].map(key=>`varying vec2 lab${key}UV;`).join('\n');
  const uvUniforms=['Base','Metal','Rough','AO','Normal','Bump'].map(key=>`uniform mat3 lab${key}Transform;uniform float lab${key}Channel;`).join('\n');
  let vs=THREE.ShaderLib.normal.vertexShader;
  vs=uvDeclarations+'\n'+uvUniforms+'\n'+vs;
  vs=vs.replace('#include <uv_vertex>',[
   ...['Base','Metal','Rough','AO'].map(key=>`lab${key}UV=(lab${key}Transform*vec3(mix(uv,uv1,lab${key}Channel),1.0)).xy;`),
   'vNormalMapUv=(labNormalTransform*vec3(mix(uv,uv1,labNormalChannel),1.0)).xy;',
   'vBumpMapUv=(labBumpTransform*vec3(mix(uv,uv1,labBumpChannel),1.0)).xy;'
  ].join('\n'));
  let fs=THREE.ShaderLib.normal.fragmentShader;
  fs=`precision highp sampler2D;
layout(location=1) out vec4 labMaterialOutput;
layout(location=2) out vec4 labFacetNormalOutput;
uniform vec3 labColor,labDielectricF0;
uniform float labMetalness,labRoughness,labEnvIntensity,labIsotropic,labAlphaTest,labOpacity,labHasNormal,labHasBump,labAOIntensity;
uniform sampler2D labBaseMap,labMetalMap,labRoughMap,labAOMap;
${uvDeclarations}\n`+fs;
  fs=fs.replace('#include <normal_fragment_maps>',`if(labHasNormal>.5){
   #include <normal_fragment_maps>
  }else if(labHasBump>.5){normal=perturbNormalArb(-vViewPosition,normal,dHdxy_fwd(),faceDirection);}`);
  fs=fs.replace('gl_FragColor = vec4( packNormalToRGB( normal ), opacity );',`
   vec3 facetNormal=cross(dFdx(vViewPosition),dFdy(vViewPosition));
   facetNormal=dot(facetNormal,facetNormal)>1e-20?normalize(facetNormal):nonPerturbedNormal;
   vec4 base=texture2D(labBaseMap,labBaseUV);
   if(base.a*labOpacity<labAlphaTest)discard;
   float metalness=labMetalness*texture2D(labMetalMap,labMetalUV).b;
   float roughness=max(.0525,labRoughness*texture2D(labRoughMap,labRoughUV).g);
   vec3 derivative=max(abs(dFdx(nonPerturbedNormal)),abs(dFdy(nonPerturbedNormal)));
   roughness=min(1.0,roughness+max(max(derivative.x,derivative.y),derivative.z));
   vec3 f0=mix(labDielectricF0,labColor*base.rgb,metalness);
   float ao=mix(1.0,texture2D(labAOMap,labAOUV).r,labAOIntensity);
   float dotNV=max(0.0,dot(normal,normalize(vViewPosition)));
   float visibility=clamp(pow(dotNV+ao,exp2(-16.0*roughness-1.0))-1.0+ao,0.0,1.0);
   float curvature=max(length(dFdx(nonPerturbedNormal)),length(dFdy(nonPerturbedNormal)));
   float eligibility=labIsotropic*smoothstep(.45,.8,metalness)*(1.0-smoothstep(.002,.012,curvature));
   gl_FragColor=vec4(packNormalToRGB(nonPerturbedNormal),labEnvIntensity*visibility*eligibility);
   labMaterialOutput=vec4(f0,roughness);
   labFacetNormalOutput=vec4(facetNormal,1.0);`);
  // OPAQUE would overwrite the normal target's stored visibility factor.
  fs=fs.replace('#ifdef OPAQUE','\n#if 0');
  this.material=new THREE.ShaderMaterial({uniforms,vertexShader:vs,fragmentShader:fs,defines:{USE_NORMALMAP:'',USE_NORMALMAP_TANGENTSPACE:'',USE_BUMPMAP:'',USE_UV1:'',NORMALMAP_UV:'uv',BUMPMAP_UV:'uv'},side:THREE.DoubleSide,blending:THREE.NoBlending,toneMapped:false});
  this.material.onBeforeRender=(renderer,scene,camera,geometry,object,group)=>{
   const source=Array.isArray(object.material)?object.material[group?.materialIndex||0]:object.material;
   const physical=source?.isMeshStandardMaterial;
   uniforms.labColor.value.copy(source?.color||new THREE.Color(1,1,1));
   const ior=source?.ior??1.5,f0=Math.pow((ior-1)/(ior+1),2)*(source?.specularIntensity??1);
   uniforms.labDielectricF0.value.copy(source?.specularColor||{r:1,g:1,b:1}).multiplyScalar(f0);
   uniforms.labMetalness.value=physical?source.metalness:0;uniforms.labRoughness.value=physical?source.roughness:1;
   uniforms.labEnvIntensity.value=physical&&!source.envMap?(source.envMapIntensity??1):0;
   uniforms.labIsotropic.value=1-THREE.MathUtils.smoothstep(source?.anisotropy||0,.02,.1);
   uniforms.labOpacity.value=source?.opacity??1;uniforms.labAlphaTest.value=Math.max(source?.alphaTest||0,source?.transparent ? .25 : 0);
   uniforms.labHasNormal.value=source?.normalMap?1:0;uniforms.labHasBump.value=source?.bumpMap?1:0;
   uniforms.normalScale.value.copy(source?.normalScale||{x:1,y:1});uniforms.bumpScale.value=source?.bumpScale||0;
   uniforms.labAOIntensity.value=source?.aoMap?(source.aoMapIntensity??1):0;
   for(const [key,property,sampler] of [['Base','map','labBaseMap'],['Metal','metalnessMap','labMetalMap'],['Rough','roughnessMap','labRoughMap'],['AO','aoMap','labAOMap'],['Normal','normalMap','normalMap'],['Bump','bumpMap','bumpMap']]){
    const texture=source?.[property];if(texture?.matrixAutoUpdate)texture.updateMatrix();
    uniforms[sampler].value=texture||this.white;
    if(texture)uniforms['lab'+key+'Transform'].value.copy(texture.matrix);else uniforms['lab'+key+'Transform'].value.identity();
    uniforms['lab'+key+'Channel'].value=texture?.channel===1?1:0;
   }
   this.material.uniformsNeedUpdate=true;
  };
 }
 dispose(){this.target.dispose();this.material.dispose();this.white.dispose();}
}

export class ScreenReflections extends Pass {
 constructor(scene,camera,cavity,{resolutionScale=.5,steps=64}={}){
  super();this.scene=scene;this.camera=camera;this.cavity=cavity;this.resolutionScale=resolutionScale;this.extent=1;this.width=512;this.height=512;
  this.source=new THREE.WebGLRenderTarget(256,256,{type:THREE.HalfFloatType,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:true,depthBuffer:false});
  this.reflection=new THREE.WebGLRenderTarget(256,256,{type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});
  this.copy=new THREE.ShaderMaterial({uniforms:{map:{value:null}},vertexShader:vertex,fragmentShader:'uniform highp sampler2D map;varying vec2 vUv;void main(){gl_FragColor=texture2D(map,vUv);}',depthWrite:false,depthTest:false,toneMapped:false});
  const shared={tDepth:{value:cavity.normalRenderTarget.depthTexture},tNormal:{value:cavity.normalTexture},tMaterial:{value:cavity.materialTexture},cameraProjection:{value:new THREE.Matrix4()},cameraInverseProjection:{value:new THREE.Matrix4()},cameraWorld:{value:new THREE.Matrix4()},extent:{value:1}};
  this.trace=new THREE.ShaderMaterial({defines:{STEPS:Math.max(16,Math.min(96,steps)),ENVMAP_TYPE_CUBE_UV:'',CUBEUV_TEXEL_WIDTH:1/768,CUBEUV_TEXEL_HEIGHT:1/1024,CUBEUV_MAX_MIP:'8.0'},uniforms:{...shared,tRadiance:{value:this.source.texture},tCavity:{value:cavity.blurRenderTarget.texture},envMap:{value:null},resolution:{value:new THREE.Vector2(256,256)}},vertexShader:vertex,depthWrite:false,depthTest:false,toneMapped:false,fragmentShader:`
   precision highp sampler2D;
   #include <common>
   #include <cube_uv_reflection_fragment>
   ${common}
   uniform highp sampler2D tRadiance,tCavity,envMap;
   uniform vec2 resolution;
   vec3 integratedBRDF(vec3 f0,float roughness,float dotNV){
    vec4 r=roughness*vec4(-1.0,-.0275,-.572,.022)+vec4(1.0,.0425,1.04,-.04);
    float a004=min(r.x*r.x,exp2(-9.28*dotNV))*r.x+r.y;
    vec2 fab=vec2(-1.04,1.04)*a004+r.zw;return f0*fab.x+fab.y;
   }
   void main(){
    gl_FragColor=vec4(0.0);
    float depth=texture2D(tDepth,vUv).r;if(depth>=.999999)return;
    vec4 surface=texture2D(tMaterial,vUv);float roughness=surface.a;
    float visibility=texture2D(tNormal,vUv).a;if(roughness>=.75||visibility<=0.0)return;
    vec3 p=positionAt(vUv,depth),n=normalAt(vUv),viewDirection=normalize(-p),ray=reflect(-viewDirection,n);
    float dotNV=max(dot(n,viewDirection),.001);
    vec3 origin=p+n*extent*.0006;
    float maxDistance=extent*.9,minDistance=extent*.0015,previousT=0.0;
    vec2 hitUV=vec2(0.0);float hitT=0.0,confidence=0.0;
    for(int i=0;i<STEPS;i++){
     float fraction=float(i+1)/float(STEPS),t=minDistance+maxDistance*pow(fraction,1.6);
     vec3 q=origin+ray*t;if(q.z>=-.0001)break;
     vec4 projected=cameraProjection*vec4(q,1.0);vec2 uv=projected.xy/projected.w*.5+.5;
     if(any(lessThan(uv,vec2(.001)))||any(greaterThan(uv,vec2(.999))))break;
     float sampledDepth=texture2D(tDepth,uv).r;
     float difference=viewZ(sampledDepth)-q.z;
     if(sampledDepth<.999999&&difference>=0.0){
      float lo=previousT,hi=t;
      for(int j=0;j<8;j++){
       float mid=(lo+hi)*.5;vec3 r=origin+ray*mid;vec4 clip=cameraProjection*vec4(r,1.0);vec2 u=clip.xy/clip.w*.5+.5;
       if(viewZ(texture2D(tDepth,u).r)-r.z>=0.0)hi=mid;else lo=mid;
      }
      hitT=(lo+hi)*.5;vec3 hit=origin+ray*hitT;vec4 clip=cameraProjection*vec4(hit,1.0);hitUV=clip.xy/clip.w*.5+.5;
      float error=abs(viewZ(texture2D(tDepth,hitUV).r)-hit.z);
      float thickness=extent*.00025+abs(hit.z)/resolution.y*.5;
      float facing=smoothstep(.02,.2,-dot(normalAt(hitUV),ray));
      if(error<thickness&&hitT>minDistance*1.5&&facing>0.0){
       float edge=min(min(hitUV.x,hitUV.y),min(1.0-hitUV.x,1.0-hitUV.y));
       confidence=facing*smoothstep(0.0,.06,edge)*(1.0-smoothstep(maxDistance*.6,maxDistance,hitT));
       break;
      }
      // A nearest depth sample can sit just in front of a grazing ray even
      // when the ray is leaving that same surface. Rejected/back-facing
      // candidates must not stop the search for a later physical crossing.
     }
     previousT=t;
    }
    if(confidence<=0.0)return;
    float conePixels=roughness*roughness*hitT/max(-p.z,.001)*cameraProjection[1][1]*resolution.y*.5;
    float lod=clamp(log2(max(conePixels,1.0)),0.0,8.0);
    vec3 local=textureLod(tRadiance,hitUV,lod).rgb;
    vec3 envDirection=normalize(mix(ray,n,roughness*roughness));
    envDirection=mat3(cameraWorld)*envDirection;
    vec3 environment=textureCubeUV(envMap,envDirection,roughness).rgb;
    float cavity=texture2D(tCavity,vUv).r;
    visibility*=clamp(pow(dotNV+cavity,exp2(-16.0*roughness-1.0))-1.0+cavity,0.0,1.0);
    confidence*=1.0-smoothstep(.35,.75,roughness);
    // Replace the isotropic single-scatter HDR specular term only where the
    // material/curvature mask permits a reliable screen-space estimate.
    // Direct lights and diffuse/multiple-scatter lighting stay intact.
    vec3 delta=(local-environment)*integratedBRDF(surface.rgb,roughness,dotNV)*visibility;
    gl_FragColor=vec4(delta*confidence,confidence);
   }`});
  this.composite=new THREE.ShaderMaterial({uniforms:{...shared,tDiffuse:{value:null},tReflection:{value:this.reflection.texture},reflectionSize:{value:new THREE.Vector2(256,256)}},vertexShader:vertex,depthWrite:false,depthTest:false,toneMapped:false,fragmentShader:`
   ${common}
   uniform highp sampler2D tDiffuse,tReflection;
   uniform vec2 reflectionSize;
   void main(){
    vec4 base=texture2D(tDiffuse,vUv);float depth=texture2D(tDepth,vUv).r;
    if(depth>=.999999){gl_FragColor=base;return;}
    float z=viewZ(depth),roughness=texture2D(tMaterial,vUv).a;vec3 n=normalAt(vUv);
    vec3 delta=vec3(0.0);float total=0.0;
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
     vec2 uv=(floor(vUv*reflectionSize)+vec2(float(x),float(y))+.5)/reflectionSize;
     float dz=abs(viewZ(texture2D(tDepth,uv).r)-z);
     float normalWeight=pow(max(dot(n,normalAt(uv)),0.0),48.0);
     float roughWeight=1.0-smoothstep(.05,.18,abs(texture2D(tMaterial,uv).a-roughness));
     float weight=normalWeight*roughWeight*exp(-dz/max(extent*.0015,abs(z)/reflectionSize.y));
     weight*=x==0&&y==0?1.0:.55;
     delta+=texture2D(tReflection,uv).rgb*weight;total+=weight;
    }
    gl_FragColor=vec4(max(vec3(0.0),base.rgb+delta/max(total,.0001)),base.a);
   }`});
  this.quad=new FullScreenQuad(this.copy);this.lastEnvironment=null;
 }
 setSize(width,height){
  this.width=width;this.height=height;
  const w=Math.max(1,Math.ceil(width*this.resolutionScale)),h=Math.max(1,Math.ceil(height*this.resolutionScale));
  this.source.setSize(w,h);this.reflection.setSize(w,h);this.trace.uniforms.resolution.value.set(w,h);this.composite.uniforms.reflectionSize.value.set(w,h);
 }
 render(renderer,writeBuffer,readBuffer){
  const environment=this.scene.environment;
  if(!environment||environment.mapping!==THREE.CubeUVReflectionMapping){
   this.copy.uniforms.map.value=readBuffer.texture;this.quad.material=this.copy;renderer.setRenderTarget(this.renderToScreen?null:writeBuffer);this.quad.render(renderer);return;
  }
  if(environment!==this.lastEnvironment){
   this.lastEnvironment=environment;this.trace.uniforms.envMap.value=environment;
   const width=environment.image.width,height=environment.image.height;
   Object.assign(this.trace.defines,{CUBEUV_TEXEL_WIDTH:1/width,CUBEUV_TEXEL_HEIGHT:1/height,CUBEUV_MAX_MIP:Math.log2(height/4).toFixed(1)});this.trace.needsUpdate=true;
  }
  const u=this.trace.uniforms;u.cameraProjection.value.copy(this.camera.projectionMatrix);u.cameraInverseProjection.value.copy(this.camera.projectionMatrixInverse);u.cameraWorld.value.copy(this.camera.matrixWorld);u.extent.value=Math.max(.001,this.extent);
  this.copy.uniforms.map.value=readBuffer.texture;this.quad.material=this.copy;renderer.setRenderTarget(this.source);this.quad.render(renderer);
  this.quad.material=this.trace;renderer.setRenderTarget(this.reflection);this.quad.render(renderer);
  this.composite.uniforms.tDiffuse.value=readBuffer.texture;this.quad.material=this.composite;renderer.setRenderTarget(this.renderToScreen?null:writeBuffer);this.quad.render(renderer);
 }
 dispose(){this.source.dispose();this.reflection.dispose();this.copy.dispose();this.trace.dispose();this.composite.dispose();this.quad.dispose();}
}
