import * as THREE from 'three';
import {Pass,FullScreenQuad} from './vendor/three/Pass.js';

// Each depth view originates on the actual rectangular emitter. Visibility
// modulates the existing LTC source; it adds no lights or helper geometry to
// the scene. The optional screen resolve shares the cavity geometry prepass.
function visibilitySource(samples){return `
precision highp sampler2D;
uniform highp sampler2D labFiniteDepth;
uniform float labFiniteResolution;
uniform mat4 labFiniteMatrices[${samples*3}],labFinitePlaneMatrices[${samples*3}];
uniform vec4 labFiniteTiles[${samples*3}];
uniform vec3 labFinitePositions[${samples*3}],labFiniteDirections[3];
float labFiniteTap(vec2 pixel,vec3 receiver,vec2 slope,vec4 tile){
 vec2 at=(clamp(pixel,vec2(0.0),vec2(labFiniteResolution-1.0))+.5)/labFiniteResolution;
 float depth=unpackRGBAToDepth(texture2D(labFiniteDepth,tile.zw+at*tile.xy));
 if(depth>=.999999)return 1.0;
 return step(receiver.z+dot(slope,at-receiver.xy)-.00001,depth);
}
float labFinitePoint(int index,vec3 world,vec3 planeNormal){
 vec4 clip=labFiniteMatrices[index]*vec4(world,1.0);vec3 p=clip.xyz/clip.w;
 if(clip.w<=0.0||p.x<=0.0||p.y<=0.0||p.x>=1.0||p.y>=1.0||p.z<=0.0||p.z>=1.0)return 1.0;
 // Transform the actual geometric receiver plane, not its interpolated
 // shading normal or a normal-offset triangle. Perspective preserves planes.
 vec4 plane=labFinitePlaneMatrices[index]*vec4(planeNormal,-dot(planeNormal,world));
 vec2 slope=abs(plane.z)>1e-10?-plane.xy/plane.z:vec2(0.0);
 vec2 pixel=p.xy*labFiniteResolution-.5,base=floor(pixel),weight=fract(pixel);
 vec4 tile=labFiniteTiles[index];
 float a=labFiniteTap(base,p,slope,tile),b=labFiniteTap(base+vec2(1,0),p,slope,tile);
 float c=labFiniteTap(base+vec2(0,1),p,slope,tile),d=labFiniteTap(base+vec2(1,1),p,slope,tile);
 return mix(mix(a,b,weight.x),mix(c,d,weight.x),weight.y);
}
vec2 labFiniteDirect(int lightIndex,vec3 world,vec3 normal,vec3 planeNormal,vec3 viewDirection,float roughness,float f0){
 vec2 visible=vec2(0.0),total=vec2(0.0);
 float alphaSquared=pow(max(roughness,.0525),4.0),dotNV=max(dot(normal,viewDirection),.0001);
 float smithView=sqrt(alphaSquared+(1.0-alphaSquared)*dotNV*dotNV);
 for(int sampleIndex=0;sampleIndex<${samples};sampleIndex++){
  int index=lightIndex*${samples}+sampleIndex;vec3 delta=labFinitePositions[index]-world;
  float distanceSquared=max(dot(delta,delta),.000001);vec3 direction=delta*inversesqrt(distanceSquared);
  float dotNL=max(dot(normal,direction),0.0);
  float diffuseWeight=dotNL*max(dot(-direction,labFiniteDirections[lightIndex]),0.0)/distanceSquared;
  // Plane evaluation uses no screen derivatives, so unlit source points can
  // be skipped without making derivatives undefined on neighboring pixels.
  if(diffuseWeight>0.0){
   vec3 halfDirection=normalize(direction+viewDirection);
   float dotNH=max(dot(normal,halfDirection),0.0),dotVH=max(dot(viewDirection,halfDirection),0.0);
   float denominator=dotNH*dotNH*(alphaSquared-1.0)+1.0;
   float distribution=alphaSquared/max(denominator*denominator,1e-12);
   float smith=.5/max(dotNL*smithView+dotNV*sqrt(alphaSquared+(1.0-alphaSquared)*dotNL*dotNL),1e-8);
   float fresnel=f0+(1.0-f0)*pow(1.0-dotVH,5.0);
   vec2 weight=vec2(diffuseWeight,diffuseWeight*distribution*smith*fresnel);
   float visibility=labFinitePoint(index,world,planeNormal);
   visible+=weight*visibility;total+=weight;
  }
 }
 return vec2(total.x>1e-8?visible.x/total.x:1.0,total.y>1e-12?visible.y/total.y:1.0);
}
`;}

const screenSource=`
uniform highp sampler2D labFiniteVisibilityMap,labFiniteSpecularMap,labFiniteViewDepth,labFiniteViewNormal;
uniform mat4 labFiniteInverseProjection;
uniform vec2 labFiniteScreenSize,labFiniteResolveSize;
uniform bool labFiniteResolved;
uniform float labFiniteExtent;
vec3 labFiniteViewPosition(vec2 uv,float depth){
 vec4 p=labFiniteInverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);return p.xyz/p.w;
}
void labFiniteScreenVisibility(vec3 world,vec3 worldNormal,float roughness,out vec3 diffuseVisibility,out vec3 specularVisibility){
 vec2 uv=gl_FragCoord.xy/labFiniteScreenSize,pixel=uv*labFiniteResolveSize-.5,base=floor(pixel),fraction=fract(pixel);
 vec3 p=(viewMatrix*vec4(world,1.0)).xyz,n=normalize(mat3(viewMatrix)*worldNormal),diffuseSum=vec3(0.0),specularSum=vec3(0.0);float diffuseTotal=0.0,specularTotal=0.0;
 float tolerance=max(labFiniteExtent*.0007,abs(p.z)/labFiniteScreenSize.y*.65);
 for(int y=0;y<2;y++)for(int x=0;x<2;x++){
  vec2 at=(clamp(base+vec2(float(x),float(y)),vec2(0.0),labFiniteResolveSize-1.0)+.5)/labFiniteResolveSize;
  // Resolve and upsample address the same nearest full-resolution pixel.
  vec2 sourceUV=(floor(at*labFiniteScreenSize)+.5)/labFiniteScreenSize;
  float depth=texture2D(labFiniteViewDepth,sourceUV).r;
  vec3 q=labFiniteViewPosition(sourceUV,depth),qn=normalize(texture2D(labFiniteViewNormal,sourceUV).xyz*2.0-1.0);
  float planeDistance=max(abs(dot(q-p,n)),abs(dot(q-p,qn)));
  float weight=pow(max(dot(n,qn),0.0),24.0)*exp(-planeDistance/tolerance);
  weight*=depth<.999999?1.0:0.0;
  weight*=(x==0?1.0-fraction.x:fraction.x)*(y==0?1.0-fraction.y:fraction.y);
  diffuseSum+=texture2D(labFiniteVisibilityMap,at).rgb*weight;diffuseTotal+=weight;
  vec4 specular=texture2D(labFiniteSpecularMap,at);
  float specularWeight=weight*(1.0-smoothstep(.035,.16,abs(specular.a-roughness)));
  specularSum+=specular.rgb*specularWeight;specularTotal+=specularWeight;
 }
 // Thin objects and silhouettes with no corresponding prepass pixel use
 // the direct source evaluation instead of borrowing a neighbor's shadow.
 diffuseVisibility=diffuseTotal>.02?diffuseSum/diffuseTotal:vec3(-1.0);
 specularVisibility=specularTotal>.02?specularSum/specularTotal:vec3(-1.0);
}
`;

class FiniteResolvePass extends Pass {
 constructor(shadows,cavity,camera,{resolutionScale=.5}={}){
  super();this.needsSwap=false;this.shadows=shadows;this.camera=camera;this.cavity=cavity;this.resolutionScale=resolutionScale;
  this.target=new THREE.WebGLMultipleRenderTargets(256,256,2,{type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
  this.diffuseTexture=this.target.texture[0];this.specularTexture=this.target.texture[1];
  this.diffuseTexture.name='Finite source diffuse visibility';this.specularTexture.name='Finite source specular visibility';
  this.material=new THREE.ShaderMaterial({depthWrite:false,depthTest:false,toneMapped:false,blending:THREE.NoBlending,
   uniforms:{...shadows.uniforms,tDepth:{value:cavity.normalRenderTarget.depthTexture},tNormal:{value:cavity.normalTexture},tFacetNormal:{value:cavity.facetNormalTexture},tMaterial:{value:cavity.materialTexture},cameraInverseProjection:shadows.inverseProjection,cameraWorld:{value:new THREE.Matrix4()},cameraIsOrthographic:{value:!!camera.isOrthographicCamera},screenSize:shadows.screenSize},
   vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
   fragmentShader:`
    #include <common>
    #include <packing>
    ${visibilitySource(shadows.samples)}
    layout(location=1) out vec4 labSpecularOutput;
    uniform highp sampler2D tDepth,tNormal,tFacetNormal,tMaterial;
    uniform mat4 cameraInverseProjection,cameraWorld;
    uniform bool cameraIsOrthographic;
    uniform vec2 screenSize;
    uniform float labFiniteNormalBias;
    varying vec2 vUv;
    vec3 positionAt(vec2 uv){vec4 p=cameraInverseProjection*vec4(uv*2.0-1.0,texture2D(tDepth,uv).r*2.0-1.0,1.0);return p.xyz/p.w;}
    void main(){
     vec2 uv=(floor(vUv*screenSize)+.5)/screenSize;
     float depth=texture2D(tDepth,uv).r;if(depth>=.999999){gl_FragColor=vec4(1.0);labSpecularOutput=vec4(1.0);return;}
     vec3 p=positionAt(uv),n=normalize(texture2D(tNormal,uv).xyz*2.0-1.0);
     vec3 planeNormal=normalize(texture2D(tFacetNormal,uv).xyz);
     vec3 worldNormal=normalize(mat3(cameraWorld)*n),worldPlane=normalize(mat3(cameraWorld)*planeNormal);
     vec3 world=(cameraWorld*vec4(p,1.0)).xyz+worldNormal*labFiniteNormalBias;
     vec4 material=texture2D(tMaterial,uv);float roughness=material.a,f0=dot(material.rgb,vec3(.2126,.7152,.0722));
     vec3 viewDirection=normalize(mat3(cameraWorld)*(cameraIsOrthographic?vec3(0.0,0.0,1.0):-p));
     vec2 a=labFiniteDirect(0,world,worldNormal,worldPlane,viewDirection,roughness,f0);
     vec2 b=labFiniteDirect(1,world,worldNormal,worldPlane,viewDirection,roughness,f0);
     vec2 c=labFiniteDirect(2,world,worldNormal,worldPlane,viewDirection,roughness,f0);
     gl_FragColor=vec4(a.x,b.x,c.x,1.0);labSpecularOutput=vec4(a.y,b.y,c.y,roughness);
    }`});
  if(shadows.visibilityFilter){
   const radius=shadows.visibilityFilter;
   this.scratch=this.target.clone();
   this.filter=new THREE.ShaderMaterial({depthWrite:false,depthTest:false,toneMapped:false,blending:THREE.NoBlending,
    uniforms:{tDiffuse:{value:this.diffuseTexture},tSpecular:{value:this.specularTexture},tDepth:{value:cavity.normalRenderTarget.depthTexture},tNormal:{value:cavity.normalTexture},cameraInverseProjection:shadows.inverseProjection,screenSize:shadows.screenSize,resolveSize:shadows.resolveSize,extent:shadows.extent,direction:{value:new THREE.Vector2(1,0)}},
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader:`
     precision highp sampler2D;
     layout(location=1) out vec4 labSpecularOutput;
     uniform highp sampler2D tDiffuse,tSpecular,tDepth,tNormal;
     uniform mat4 cameraInverseProjection;
     uniform vec2 screenSize,resolveSize,direction;
     uniform float extent;
     varying vec2 vUv;
     vec3 positionAt(vec2 uv,float depth){vec4 p=cameraInverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);return p.xyz/p.w;}
     void main(){
      vec4 originalDiffuse=texture2D(tDiffuse,vUv),originalSpecular=texture2D(tSpecular,vUv);
      vec2 center=(floor(vUv*screenSize)+.5)/screenSize;
      float depth=texture2D(tDepth,center).r;
      if(depth>=.999999){gl_FragColor=originalDiffuse;labSpecularOutput=originalSpecular;return;}
      vec3 p=positionAt(center,depth),n=normalize(texture2D(tNormal,center).xyz*2.0-1.0);
      float tolerance=max(extent*.0007,abs(p.z)/screenSize.y*.65);
      vec3 diffuseSum=vec3(0.0),specularSum=vec3(0.0);float diffuseTotal=0.0,specularTotal=0.0;
      for(int i=-${radius};i<=${radius};i++){
       vec2 uv=clamp(vUv+direction*float(i)/resolveSize,.5/resolveSize,1.0-.5/resolveSize);
       vec2 at=(floor(uv*screenSize)+.5)/screenSize;float sampleDepth=texture2D(tDepth,at).r;
       vec3 q=positionAt(at,sampleDepth),qn=normalize(texture2D(tNormal,at).xyz*2.0-1.0);
       float planeDistance=max(abs(dot(q-p,n)),abs(dot(q-p,qn)));
       float kernel=${radius===2?'i==0?.375:abs(i)==1?.25:.0625':'i==0?.3125:abs(i)==1?.234375:abs(i)==2?.09375:.015625'};
       float weight=kernel*pow(max(dot(n,qn),0.0),64.0)*exp(-planeDistance/tolerance);
       weight*=sampleDepth<.999999?1.0:0.0;
       diffuseSum+=texture2D(tDiffuse,uv).rgb*weight;diffuseTotal+=weight;
       vec4 specular=texture2D(tSpecular,uv);
       float specularWeight=weight*(1.0-smoothstep(.035,.16,abs(specular.a-originalSpecular.a)));
       specularSum+=specular.rgb*specularWeight;specularTotal+=specularWeight;
      }
      gl_FragColor=vec4(diffuseSum/max(diffuseTotal,1e-8),originalDiffuse.a);
      labSpecularOutput=vec4(specularSum/max(specularTotal,1e-8),originalSpecular.a);
     }`});
  }
  this.quad=new FullScreenQuad(this.material);this.setSize(512,512);
 }
 setSize(width,height){
  const w=Math.max(1,Math.ceil(width*this.resolutionScale)),h=Math.max(1,Math.ceil(height*this.resolutionScale));
  this.target.setSize(w,h);this.scratch?.setSize(w,h);this.shadows.screenSize.value.set(width,height);this.shadows.resolveSize.value.set(w,h);this.shadows.resolved.value=false;
 }
 render(renderer){
  const s=this.shadows;s.resolved.value=false;s.active.value=!s.failed&&s.enabled&&renderer.shadowMap.enabled;
  if(!s.active.value)return;
  s.inverseProjection.value.copy(this.camera.projectionMatrixInverse);this.material.uniforms.cameraWorld.value.copy(this.camera.matrixWorld);
  const target=renderer.getRenderTarget();
  try{
   this.quad.material=this.material;renderer.setRenderTarget(this.target);this.quad.render(renderer);
   if(this.filter){
    // Denoise visibility only. The scene radiance, source powers, material
    // maps and surface normals are never filtered. Depth/normal gates retain
    // object boundaries; roughness also separates distinct specular lobes.
    const u=this.filter.uniforms;this.quad.material=this.filter;
    u.tDiffuse.value=this.diffuseTexture;u.tSpecular.value=this.specularTexture;u.direction.value.set(1,0);
    renderer.setRenderTarget(this.scratch);this.quad.render(renderer);
    u.tDiffuse.value=this.scratch.texture[0];u.tSpecular.value=this.scratch.texture[1];u.direction.value.set(0,1);
    renderer.setRenderTarget(this.target);this.quad.render(renderer);
   }
   s.resolved.value=true;
  }finally{renderer.setRenderTarget(target);}
 }
 dispose(){this.shadows.resolved.value=false;this.target.dispose();this.scratch?.dispose();this.material.dispose();this.filter?.dispose();this.quad.dispose();}
}

export class AreaShadows {
 constructor(renderer,scene,areas,{samples=32,resolution=512,visibilityFilter=3}={}){
  this.renderer=renderer;this.scene=scene;this.areas=areas;this.visibilityFilter=visibilityFilter?Math.min(3,Math.max(2,Math.round(visibilityFilter))):0;
  const gl=renderer.getContext(),uniformLimit=gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
  const sampleLimit=Math.floor((uniformLimit-48)/30),directLimit=Math.floor((uniformLimit-160)/30);
  this.samples=[4,8,16,32].filter(value=>value<=samples&&value<=sampleLimit).pop()||4;
  this.directSamples=[4,8,16,32].filter(value=>value<=this.samples&&value<=directLimit).pop()||4;
  this.columns=this.samples>8?8:4;this.rows=Math.ceil(this.samples*3/this.columns);
  this.resolution=Math.min(resolution,Math.floor(renderer.capabilities.maxTextureSize/this.columns),Math.floor(renderer.capabilities.maxTextureSize/this.rows));
  this.atlas=new THREE.WebGLRenderTarget(this.columns*this.resolution,this.rows*this.resolution,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,type:THREE.UnsignedByteType,depthBuffer:true,stencilBuffer:false});
  this.atlas.texture.name='Finite rectangular source depth views';
  this.depthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});
  // A four-sample program is the smallest supported enhanced path. Keep the
  // ordinary PBR scene usable when even that exceeds the device's uniforms.
  this.enabled=true;this.failed=directLimit<4;this.active={value:!this.failed};this.normalBias={value:0};this.materials=new WeakSet();
  this.matrices=[];this.planeMatrices=[];this.tiles=[];this.positions=[];this.directions=areas.map(()=>new THREE.Vector3());
  this.views=[];this.updateCount=0;this.lastUpdateMs=0;this.resolve=null;this.resolved={value:false};
  this.inverseProjection={value:new THREE.Matrix4()};this.screenSize={value:new THREE.Vector2(512,512)};this.resolveSize={value:new THREE.Vector2(256,256)};this.extent={value:1};
  this.uniforms={labFiniteDepth:{value:this.atlas.texture},labFiniteEnabled:this.active,labFiniteNormalBias:this.normalBias,labFiniteResolution:{value:this.resolution},labFiniteMatrices:{value:this.matrices},labFinitePlaneMatrices:{value:this.planeMatrices},labFiniteTiles:{value:this.tiles},labFinitePositions:{value:this.positions},labFiniteDirections:{value:this.directions}};
  for(let lightIndex=0;lightIndex<3;lightIndex++)for(let sampleIndex=0;sampleIndex<this.samples;sampleIndex++){
   const area=areas[lightIndex],ratio=Math.max(area.width,area.height)/Math.min(area.width,area.height);
   const along=[1,2,4,8,16,32].filter(n=>n<=this.samples).reduce((best,n)=>Math.abs(Math.log(n*n/this.samples/ratio))<Math.abs(Math.log(best*best/this.samples/ratio))?n:best,1),across=this.samples/along;
   // Long strips need proportionally more samples along their length. A
   // square grid on a 7:1 emitter produces visibly repeated shadow bands.
   // Opposite pairs retain the exact source centroid despite stratification.
   const mirror=sampleIndex>=this.samples/2,indexInPair=mirror?this.samples-1-sampleIndex:sampleIndex;
   const column=indexInPair%along,row=Math.floor(indexInPair/along),sign=mirror?-1:1;
   const jitterX=(((indexInPair+1)*.61803398875)%1-.5)*.72,jitterY=(((indexInPair+1)*.41421356237)%1-.5)*.72;
   const long=sign*((column+.5+jitterX)/along-.5),short=sign*((row+.5+jitterY)/across-.5);
   const uv=area.width>=area.height?new THREE.Vector2(long,short):new THREE.Vector2(short,long);
   const index=this.views.length,camera=new THREE.PerspectiveCamera(90,1,.025,12);
   camera.name=area.name+' visibility sample '+sampleIndex;camera.userData.rasterOnly=true;
   this.views.push({camera,lightIndex,sampleIndex,uv,column:index%this.columns,row:Math.floor(index/this.columns)});
   this.positions.push(new THREE.Vector3());this.matrices.push(new THREE.Matrix4());this.planeMatrices.push(new THREE.Matrix4());
   this.tiles.push(new THREE.Vector4(1/this.columns,1/this.rows,(index%this.columns)/this.columns,Math.floor(index/this.columns)/this.rows));
  }
  // With a screen resolve, only thin/unmatched silhouette pixels need a
  // direct material fallback. Four representative source points keep that
  // uncommon branch small; the resolve still integrates all source views.
  const subset=count=>{
   if(count===this.samples)return this.uniforms;
   const selected={...this.uniforms},first=Array.from({length:count/2},(_,i)=>Math.floor((i+.5)*this.samples/count));
   const indices=[...first,...first.map(index=>this.samples-1-index)].sort((a,b)=>a-b);
   for(const [name,values] of [['Matrices',this.matrices],['PlaneMatrices',this.planeMatrices],['Tiles',this.tiles],['Positions',this.positions]])selected['labFinite'+name]={value:[0,1,2].flatMap(lightIndex=>indices.map(index=>values[lightIndex*this.samples+index]))};
   return selected;
  };
  this.fallbackUniforms=subset(4);this.directUniforms=subset(this.directSamples);
 }
 get stats(){return {views:this.views.length,samplesPerSource:this.samples,materialSamplesPerSource:this.resolve?4:this.directSamples,resolution:this.resolution,atlas:[this.atlas.width,this.atlas.height],resolve:this.resolve?this.resolveSize.value.toArray():null,separateSpecularVisibility:true,visibilityFilter:this.resolve?this.visibilityFilter:0,updates:this.updateCount,lastUpdateMs:this.lastUpdateMs};}
 createResolvePass(cavity,camera,options={}){
  if(this.resolve)throw Error('Finite shadow resolve already exists');
  this.resolve=new FiniteResolvePass(this,cavity,camera,options);
  this.scene.traverse(object=>{if(object.isMesh)for(const material of [].concat(object.material))if(this.materials.has(material))material.needsUpdate=true;});
  return this.resolve;
 }
 fit(box){
  this.fittedBounds=box.clone();
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
  const extent=Math.max(size.x,size.y,size.z),radius=size.length()*.5;this.extent.value=extent;
  this.normalBias.value=extent*.00006;
  const bias=new THREE.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1);
  this.areas.forEach((area,index)=>{area.updateMatrixWorld(true);this.directions[index].set(0,0,-1).applyQuaternion(area.quaternion);});
  this.views.forEach((view,index)=>{
   const area=this.areas[view.lightIndex],camera=view.camera;
   camera.position.set(view.uv.x*area.width,view.uv.y*area.height,0).applyMatrix4(area.matrixWorld);
   const distance=camera.position.distanceTo(center),angle=Math.min(1.48,Math.asin(Math.min(.985,radius/distance))*1.12);
   camera.up.set(0,1,0).applyQuaternion(area.quaternion);camera.lookAt(center);
   camera.near=Math.max(.015,distance-radius*1.3);camera.far=Math.max(12,distance+radius*4);camera.fov=THREE.MathUtils.radToDeg(2*angle);
   camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
   this.positions[index].copy(camera.position);
   this.matrices[index].copy(bias).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
   this.planeMatrices[index].copy(this.matrices[index]).invert().transpose();
  });
  this.resolved.value=false;this.renderer.shadowMap.needsUpdate=true;
 }
 update(root=this.scene){
  const r=this.renderer,s=this.scene;this.active.value=!this.failed&&this.enabled&&r.shadowMap.enabled;this.resolved.value=false;
  if(!this.active.value)return;
  const started=performance.now();
  // Articulated doors, drawers, hands and transported chips can leave the
  // initial resting bounds. Grow the camera envelope when they do.
  if(root!==s&&this.fittedBounds){const bounds=new THREE.Box3().setFromObject(root);if(!this.fittedBounds.containsBox(bounds))this.fit(this.fittedBounds.clone().union(bounds).expandByScalar(this.extent.value*.025));}
  const target=r.getRenderTarget(),background=s.background,override=s.overrideMaterial;
  const color=r.getClearColor(new THREE.Color()),alpha=r.getClearAlpha(),shadows=r.shadowMap.enabled,auto=r.autoClear;
  const viewport=r.getViewport(new THREE.Vector4()),scissor=r.getScissor(new THREE.Vector4()),scissorTest=r.getScissorTest(),hidden=[];
  s.traverse(object=>{if(object.isMesh&&object.visible&&(!object.castShadow||object.userData.rasterOnly||object.userData.physicsOverlay||[].concat(object.material).some(material=>(material.transmission||0)>.1||(material.transparent&&material.opacity<.45)))){hidden.push(object);object.visible=false;}});
  try{
   r.shadowMap.enabled=false;r.autoClear=false;s.background=null;s.overrideMaterial=this.depthMaterial;r.setClearColor(0xffffff,1);
   r.setRenderTarget(this.atlas);r.setScissorTest(true);
   for(const view of this.views){
    const x=view.column*this.resolution,y=view.row*this.resolution;
    r.setViewport(x,y,this.resolution,this.resolution);r.setScissor(x,y,this.resolution,this.resolution);r.clear(true,true,false);r.render(s,view.camera);
   }
  }finally{
   for(const object of hidden)object.visible=true;s.background=background;s.overrideMaterial=override;r.shadowMap.enabled=shadows;r.autoClear=auto;r.setClearColor(color,alpha);
   r.setRenderTarget(target);r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(scissorTest);
  }
  this.updateCount++;this.lastUpdateMs=performance.now()-started;
 }
 disableAfterGraphicsError(){
  this.failed=true;this.active.value=false;this.resolved.value=false;
  this.scene.traverse(object=>{if(object.isMesh)for(const material of [].concat(object.material)){
   if(!this.materials.has(material))continue;
   material.defines={...material.defines,LAB_AREA_FALLBACK:1};material.needsUpdate=true;
  }});
 }
 apply(root){root.traverse(object=>{if(object.isMesh)for(const material of [].concat(object.material))this.applyMaterial(material);});}
 applyMaterial(material){
  if(!material?.isMeshStandardMaterial||this.materials.has(material))return;
  this.materials.add(material);if(this.failed)material.defines={...material.defines,LAB_AREA_FALLBACK:1};
  const previous=material.onBeforeCompile,originalKey=material.customProgramCacheKey();
  material.customProgramCacheKey=()=>originalKey+'|finite-area-visibility-v3-'+(this.resolve?4:this.directSamples);
  material.onBeforeCompile=(shader,renderer)=>{
   previous.call(material,shader,renderer);if(this.failed)return;
   const materialSamples=this.resolve?4:this.directSamples;
   Object.assign(shader.uniforms,this.resolve?this.fallbackUniforms:this.directUniforms,{labFiniteResolved:this.resolved,labFiniteVisibilityMap:{value:this.resolve?.diffuseTexture||this.atlas.texture},labFiniteSpecularMap:{value:this.resolve?.specularTexture||this.atlas.texture},labFiniteViewDepth:{value:this.resolve?.cavity.normalRenderTarget.depthTexture||this.atlas.texture},labFiniteViewNormal:{value:this.resolve?.cavity.normalTexture||this.atlas.texture},labFiniteInverseProjection:this.inverseProjection,labFiniteScreenSize:this.screenSize,labFiniteResolveSize:this.resolveSize,labFiniteExtent:this.extent});
   shader.vertexShader='varying vec3 vLabFiniteWorld;\nvarying vec3 vLabFiniteNormal;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
    vLabFiniteNormal=inverseTransformDirection(transformedNormal,viewMatrix);
    vLabFiniteWorld=(modelMatrix*vec4(transformed,1.0)).xyz;`);
   shader.fragmentShader=shader.fragmentShader.replace('#include <shadowmap_pars_fragment>',`#include <shadowmap_pars_fragment>
    #if NUM_RECT_AREA_LIGHTS >= 3
    uniform bool labFiniteEnabled;uniform float labFiniteNormalBias;
    varying vec3 vLabFiniteWorld;varying vec3 vLabFiniteNormal;
    ${visibilitySource(materialSamples)}
    ${this.resolve?screenSource:''}
    #endif`);
   let lights=THREE.ShaderChunk.lights_fragment_begin;
   lights=lights.replace('RectAreaLight rectAreaLight;',`RectAreaLight rectAreaLight;
    vec3 labWorldNormal=normalize(vLabFiniteNormal)*(gl_FrontFacing?1.0:-1.0);
    vec3 labPlaneNormal=cross(dFdx(vLabFiniteWorld),dFdy(vLabFiniteWorld));
    labPlaneNormal=dot(labPlaneNormal,labPlaneNormal)>1e-20?normalize(labPlaneNormal):labWorldNormal;
    vec3 labSourceDiffuseVisibility=vec3(1.0),labSourceSpecularVisibility=vec3(1.0);
    if(receiveShadow&&labFiniteEnabled){
     labSourceDiffuseVisibility=vec3(-1.0);labSourceSpecularVisibility=vec3(-1.0);
     ${this.resolve?'if(labFiniteResolved)labFiniteScreenVisibility(vLabFiniteWorld,labWorldNormal,material.roughness,labSourceDiffuseVisibility,labSourceSpecularVisibility);':''}
     if(labSourceDiffuseVisibility.x<0.0||labSourceSpecularVisibility.x<0.0){
      vec3 world=vLabFiniteWorld+labWorldNormal*labFiniteNormalBias,viewDirection=inverseTransformDirection(geometryViewDir,viewMatrix);
      float f0=dot(material.specularColor,vec3(.2126,.7152,.0722));
      vec2 a=labFiniteDirect(0,world,labWorldNormal,labPlaneNormal,viewDirection,material.roughness,f0);
      vec2 b=labFiniteDirect(1,world,labWorldNormal,labPlaneNormal,viewDirection,material.roughness,f0);
      vec2 c=labFiniteDirect(2,world,labWorldNormal,labPlaneNormal,viewDirection,material.roughness,f0);
      if(labSourceDiffuseVisibility.x<0.0)labSourceDiffuseVisibility=vec3(a.x,b.x,c.x);
      if(labSourceSpecularVisibility.x<0.0)labSourceSpecularVisibility=vec3(a.y,b.y,c.y);
     }
    }`);
   // Lambert visibility is not the visibility of a glossy reflection lobe.
   // Preserve the LTC source integration and attenuate its two contributions
   // independently. Explicit braces survive Three's source-loop unrolling.
   lights=lights.replace('RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',`{
    vec3 previousDiffuse=reflectedLight.directDiffuse,previousSpecular=reflectedLight.directSpecular;
    RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    if(receiveShadow&&labFiniteEnabled){
     #if UNROLLED_LOOP_INDEX == 0
      reflectedLight.directDiffuse=previousDiffuse+(reflectedLight.directDiffuse-previousDiffuse)*labSourceDiffuseVisibility.x;
      reflectedLight.directSpecular=previousSpecular+(reflectedLight.directSpecular-previousSpecular)*labSourceSpecularVisibility.x;
     #elif UNROLLED_LOOP_INDEX == 1
      reflectedLight.directDiffuse=previousDiffuse+(reflectedLight.directDiffuse-previousDiffuse)*labSourceDiffuseVisibility.y;
      reflectedLight.directSpecular=previousSpecular+(reflectedLight.directSpecular-previousSpecular)*labSourceSpecularVisibility.y;
     #elif UNROLLED_LOOP_INDEX == 2
      reflectedLight.directDiffuse=previousDiffuse+(reflectedLight.directDiffuse-previousDiffuse)*labSourceDiffuseVisibility.z;
      reflectedLight.directSpecular=previousSpecular+(reflectedLight.directSpecular-previousSpecular)*labSourceSpecularVisibility.z;
     #endif
    }
   }`);
   shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',lights);
  };
  material.needsUpdate=true;
 }
 dispose(){this.resolve?.dispose();this.atlas.dispose();this.depthMaterial.dispose();}
}
