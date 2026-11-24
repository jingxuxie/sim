import * as THREE from 'three';

// Photographic illumination and scale-aware contact occlusion. This helper
// never edits the imported object's PBR parameters or physics transforms.
export class LabStudio {
 constructor(renderer,scene){
  this.renderer=renderer;this.scene=scene;this.extent=1;this.shadowUpdates=0;this.dirty=true;this.lastShadow=0;
  this.key=new THREE.DirectionalLight(0xfff6ed,1.65);this.key.castShadow=true;
  this.key.shadow.mapSize.set(2048,2048);this.key.shadow.radius=4;this.key.shadow.blurSamples=8;scene.add(this.key,this.key.target);
  this.fill=new THREE.DirectionalLight(0xe8f1ff,.08);scene.add(this.fill,this.fill.target);
  scene.add(new THREE.HemisphereLight(0xf6f7f5,0x797a76,.04));
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const context=canvas.getContext('2d'),pixels=context.createImageData(256,256);let seed=19;
  for(let i=0;i<pixels.data.length;i+=4){seed=(1664525*seed+1013904223)>>>0;const v=238+(seed%5)-2;pixels.data.set([v,v,v,255],i);}
  context.putImageData(pixels,0,0);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(1000,1000);texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  this.ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:0xc6c7c7,map:texture,roughness:.94,metalness:0}));
  this.ground.rotation.x=-Math.PI/2;this.ground.receiveShadow=false;scene.add(this.ground);
  this.createContactShadows();this.setEnvironment();
 }
 setEnvironment(hdr=null){
  const studio=new THREE.Scene();studio.background=new THREE.Color(.12,.12,.12);
  if(hdr){
   const sphere=new THREE.Mesh(new THREE.SphereGeometry(20,48,24),new THREE.MeshBasicMaterial({map:hdr,color:new THREE.Color(.23,.23,.23),side:THREE.BackSide}));
   sphere.rotation.y=.6;studio.add(sphere);
  }else{
   const room=new THREE.Mesh(new THREE.BoxGeometry(14,10,14),new THREE.MeshBasicMaterial({color:new THREE.Color(.035,.037,.037),side:THREE.BackSide}));studio.add(room);
  }
  const panel=(p,size,radiance,color=0xffffff)=>{
   const material=new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(radiance),side:THREE.DoubleSide});
   const mesh=new THREE.Mesh(new THREE.PlaneGeometry(...size),material);mesh.position.set(...p);mesh.lookAt(0,0,0);studio.add(mesh);
  };
  // Broad, asymmetric studio panels give polished metal recognizable gradients
  // and long highlights, rather than a uniformly bright white environment.
  // A narrow key reflection leaves a localized glint on convex coated lenses.
  panel([-3.2,3.4,2.6],[.7,3.8],5.0,0xfff5e8);
  panel([3.6,1.3,1.4],[1.2,3.2],.85,0xeaf2ff);
  panel([0,4.6,-1.8],[3.8,.8],2.2);
  panel([-1.4,2.6,-4],[.4,2.8],3.5);
  panel([3.1,.4,-3.5],[1.5,3],.025);
  const generator=new THREE.PMREMGenerator(this.renderer),next=generator.fromScene(studio,.025,.1,50);
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
   void main(){vec2 uv=vec2(vUv.x,1.0-vUv.y);float a=texture2D(nearMap,uv).r*.44+texture2D(softMap,uv).r*.30;
    gl_FragColor=vec4(.035,.033,.030,a);}` }));
  this.contact.rotation.x=-Math.PI/2;this.contact.renderOrder=1;this.scene.add(this.contact);
 }
 fit(box){
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());this.extent=Math.max(size.x,size.y,size.z);
  const e=this.extent,floor=box.min.y-e*.0005,pad=e*.38,width=size.x+2*pad,depth=size.z+2*pad;
  this.ground.position.y=floor;this.contact.position.set(center.x,floor+e*.00015,center.z);this.contact.scale.set(width,depth,1);
  const camera=this.contactCamera;camera.left=-width/2;camera.right=width/2;camera.top=depth/2;camera.bottom=-depth/2;camera.near=e*.0001;camera.far=e*.30;
  camera.position.set(center.x,floor-e*.0001,center.z);camera.lookAt(center.x,floor+1,center.z);camera.updateProjectionMatrix();
  this.key.position.copy(center).add(new THREE.Vector3(-1.5,2.7,1.5).multiplyScalar(e));this.key.target.position.copy(center);
  this.fill.position.copy(center).add(new THREE.Vector3(1.8,1.2,-1.5).multiplyScalar(e));this.fill.target.position.copy(center);
  const shadow=this.key.shadow;shadow.camera.left=shadow.camera.bottom=-e;shadow.camera.right=shadow.camera.top=e;shadow.camera.near=e*.1;shadow.camera.far=e*7;shadow.camera.updateProjectionMatrix();shadow.bias=-.00015;shadow.normalBias=e*.0007;
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
  this.dirty=false;this.lastShadow=performance.now();this.shadowUpdates++;return true;
 }
}
