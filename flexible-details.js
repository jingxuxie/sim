// Visual cable bending follows measured joint motion. This does not introduce
// a cable contact or strain model into MuJoCo.
export class FlexibleDetails {
  constructor(THREE){this.T=THREE;this.parts=[];}
  attach(root){
    const T=this.T;this.parts=[];root.updateMatrixWorld(true);
    root.traverse(mesh=>{
      const data=mesh.userData;
      if(!mesh.isMesh||!(data.flex_joint||data.flex_joints||data.flex_rotation)||!data.flex_path_m)return;
      const path=data.flex_path_m.map(p=>new T.Vector3(p[0],p[2],-p[1]));
      const lengths=[0];for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+path[i].distanceTo(path[i-1]));
      const position=mesh.geometry.getAttribute('position'),rest=Float32Array.from(position.array),weights=new Float32Array(position.count);
      const point=new T.Vector3(),segment=new T.Vector3(),delta=new T.Vector3(),nearest=new T.Vector3();
      const [lo,hi]=data.flex_weight_window||[0,1];
      for(let i=0;i<position.count;i++){
        point.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld);
        let best=Infinity,arc=0;
        for(let j=0;j<path.length-1;j++){
          segment.subVectors(path[j+1],path[j]);delta.subVectors(point,path[j]);
          const u=Math.max(0,Math.min(1,delta.dot(segment)/segment.lengthSq()));
          nearest.copy(path[j]).addScaledVector(segment,u);const distance=point.distanceToSquared(nearest);
          if(distance<best){best=distance;arc=lengths[j]+u*(lengths[j+1]-lengths[j]);}
        }
        const u=Math.max(0,Math.min(1,(arc/lengths.at(-1)-lo)/(hi-lo)));weights[i]=u*u*(3-2*u);
      }
      const inverse=new T.Matrix4().copy(mesh.matrixWorld).invert();
      const origin=new T.Vector3().applyMatrix4(inverse);
      const inputs=(data.flex_joints||(data.flex_joint?[{name:data.flex_joint,axis:data.flex_axis||[0,0,1]}]:[])).map(({name,axis})=>({
        joint:name,axis:new T.Vector3(axis[0],axis[2],-axis[1]).applyMatrix4(inverse).sub(origin),value:NaN
      }));
      let rotation=null;
      if(data.flex_rotation){
        const r=data.flex_rotation;
        if(r.weight_mode!=='angle'||!r.joints?.length)throw Error('Invalid rotating cable metadata: '+mesh.name);
        const axis=new T.Vector3(r.axis[0],r.axis[2],-r.axis[1]);
        if(axis.lengthSq()<1e-12)throw Error('Invalid rotating cable axis: '+mesh.name);
        rotation={joints:r.joints,axis:axis.normalize(),pivot:new T.Vector3(r.pivot_m[0],r.pivot_m[2],-r.pivot_m[1]),
          world:mesh.matrixWorld.clone(),inverse:inverse.clone(),point:new T.Vector3(),value:NaN};
      }
      this.parts.push({mesh,position,rest,weights,inputs,rotation,displacement:new T.Vector3()});
    });
  }
  update(joints={}){
    let changed=false;
    for(const part of this.parts){
      const {position,rest,weights,inputs,rotation,displacement,mesh}=part;
      if(inputs.some(input=>!Number.isFinite(joints[input.joint])))continue;
      if(rotation?.joints.some(name=>!Number.isFinite(joints[name])))continue;
      const angle=rotation?rotation.joints.reduce((sum,name)=>sum+joints[name],0):0;
      if(inputs.every(input=>Math.abs(joints[input.joint]-input.value)<1e-7)&&(!rotation||Math.abs(angle-rotation.value)<1e-7))continue;
      displacement.set(0,0,0);
      for(const input of inputs){input.value=joints[input.joint];displacement.addScaledVector(input.axis,input.value);}
      if(rotation)rotation.value=angle;
      for(let i=0;i<position.count;i++){
        if(rotation){
          // Rotate through a weighted angle, then translate. Interpolating
          // endpoint displacement would cut through the stage at half a turn.
          // Native-world metadata is converted once into Three's coordinates;
          // world-space rotation also handles nonuniform mesh transforms.
          const p=rotation.point.set(rest[3*i],rest[3*i+1],rest[3*i+2]).applyMatrix4(rotation.world);
          p.sub(rotation.pivot).applyAxisAngle(rotation.axis,angle*weights[i]).add(rotation.pivot)
            .applyMatrix4(rotation.inverse).addScaledVector(displacement,weights[i]);
          position.setXYZ(i,p.x,p.y,p.z);
        }else position.setXYZ(i,rest[3*i]+displacement.x*weights[i],rest[3*i+1]+displacement.y*weights[i],rest[3*i+2]+displacement.z*weights[i]);
      }
      position.needsUpdate=true;mesh.geometry.computeVertexNormals();mesh.geometry.computeBoundingSphere();mesh.geometry.computeBoundingBox();changed=true;
    }
    return changed;
  }
}
