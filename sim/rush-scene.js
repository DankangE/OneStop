import * as THREE from 'three';
import { targetDefinitions } from './rush.js';

export function createRushTargets(host, mapId) {
  host.rushMeshes = targetDefinitions(mapId).map(target => {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: '#ff427d', emissive: '#f52265', emissiveIntensity: .65, metalness: .4, roughness: .3 });
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(.52), material);
    group.add(core);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(.85, .045, 6, 32), new THREE.MeshBasicMaterial({ color: '#ff739d' }));
    halo.rotation.x = Math.PI / 2; group.add(halo);
    for (const x of [-.65, .65]) for (const z of [-.5, .5]) {
      const rotor = new THREE.Mesh(new THREE.TorusGeometry(.23, .04, 6, 16), material.clone());
      rotor.position.set(x, .05, z); rotor.rotation.x = Math.PI / 2; group.add(rotor);
    }
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.7, .38), host.label('TARGET', 256, 64, '#ffffff', '#8d1746'));
    label.position.y = 1.4; group.add(label); group.userData.label = label;
    const health = new THREE.Group();
    for (const x of [-.24, .24]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(.38, .065), new THREE.MeshBasicMaterial({ color: '#ffebf3', side: THREE.DoubleSide }));
      bar.position.x = x; health.add(bar);
    }
    health.position.y = 1.1; group.add(health); group.userData.health = health;
    group.position.set(...target.position); host.targetGroup.add(group);
    return group;
  });
  host.rushEffects = new Map();
}

function particleBurst(effect, color, count, speed) {
  const positions = new Float32Array(count * 3), velocities = [];
  for (let i = 0; i < count; i++) {
    // Deterministic sphere, no per-frame allocations or random flicker.
    const y = 1 - 2 * (i + .5) / count, angle = i * 2.39996 + effect.id;
    const radius = Math.sqrt(1 - y * y), velocity = speed * (.5 + (i % 7) / 12);
    velocities.push(Math.cos(angle) * radius * velocity, y * velocity, Math.sin(angle) * radius * velocity);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color, size: .16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geometry, material);
  points.position.set(...effect.position); points.frustumCulled = false;
  points.userData.velocities = velocities;
  return points;
}

function createEffect(effect) {
  const group = new THREE.Group();
  if (effect.type === 'beam') {
    const from = new THREE.Vector3(...effect.from), to = new THREE.Vector3(...effect.to);
    const direction = to.clone().sub(from), length = direction.length();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, length, 5), new THREE.MeshBasicMaterial({ color: effect.powered ? '#fff4a8' : '#e8ffff', transparent: true, depthWrite: false }));
    core.position.copy(from).lerp(to, .5);
    if (length > 0) core.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    group.add(core);
    const glow = core.clone(); glow.geometry = core.geometry.clone(); glow.material = core.material.clone();
    glow.scale.set(3, 1, 3); glow.material.color.set(effect.powered ? '#ffc83e' : '#4de9ff');
    glow.material.blending = THREE.AdditiveBlending; group.add(glow);
  } else {
    const color = effect.type === 'burst' ? '#ff649a' : effect.type === 'ring' ? (effect.perfect ? '#fff0a5' : '#ffac63') : effect.type === 'spark' ? (effect.target ? '#ff99be' : '#bcecff') : '#73f6e2';
    group.add(particleBurst(effect, color, effect.type === 'burst' ? 40 : 18, effect.type === 'burst' ? 9 : 4));
    if (effect.type === 'burst' || effect.type === 'ring') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(effect.type === 'ring' ? 2.7 : .55, .045, 5, 48), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.position.set(...effect.position);
      if (effect.normal) ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...effect.normal));
      ring.userData.shockwave = true; group.add(ring);
    }
  }
  return group;
}

export function renderRush(host, session, time) {
  const targets = session?.targets || targetDefinitions(host.mapId);
  host.rushMeshes?.forEach((mesh, index) => {
    const target = targets[index];
    mesh.visible = target.health > 0;
    mesh.position.set(...target.position);
    const flash = Math.max(0, 1 - (time - target.hitAt) / .18);
    mesh.children[0].rotation.set(time * .4, time * 1.6, 0);
    mesh.children[0].material.emissiveIntensity = .65 + flash * 5;
    mesh.children[0].scale.setScalar(1 + flash * .35);
    mesh.children[1].rotation.z = time * 2;
    mesh.userData.label.quaternion.copy(host.camera.quaternion);
    mesh.userData.health.quaternion.copy(host.camera.quaternion);
    mesh.userData.health.children.forEach((bar, i) => { bar.visible = i < target.health; });
  });
  const active = new Set();
  for (const effect of session?.effects || []) {
    active.add(effect.id);
    let mesh = host.rushEffects.get(effect.id);
    if (!mesh) {
      mesh = createEffect(effect);
      host.targetGroup.add(mesh); host.rushEffects.set(effect.id, mesh);
    }
    const age = session.elapsed - effect.time;
    const opacity = Math.max(0, 1 - age / (effect.type === 'beam' ? .1 : effect.type === 'spark' ? .3 : .8));
    mesh.children.forEach(child => {
      child.material.opacity = opacity * (child.material.blending === THREE.AdditiveBlending ? .65 : 1);
      if (child.isPoints) {
        const positions = child.geometry.attributes.position;
        const velocities = child.userData.velocities;
        for (let i = 0; i < positions.count; i++) positions.setXYZ(i, velocities[i * 3] * age, velocities[i * 3 + 1] * age - age * age * 2, velocities[i * 3 + 2] * age);
        positions.needsUpdate = true;
      } else if (child.userData.shockwave) child.scale.setScalar(1 + age * (effect.type === 'ring' ? 1.5 : 12));
    });
  }
  for (const [id, mesh] of host.rushEffects || []) {
    if (active.has(id)) continue;
    mesh.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
    host.targetGroup.remove(mesh); host.rushEffects.delete(id);
  }
}
