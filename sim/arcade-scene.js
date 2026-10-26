import * as THREE from 'three';
import { MAPS, sceneryDefinitions, sceneryObstacles, ringDefinitions, crystalDefinitions } from './maps.js';

export function buildArcadeWorld(host,id) {
  const map=MAPS[id],data=sceneryDefinitions(id);
  host.obstacles=sceneryObstacles(data);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(700,700),host.material(map.ground));
  ground.rotation.x=-Math.PI/2;ground.position.y=-.03;ground.receiveShadow=true;host.world.add(ground);
  if(id==='city') {
    for(const x of [0,30,-29])host.box(x,0,-10,12,.035,140,'#69859c');
    for(const z of [-28,12,48])host.box(8,.004,z,145,.04,12,'#69859c');
    for(const x of [-6.3,6.3,23.7,36.3])host.box(x,.025,-10,.3,.025,135,'#eaf3f7');
    for(let z=-65;z<=65;z+=7)for(const x of [0,30])host.box(x,.031,z,.14,.015,3,'#fff3b3');
    for(const z of [-36,-20,4,20])for(let n=-4;n<=4;n++)host.box(n,.04,z,.55,.02,2.2,'#f3f8fb');
    for(const b of data.buildings) {
      host.box(b.x,b.h/2,b.z,b.w,b.h,b.d,b.color);
      host.box(b.x,b.h+.16,b.z,b.w+.3,.32,b.d+.3,'#ecf3f9');
      host.box(b.x,b.h+.55,b.z,2.2,.8,2.1,'#9bb6ce',{collision:true});
      host.box(b.x,.2,b.z,b.w+1,.3,b.d+1,'#c4d3e2',{collision:true});
      for(let floor=2.4;floor<b.h-1;floor+=3) {
        for(const sign of [-1,1]) {
          host.box(b.x,floor,b.z+sign*(b.d/2+.02),b.w-1.6,1.25,.04,'#638cae',{metalness:.3,roughness:.35});
          host.box(b.x+sign*(b.w/2+.02),floor,b.z,.04,1.25,b.d-1.6,'#75a7c3',{metalness:.3,roughness:.35});
        }
      }
      // Colorful awnings make ground-level streets read differently from rooftops.
      const awningColor=b.color==='#f3c1a5'?'#f98b63':'#60bad4';
      host.box(b.x,2.4,b.z+b.d/2+.5,b.w-1,.2,1.0,awningColor,{collision:true});
    }
    for(const c of data.cars) {
      host.box(c.x,.55,c.z,1.8,.9,3.6,c.color);
      host.box(c.x,1.12,c.z,1.55,.65,1.8,'#d6eff8');
      for(const x of [-.88,.88])for(const z of [-1.1,1.1])host.box(c.x+x,.33,c.z+z,.16,.5,.65,'#344962');
    }
    host.groundLabel('SKYLINE',0,4,5.5,1.2,'#edf7ff');
  } else {
    const route=[[0,5,0],...map.rings,map.rings[0]];
    for(let i=1;i<route.length;i++) {
      const a=route[i-1],b=route[i],length=Math.hypot(b[0]-a[0],b[2]-a[2]);
      const path=host.box((a[0]+b[0])/2,.01,(a[2]+b[2])/2,5.8,.025,length+1.5,'#ddce9f');
      path.rotation.y=Math.atan2(b[0]-a[0],b[2]-a[2]);
    }
    const stream=host.box(48,-.001,0,12,.025,170,'#48bbec');stream.rotation.y=-.24;
    host.box(55,.013,0,2,.025,170,'#d9dfa6').rotation.y=-.24;
    for(let i=0;i<7;i++) {
      const hill=new THREE.Mesh(new THREE.ConeGeometry(30+i%3*8,18+i%2*13,7),host.material(i%2?'#74c29b':'#9ad8b3'));
      hill.position.set(-100+i*33,8,-100-i%2*20);host.world.add(hill);
    }
    for(const r of data.rocks) {
      const rock=new THREE.Mesh(new THREE.IcosahedronGeometry(r.r,1),host.material('#aac0d3'));
      rock.position.set(r.x,r.r*.6,r.z);rock.castShadow=true;rock.receiveShadow=true;host.world.add(rock);
    }
  }
  for(const [i,t] of data.trees.entries()) {
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.19,.27,t.h*.64,8),host.material('#a77c57'));
    trunk.position.set(t.x,t.h*.32,t.z);trunk.castShadow=true;host.world.add(trunk);
    const foliage=new THREE.Mesh(new THREE.IcosahedronGeometry(t.r,1),host.material(['#38a978','#61c47b','#a1cf69','#4fbb9c'][i%4]));
    foliage.position.set(t.x,t.h*.66,t.z);foliage.castShadow=true;foliage.receiveShadow=true;host.world.add(foliage);
  }
  const pad=new THREE.Mesh(new THREE.CircleGeometry(2.5,48),host.material('#e4f1ef'));
  pad.rotation.x=-Math.PI/2;pad.position.y=.065;pad.receiveShadow=true;host.world.add(pad);
  host.groundLabel('H',0,0,2,1.8,'#309fba',.072);
}

export function createArcadeTargets(host,id) {
  host.disposeTarget();host.targets=[];host.crystalMeshes=[];host.lesson='arcade';
  host.routeSegments = [];
  for(const ring of ringDefinitions(id)) {
    const group=new THREE.Group();group.position.set(...ring.center);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),new THREE.Vector3(...ring.normal));
    const material=new THREE.MeshStandardMaterial({color:'#ff8a3c',emissive:'#ff731b',emissiveIntensity:.65,roughness:.3});
    const tube=new THREE.Mesh(new THREE.TorusGeometry(ring.radius,ring.tube,10,64),material);tube.castShadow=true;group.add(tube);
    const inner=new THREE.Mesh(new THREE.TorusGeometry(ring.radius-.04,.026,6,64),new THREE.MeshBasicMaterial({color:'#fff3bb'}));inner.position.z=.13;group.add(inner);
    const center = new THREE.Mesh(new THREE.RingGeometry(1.02, 1.045, 48), new THREE.MeshBasicMaterial({color:'#fff4bd', side:THREE.DoubleSide, transparent:true, opacity:.5, depthWrite:false}));
    group.add(center); group.userData.center = center;
    const plate=new THREE.Mesh(new THREE.PlaneGeometry(1.15,.4),host.label(String(ring.id+1).padStart(2,'0'),128,64,'#ffffff','#fa7a33'));plate.position.y=ring.radius+.45;plate.rotation.y=Math.PI;group.add(plate);
    host.targetGroup.add(group);host.targets.push(group);
    const previous = MAPS[id].rings[(ring.id + 7) % 8];
    const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(previous[0], previous[1] + .26, previous[2]), new THREE.Vector3(...ring.center)
    ]), new THREE.LineDashedMaterial({color:'#d6ffff', dashSize:.55, gapSize:1.1, transparent:true, opacity:.3, depthWrite:false}));
    guide.computeLineDistances(); host.targetGroup.add(guide); host.routeSegments.push(guide);
  }
  for(const crystal of crystalDefinitions(id)) {
    const group=new THREE.Group();group.position.set(...crystal.position);
    const gem=new THREE.Mesh(new THREE.OctahedronGeometry(.52),new THREE.MeshStandardMaterial({color:'#59dfff',emissive:'#11a8df',emissiveIntensity:.55,metalness:.25,roughness:.25}));
    group.add(gem);
    const outline=new THREE.LineSegments(new THREE.EdgesGeometry(gem.geometry),new THREE.LineBasicMaterial({color:'#c7f8ff'}));group.add(outline);
    host.targetGroup.add(group);host.crystalMeshes.push(group);
  }
  host.clearTrail();host.cameraInitialized=false;
}
