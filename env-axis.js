import * as THREE from 'three';

// glTF carries the source Blender anisotropy value verbatim. Convert the
// source GGX axes before Three's bent-normal IBL approximation; do not change
// the public material parameters or the scalar split-sum energy response.
export function correctEnvironmentAxes(source){
 return source.replace(
  'vec3 bentNormal = cross( bitangent, viewDir );',
  `float aspect=sqrt(max(.1,1.0-.9*anisotropy));
   float alphaB=roughness*roughness*aspect,alphaT=roughness*roughness/aspect;
   float probeRoughness=sqrt(alphaB);
   float probeAnisotropy=sqrt(clamp((alphaT-alphaB)/max(1.0-alphaB,1e-5),0.0,1.0));
   vec3 bentNormal = cross( bitangent, viewDir );`)
  .replace('1.0 - anisotropy * ( 1.0 - roughness )','1.0 - probeAnisotropy * ( 1.0 - probeRoughness )')
  .replace('return getIBLRadiance( viewDir, bentNormal, roughness );','return getIBLRadiance( viewDir, bentNormal, probeRoughness );');
}

export function installEnvironmentAxisDiagnostic(material){
 const before=material.onBeforeCompile,key=material.customProgramCacheKey();
 material.customProgramCacheKey=()=>key+'|source-environment-axes-v1';
 material.onBeforeCompile=(shader,renderer)=>{
  before.call(material,shader,renderer);
  shader.fragmentShader=shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>',correctEnvironmentAxes(THREE.ShaderChunk.envmap_physical_pars_fragment));
 };
 material.needsUpdate=true;
}
