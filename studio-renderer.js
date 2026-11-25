import * as THREE from 'three';
import {RectAreaLightUniformsLib} from './vendor/three/RectAreaLightUniformsLib.js';
import {AreaShadows} from './area-shadows.js?v=lighting2';

// Photographic illumination and scale-aware contact occlusion. This helper
// never edits the imported object's PBR parameters or physics transforms.
export class LabStudio {
 constructor(renderer,scene){
  this.renderer=renderer;this.scene=scene;this.extent=1;this.shadowUpdates=0;this.dirty=true;this.lastShadow=0;
  RectAreaLightUniformsLib.init();
  // Same metre-scale rectangular sources as tools/photographic_studio.py.
  // RectAreaLight intensity is radiance: power / (pi * emitting area).
  // Their finite reflected shapes are essential on polished metal and glass.
  const lamps=[
   ['Window key',[-.62,1.18,.48],25,.12,.82,[1,.965,.925]],
   ['Ceiling bounce',[.68,1.12,.12],8,.88,1.10,[.91,.95,1]],
   ['Rear strip reflection',[.18,.88,-.62],11,.12,.85,[1,1,1]]
  ];
  this.areaLights=lamps.map(([name,position,power,width,height,color])=>{
   const light=new THREE.RectAreaLight(new THREE.Color(...color),power/(Math.PI*width*height),width,height);
   light.name=name;light.position.set(...position);light.lookAt(0,.24,.02);scene.add(light);return light;
  });
  this.fill=this.areaLights[1];
  this.areaShadows=new AreaShadows(renderer,scene,this.areaLights);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const context=canvas.getContext('2d'),pixels=context.createImageData(256,256);let seed=19;
  for(let i=0;i<pixels.data.length;i+=4){seed=(1664525*seed+1013904223)>>>0;const v=238+(seed%5)-2;pixels.data.set([v,v,v,255],i);}
  context.putImageData(pixels,0,0);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.NoColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(1000,1000);texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  this.ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:new THREE.Color(.205,.215,.22),roughness:.49,metalness:0}));
  // Submicrometre grain changes the normal, preserving source albedo/roughness.
  this.ground.material.bumpMap=texture;this.ground.material.bumpScale=.000036;
  this.ground.rotation.x=-Math.PI/2;this.ground.position.y=-.001;this.ground.receiveShadow=true;scene.add(this.ground);
  this.ground.material.userData.labWideShadows=true;
  this.areaShadows.applyMaterial(this.ground.material);
  this.pathEnvironmentIntensity=.42;
  // World/object rotation. Tracing code inverts it to obtain the sampling
  // rotation corresponding to Blender's +120-degree texture mapping.
  this.pathEnvironmentRotation=new THREE.Euler(0,-2*Math.PI/3,0);
  this.createContactShadows();this.setEnvironment();
 }
 setEnvironment(hdr=null){
  this.pathEnvironment?.dispose();
  if(hdr){this.pathEnvironment=hdr.clone();this.pathEnvironment.needsUpdate=true;}
  else{
   const pixels=new Float32Array(16*8*4);
   for(let i=0;i<pixels.length;i+=4)pixels.set([.12,.125,.13,1],i);
   this.pathEnvironment=new THREE.DataTexture(pixels,16,8,THREE.RGBAFormat,THREE.FloatType);this.pathEnvironment.needsUpdate=true;
  }
  this.pathEnvironment.mapping=THREE.EquirectangularReflectionMapping;
  this.pathEnvironment.colorSpace=THREE.LinearSRGBColorSpace;
  this.pathEnvironment.minFilter=this.pathEnvironment.magFilter=THREE.LinearFilter;
  this.buildEnvironment();
 }
 buildEnvironment(){
  const studio=new THREE.Scene();
  // Explicit equirectangular direction lookup avoids a sphere's UV seam/
  // handedness changing the HDR orientation between raster and traced views.
  const env=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,toneMapped:false,
   uniforms:{environmentMap:{value:this.pathEnvironment},strength:{value:this.pathEnvironmentIntensity},sampleRotation:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(2*Math.PI/3))}},
   vertexShader:'varying vec3 envDirection;void main(){envDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
   fragmentShader:'uniform sampler2D environmentMap;uniform float strength;uniform mat3 sampleRotation;varying vec3 envDirection;void main(){vec3 d=normalize(sampleRotation*envDirection);vec2 uv=vec2(atan(d.z,d.x)*0.15915494309189535+.5,asin(clamp(d.y,-1.0,1.0))*0.3183098861837907+.5);gl_FragColor=vec4(texture2D(environmentMap,uv).rgb*strength,1.0);}'
  });
  studio.add(new THREE.Mesh(new THREE.SphereGeometry(20,48,24),env));
  const generator=new THREE.PMREMGenerator(this.renderer),room=generator.fromScene(studio,.025,.02,50);
  // The bench blocks the lower HDR hemisphere and contributes reflected light
  // in Cycles. Capture that first bounce in the live reflection probe too.
  // Area sources remain analytic lights; no duplicate luminous panels are baked.
  studio.environment=room.texture;
  const probe=this.probePosition||new THREE.Vector3(0,.24,0);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:this.ground.material.color.clone(),roughness:this.ground.material.roughness,metalness:0}));
  floor.rotation.x=-Math.PI/2;floor.position.y=Math.min(-.005,this.ground.position.y-probe.y);studio.add(floor);
  for(const source of this.areaLights){const light=source.clone();light.position.sub(probe);studio.add(light);}
  const next=generator.fromScene(studio,.025,.002,50);room.dispose();
  this.environment?.dispose();this.environment=next;this.scene.environment=next.texture;generator.dispose();
  studio.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
 }
 createContactShadows(){
  const size=768,options={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false};
  this.raw=new THREE.WebGLRenderTarget(size,size,{...options,depthBuffer:true});
  this.scratch=new THREE.WebGLRenderTarget(size,size,options);this.near=new THREE.WebGLRenderTarget(size,size,options);this.soft=new THREE.WebGLRenderTarget(size,size,options);
  this.contactCamera=new THREE.OrthographicCamera(-1,1,1,-1,.00001,1);this.contactCamera.up.set(0,0,1);
  this.depth=new THREE.ShaderMaterial({side:THREE.DoubleSide,vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'void main(){float a=pow(clamp(1.0-gl_FragCoord.z,0.0,1.0),2.0);gl_FragColor=vec4(vec3(a),1.0);}'});
  const vertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
  this.blur=new THREE.ShaderMaterial({uniforms:{inputMap:{value:null},direction:{value:new THREE.Vector2()}},vertexShader:vertex,fragmentShader:`
   uniform sampler2D inputMap;uniform vec2 direction;varying vec2 vUv;
   void main(){float a=texture2D(inputMap,vUv).r*.227027;
    a+=(texture2D(inputMap,vUv+direction*1.384615).r+texture2D(inputMap,vUv-direction*1.384615).r)*.316216;
    a+=(texture2D(inputMap,vUv+direction*3.230769).r+texture2D(inputMap,vUv-direction*3.230769).r)*.070270;
    gl_FragColor=vec4(vec3(a),1.0);}`});
  this.blurScene=new THREE.Scene();this.blurCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);this.blurScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.blur));
  this.contact=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.ShaderMaterial({transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,toneMapped:false,uniforms:{nearMap:{value:this.near.texture},softMap:{value:this.soft.texture}},vertexShader:vertex,fragmentShader:`
   uniform sampler2D nearMap;uniform sampler2D softMap;varying vec2 vUv;
   void main(){vec2 uv=vec2(vUv.x,1.0-vUv.y);float a=texture2D(nearMap,uv).r*.22+texture2D(softMap,uv).r*.12;
    gl_FragColor=vec4(.035,.033,.030,a);}` }));
  this.contact.rotation.x=-Math.PI/2;this.contact.renderOrder=2;this.contact.userData.rasterOnly=true;this.scene.add(this.contact);
 }
 fit(box){
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());this.extent=Math.max(size.x,size.y,size.z);
  // All photographic studios use a bench top at z=-1 mm. Loose cables can
  // extend below it; their bounding box must not lower the support surface.
  const e=this.extent,floor=-.001,pad=e*.38,width=size.x+2*pad,depth=size.z+2*pad;
  this.ground.position.y=floor;this.contact.position.set(center.x,floor+e*.00015,center.z);this.contact.scale.set(width,depth,1);
  const camera=this.contactCamera;camera.left=-width/2;camera.right=width/2;camera.top=depth/2;camera.bottom=-depth/2;camera.near=e*.0001;camera.far=e*.30;
  camera.position.set(center.x,floor-e*.0001,center.z);camera.lookAt(center.x,floor+1,center.z);camera.updateProjectionMatrix();
  this.areaShadows.fit(box);
  this.probePosition=center.clone();this.buildEnvironment();
  this.dirty=true;this.renderer.shadowMap.needsUpdate=true;
 }
 update(model,force=false){
  if(!model||!this.dirty||(!force&&performance.now()-this.lastShadow<120))return false;
  const r=this.renderer,s=this.scene,oldTarget=r.getRenderTarget(),oldBackground=s.background,oldOverride=s.overrideMaterial,oldColor=r.getClearColor(new THREE.Color()),oldAlpha=r.getClearAlpha(),oldShadows=r.shadowMap.enabled;
  const hidden=[];
  for(const o of s.children)if(o!==model&&o.visible){hidden.push(o);o.visible=false;}
  model.traverse(o=>{if(o.isMesh&&o.visible&&[].concat(o.material).some(m=>(m.transmission||0)>.1||(m.transparent&&m.opacity<.45))){hidden.push(o);o.visible=false;}});
  try{
   r.shadowMap.enabled=false;s.background=null;s.overrideMaterial=this.depth;r.setClearColor(0x000000,1);r.setRenderTarget(this.raw);r.render(s,this.contactCamera);
   s.overrideMaterial=null;
   const blur=(radius,destination)=>{
    this.blur.uniforms.inputMap.value=this.raw.texture;this.blur.uniforms.direction.value.set(radius/this.raw.width,0);r.setRenderTarget(this.scratch);r.render(this.blurScene,this.blurCamera);
    this.blur.uniforms.inputMap.value=this.scratch.texture;this.blur.uniforms.direction.value.set(0,radius/this.raw.height);r.setRenderTarget(destination);r.render(this.blurScene,this.blurCamera);
   };blur(1.2,this.near);blur(7,this.soft);
  }finally{for(const o of hidden)o.visible=true;s.background=oldBackground;s.overrideMaterial=oldOverride;r.shadowMap.enabled=oldShadows;r.setClearColor(oldColor,oldAlpha);r.setRenderTarget(oldTarget);}
  this.areaShadows.update(model);
  this.renderer.shadowMap.needsUpdate=true;
  this.dirty=false;this.lastShadow=performance.now();this.shadowUpdates++;return true;
 }
}
