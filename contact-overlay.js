// Display the compiled MuJoCo collision shapes independently of the visual mesh.
export class ContactOverlay {
  constructor(T,scene,data){
    this.T=T;this.scene=scene;this.data=data;this.groups=new Map();this.geometries=[];
    this.root=new T.Group();this.root.name='Physics contact shapes';this.root.visible=false;scene.add(this.root);
    this.material=new T.MeshBasicMaterial({color:0xff7b24,wireframe:true,transparent:true,opacity:.8,depthTest:false,depthWrite:false,toneMapped:false});
    this.basis=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),-Math.PI/2);this.inverse=this.basis.clone().invert();
    try{
      for(const item of data.shapes){
        let group=this.groups.get(item.body);
        if(!group){group=new T.Group();group.name='Contact body: '+item.body;this.groups.set(item.body,group);this.root.add(group);}
        const s=item.size;let geometry;
        if(item.type==='box')geometry=new T.BoxGeometry(2*s[0],2*s[2],2*s[1]);
        else if(item.type==='sphere')geometry=new T.SphereGeometry(s[0],20,12);
        else if(item.type==='ellipsoid')geometry=new T.SphereGeometry(1,20,12).scale(s[0],s[2],s[1]);
        else if(item.type==='cylinder')geometry=new T.CylinderGeometry(s[0],s[0],2*s[1],24);
        else if(item.type==='capsule')geometry=new T.CapsuleGeometry(s[0],2*s[1],6,16);
        else if(item.type==='plane')geometry=new T.PlaneGeometry(2*s[0]||1,2*s[1]||1).rotateX(-Math.PI/2);
        else if(item.type==='mesh'){
          geometry=new T.BufferGeometry();
          geometry.setAttribute('position',new T.Float32BufferAttribute(item.vertices.flatMap(([x,y,z])=>[x,z,-y]),3));
          geometry.setIndex(item.faces.flat());geometry.computeVertexNormals();
        }
        else throw Error('Unsupported contact shape '+item.type);
        this.geometries.push(geometry);
        const mesh=new T.Mesh(geometry,this.material);mesh.name=item.name;mesh.userData.physicsOverlay=true;mesh.renderOrder=20;
        mesh.position.set(item.pos[0],item.pos[2],-item.pos[1]);mesh.quaternion.copy(this.orientation(item.quat));group.add(mesh);
      }
    }catch(error){this.dispose();throw error;}
  }
  orientation(q){return this.basis.clone().multiply(new this.T.Quaternion(q[1],q[2],q[3],q[0])).multiply(this.inverse);}
  update(poses){
    for(const [name,group] of this.groups){
      if(name==='world')continue;
      const p=poses?.[name];if(!p){group.visible=false;continue;}
      group.visible=true;group.position.set(p.p[0],p.p[2],-p.p[1]);group.quaternion.copy(this.orientation(p.q));
    }
  }
  dispose(){this.scene.remove(this.root);for(const geometry of this.geometries)geometry.dispose();this.material.dispose();}
}
