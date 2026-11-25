import * as THREE from 'three';

// The same OCIO display transform used by the Blender stills. It consumes
// unexposed, scene-linear Rec.709 and returns encoded sRGB, including exposure.
// Loading is explicit so opening the gallery never downloads these tables.
const base=new URL('./assets/color-grade/',import.meta.url);
let loading=null;

async function read(url,type,signal){
 const response=await fetch(url,{signal});
 if(!response.ok)throw Error('Color grading asset could not load ('+response.status+')');
 return response[type]();
}

async function createColorGrade(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 const owned=[];
 try{
  const manifest=await read(new URL('manifest.json',base),'json',controller.signal);
  if(manifest.version!==1||manifest.textures.length!==2)throw Error('Unsupported color grading assets');
  const [shader,...buffers]=await Promise.all([
   read(new URL(manifest.shader.file,base),'text',controller.signal),
   ...manifest.textures.map(item=>read(new URL(item.file,base),'arrayBuffer',controller.signal))
  ]);
  const uniforms={};
  manifest.textures.forEach((item,index)=>{
   const buffer=buffers[index];
   if(buffer.byteLength!==item.edge**3*3*4)throw Error('Incomplete color grading table');
   const rgb=new Float32Array(buffer),rgba=new Float32Array(item.edge**3*4);
   for(let source=0,dest=0;source<rgb.length;source+=3,dest+=4){rgba[dest]=rgb[source];rgba[dest+1]=rgb[source+1];rgba[dest+2]=rgb[source+2];rgba[dest+3]=1;}
   const texture=new THREE.Data3DTexture(rgba,item.edge,item.edge,item.edge);
   texture.name=item.sampler;texture.type=THREE.FloatType;texture.format=THREE.RGBAFormat;
   texture.minFilter=texture.magFilter=THREE.NearestFilter;
   texture.wrapS=texture.wrapT=texture.wrapR=THREE.ClampToEdgeWrapping;
   texture.unpackAlignment=1;texture.generateMipmaps=false;texture.needsUpdate=true;
   uniforms[item.sampler]={value:texture};owned.push(texture);
  });
  const installed=new WeakSet();
  const attach=material=>{Object.assign(material.uniforms,uniforms);material.toneMapped=false;material.needsUpdate=true;installed.add(material);};
  return {
   metadata:manifest,
   installOutputPass(material){
    if(installed.has(material))return;
    if(!material.isRawShaderMaterial||!material.uniforms.tDiffuse)throw Error('Color grade requires an OutputPass material');
    // OutputPass is RawShaderMaterial. Supply explicit GLSL 3 declarations,
    // while retaining its uniforms object, which OutputPass updates each frame.
    material.glslVersion=THREE.GLSL3;
    material.vertexShader=`precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
    material.fragmentShader=`precision highp float;
precision highp sampler3D;
uniform highp sampler2D tDiffuse;
in vec2 vUv;
out vec4 outputColor;
${shader}
void main(){outputColor=labBlenderAgX(texture(tDiffuse,vUv));}`;
    attach(material);
   },
   installPathDisplay(material){
    if(installed.has(material))return;
    const stage=/#if defined\( TONE_MAPPING \)[\s\S]*?return linearToOutputTexel\( res \);/;
    if(!material.isShaderMaterial||!stage.test(material.fragmentShader))throw Error('Unsupported Photo display material');
    // Grade each radiance texel before the existing clamped bilinear display;
    // do not alter accumulation, denoising, opacity, or edge interpolation.
    material.fragmentShader='precision highp sampler2D;\nprecision highp sampler3D;\n'+shader+'\n'+material.fragmentShader.replace(stage,'return labBlenderAgX( res );');
    attach(material);
   }
  };
 }catch(error){for(const texture of owned)texture.dispose();throw error;}
 finally{clearTimeout(timer);}
}

export function loadColorGrade(){
 if(!loading)loading=createColorGrade().catch(error=>{loading=null;throw error;});
 return loading;
}
