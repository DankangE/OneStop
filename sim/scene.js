import * as THREE from 'three';
import { GROUND } from './physics.js';
import { WAYPOINTS } from './training.js';
import { MAPS } from './maps.js';
import { buildArcadeWorld, createArcadeTargets } from './arcade-scene.js';
import { createRushTargets, renderRush } from './rush-scene.js';

const random = (n) => { const value = Math.sin(n * 127.1 + 81.7) * 43758.5453; return value - Math.floor(value); };

export class FlightScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a5ddfb');
    this.scene.fog = new THREE.Fog('#c7e9ff', 100, 280);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.mapId = 'training';
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.06, 650);
    this.camera.position.set(8, 6, 10);
    this.obstacles = [];
    this.materials = new Map();
    this.rotors = [];
    this.cameraMode = 'chase';
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cameraInitialized = false;
    this.impact = 0;
    this.cameraBank = 0;
    this.tracePoints = [];
    this.scene.add(new THREE.HemisphereLight('#edf8ff', '#789d9a', 2.25));
    const sun = new THREE.DirectionalLight('#fff6e8', 3.0);
    sun.position.set(-35, 58, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 180 });
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun);
    this.buildField();
    this.batchScenery();
    this.drone = this.buildDrone();
    this.scene.add(this.drone);
    this.targetGroup = new THREE.Group();
    this.scene.add(this.targetGroup);
    this.trajectory = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#90eaff', transparent: true, opacity: 0.7 }));
    this.scene.add(this.trajectory);
    this.windSock = this.buildWindSock();
    this.setLesson('hover');
  }

  material(color, options = {}) {
    const key = color + JSON.stringify(options);
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.83, ...options }));
    return this.materials.get(key);
  }

  box(x, y, z, width, height, depth, color, { collision = false, parent = this.world, ...material } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), this.material(color, material));
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh);
    if (collision) this.obstacles.push({ min: { x: x - width / 2, y: y - height / 2, z: z - depth / 2 }, max: { x: x + width / 2, y: y + height / 2, z: z + depth / 2 } });
    return mesh;
  }

  label(text, width = 512, height = 128, color = '#e3ebd5', background = 'transparent') {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
    ctx.fillStyle = color; ctx.font = `600 ${height * 0.53}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, width / 2, height / 2);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  }

  groundLabel(text, x, z, w, h, color = '#d8dfc5', y = 0.045) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.label(text, 1024, 180, color));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, z); this.world.add(mesh); return mesh;
  }

  buildField() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), this.material('#728068'));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.position.y = -0.035; this.world.add(ground);
    this.box(0, -0.015, 0, 46, 0.04, 55, '#7c857b');
    const grid = new THREE.GridHelper(44, 22, '#b0b7a1', '#9ea895'); grid.position.y = 0.025; grid.material.transparent = true; grid.material.opacity = 0.24; this.world.add(grid);
    for (const x of [-22.5, 22.5]) this.box(x, 0.024, 0, 0.08, 0.015, 54, '#d4cfa7');
    for (const z of [-27, 27]) this.box(0, 0.024, z, 45, 0.015, 0.08, '#d4cfa7');
    for (let i = -5; i <= 5; i++) { this.box(i * 4, 0.03, 26, 0.05, 0.02, 1.1, '#d4cfa7'); }
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.03, 64), this.material('#454f43'));
    pad.position.set(0, 0.018, 0); pad.receiveShadow = true; this.world.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.045, 8, 80), this.material('#ecaa76'));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.04; this.world.add(ring);
    this.groundLabel('H', 0, 0, 2, 1.8, '#edb386', 0.048);
    this.groundLabel('AIRFRAME', 0, 18, 14, 2.7, '#c2c9b4');
    this.groundLabel('TRAINING ZONE  /  01', 0, 21, 10, 1.3, '#b0bba4');
    this.groundLabel('N', 0, -24, 1.5, 1.3, '#ece6c6');
    for (let i = 0; i < 20; i++) {
      const side = i % 2 ? -1 : 1, z = -24 + Math.floor(i / 2) * 5.4;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.65, 12), this.material('#d9784f'));
      cone.position.set(side * 21, 0.325, z); cone.castShadow = true; this.world.add(cone);
      this.box(side * 21, 0.03, z, 0.5, 0.06, 0.5, '#424b40');
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.11, 0.12, 12), this.material('#eadbc1')); band.position.set(side * 21, 0.34, z); this.world.add(band);
    }
    // Training obstacles are outside the initial practice volume.
    this.box(-34, 4, -12, 13, 8, 24, '#828d7e', { collision: true });
    this.box(-34, 8.12, -12, 13.7, 0.25, 24.7, '#576653');
    for (let i = 0; i < 5; i++) this.box(-27.46, 3.2, -21 + i * 4.5, 0.03, 5, 3.2, '#3a4b44');
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(11, 1.6), this.label('FLIGHT LAB', 1024, 160)); sign.position.set(-34, 6, 0.04); this.world.add(sign);
    for (let i = 0; i < 3; i++) {
      this.box(31, 1.35, -17 + i * 6, 8, 2.7, 4, ['#668376', '#af9570', '#8d9a80'][i], { collision: true });
      for (let n = 0; n < 10; n++) this.box(27.01, 1.35, -18.6 + i * 6 + n * 0.35, 0.025, 2.5, 0.04, '#546b5b');
    }
    // Fence, trees, and a distant city establish scale and motion cues.
    for (let i = 0; i < 29; i++) {
      const x = -56 + i * 4;
      this.box(x, 1.0, -39, 0.07, 2, 0.07, '#56664f');
      this.box(x + 2, 0.9, -39, 4, 0.025, 0.025, '#7e8c74');
      this.box(x + 2, 1.6, -39, 4, 0.025, 0.025, '#7e8c74');
    }
    for (let i = 0; i < 95; i++) {
      const x = (random(i + 5) - 0.5) * 230, z = -55 - random(i + 80) * 125;
      const h = 5 + random(i + 24) * 7;
      this.box(x, h * 0.3, z, 0.4, h * 0.6, 0.4, '#6d6c4b');
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.33, 0), this.material(['#5c7657', '#6c805c', '#829069'][i % 3]));
      crown.position.set(x, h * 0.72, z); crown.scale.y = 1.3; crown.castShadow = true; this.world.add(crown);
    }
    for (let i = 0; i < 34; i++) {
      const x = (i - 17) * 13, z = -170 - random(i + 68) * 35, h = 12 + random(i + 99) * 40;
      this.box(x, h / 2, z, 9, h, 12, '#a0afa2');
      for (let f = 3; f < h; f += 4) this.box(x, f, z + 6.05, 8, 0.45, 0.1, '#7e988c');
    }
  }

  buildDrone() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.18, 5, 12), this.material('#d6dcc9', { metalness: 0.25, roughness: 0.45 }));
    body.rotation.x = Math.PI / 2; body.scale.x = 1.25; group.add(body);
    this.box(0, 0.085, 0.02, 0.19, 0.035, 0.23, '#303d34', { parent: group });
    this.box(0, 0.105, 0.02, 0.02, 0.008, 0.2, '#e88653', { parent: group });
    for (const x of [-0.24, 0.24]) for (const z of [-0.24, 0.24]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.027, Math.hypot(x, z), 8), this.material('#39493d', { metalness: 0.3 }));
      arm.position.set(x / 2, -0.015, z / 2); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, 0, z).normalize()); arm.castShadow = true; group.add(arm);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.036, 0.075, 16), this.material('#303c35', { metalness: 0.6 }));
      motor.position.set(x, 0.012, z); motor.castShadow = true; group.add(motor);
      const rotor = new THREE.Group(); rotor.position.set(x, 0.063, z);
      const blade = this.box(0, 0, 0, 0.35, 0.007, 0.032, z < 0 ? '#e0a576' : '#7e947d', { parent: rotor }); blade.rotation.y = x * 7;
      const blur = new THREE.Mesh(new THREE.CircleGeometry(0.177, 24), new THREE.MeshBasicMaterial({ color: '#d4dfc2', transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
      blur.rotation.x = -Math.PI / 2; blur.position.y = 0.005; rotor.add(blur);
      this.rotors.push({ group: rotor, blur }); group.add(rotor);
      this.box(x, -0.105, z, 0.019, 0.2, 0.019, '#414f42', { parent: group });
      this.box(x, -0.205, z, 0.065, 0.025, 0.10, '#343f34', { parent: group });
      this.box(x, -0.036, z < 0 ? z - 0.037 : z + 0.037, 0.018, 0.018, 0.006, z < 0 ? '#ff8159' : '#b1eb8b', { parent: group, emissive: z < 0 ? '#ff633f' : '#96e267', emissiveIntensity: 2 });
    }
    const camera = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), this.material('#24372f', { metalness: 0.5, roughness: 0.25 })); camera.position.set(0, -0.075, -0.22); group.add(camera);
    return group;
  }

  batchScenery() {
    // Repeated buildings, fence rails, markings, and trunks share draw calls.
    const groups = new Map();
    for (const mesh of this.world.children) {
      if (!mesh.isMesh || mesh.geometry.type !== 'BoxGeometry') continue;
      if (!groups.has(mesh.material)) groups.set(mesh.material, []);
      groups.get(mesh.material).push(mesh);
    }
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const matrix = new THREE.Matrix4();
    for (const [material, meshes] of groups) {
      const instances = new THREE.InstancedMesh(geometry, material, meshes.length);
      instances.castShadow = true; instances.receiveShadow = true;
      meshes.forEach((mesh, index) => {
        const { width, height, depth } = mesh.geometry.parameters;
        matrix.compose(mesh.position, mesh.quaternion, mesh.scale.clone().multiply(new THREE.Vector3(width, height, depth)));
        instances.setMatrixAt(index, matrix);
        this.world.remove(mesh); mesh.geometry.dispose();
      });
      instances.computeBoundingSphere(); this.world.add(instances);
    }
  }

  buildWindSock() {
    const group = new THREE.Group(); group.position.set(19, 0, -25);
    this.box(0, 3, 0, 0.07, 6, 0.07, '#ced3ba', { parent: group });
    const sock = new THREE.Group(); sock.position.y = 5.8; group.add(sock);
    for (let i = 0; i < 5; i++) {
      const section = new THREE.Mesh(new THREE.CylinderGeometry(0.23 - i * 0.032, 0.198 - i * 0.032, 0.24, 12, 1, true), this.material(i % 2 ? '#e8dfc2' : '#e28e5c', { side: THREE.DoubleSide }));
      section.rotation.z = Math.PI / 2; section.position.x = i * 0.24; sock.add(section);
    }
    this.world.add(group); return sock;
  }

  disposeTarget() {
    for (const child of [...this.targetGroup.children]) {
      child.traverse((mesh) => { if (mesh.geometry) mesh.geometry.dispose(); if (mesh.material && ![...this.materials.values()].includes(mesh.material)) { mesh.material.map?.dispose(); mesh.material.dispose(); } });
      this.targetGroup.remove(child);
    }
  }

  setMap(id) {
    if (this.mapId === id) return;
    const geometries=new Set(), materials=new Set();
    this.world.traverse(node=>{if(node.geometry)geometries.add(node.geometry);if(node.material)materials.add(node.material);});
    geometries.forEach(geometry=>geometry.dispose());
    materials.forEach(material=>{if(![...this.materials.values()].includes(material)){material.map?.dispose();material.dispose();}});
    this.scene.remove(this.world);this.world=new THREE.Group();this.scene.add(this.world);this.obstacles=[];this.windSock=null;
    this.mapId=id;
    if(id==='training'){this.buildField();this.windSock=this.buildWindSock();}
    else buildArcadeWorld(this,id);
    this.batchScenery();this.cameraInitialized=false;
    this.scene.background.set(id==='training'?'#a5ddfb':MAPS[id].sky);
  }

  setArcade(id) { this.setMap(id); createArcadeTargets(this,id); createRushTargets(this,id); this.impact = 0; this.cameraBank = 0; }

  feedback(type) {
    const strength = { shot: .025, hit: .04, target: .12, ring: .06, damage: .3, overdrive: .16 }[type] || 0;
    this.impact = Math.max(this.impact, strength);
  }

  setLesson(lesson) {
    this.lesson = lesson; this.disposeTarget(); this.targets = [];
    const points = lesson === 'square' ? WAYPOINTS : lesson === 'landing' ? [[0, 0.15, 0]] : lesson === 'free' ? [] : [[0, 5, 0]];
    points.forEach(([x, y, z], i) => {
      const target = new THREE.Group(); target.position.set(x, y + GROUND, z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.022, 8, 80), new THREE.MeshBasicMaterial({ color: '#ffab72', transparent: true, opacity: 0.9 })); ring.rotation.x = Math.PI / 2; target.add(ring);
      const ring2 = ring.clone(); ring2.material = ring.material.clone(); ring2.position.y = 0.5; ring2.material.opacity = 0.38; target.add(ring2);
      for (let n = 0; n < 4; n++) {
        const a = n * Math.PI / 2;
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a) * 1.5, -y, Math.sin(a) * 1.5), new THREE.Vector3(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5)]);
        const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: '#e5c49b', dashSize: 0.16, gapSize: 0.20, transparent: true, opacity: 0.28 })); line.computeLineDistances(); target.add(line);
      }
      this.targetGroup.add(target); this.targets.push(target);
    });
    if (lesson === 'square') {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([[0, 5, 0], ...WAYPOINTS].map(([x, y, z]) => new THREE.Vector3(x, y + GROUND, z))), new THREE.LineDashedMaterial({ color: '#e8bb86', dashSize: 0.4, gapSize: 0.4, transparent: true, opacity: 0.5 })); line.computeLineDistances(); this.targetGroup.add(line);
    }
    this.clearTrail(); this.cameraInitialized = false;
  }

  clearTrail() { this.tracePoints = []; this.trajectory.geometry.dispose(); this.trajectory.geometry = new THREE.BufferGeometry(); }

  addTrail(position) {
    this.tracePoints.push(position.clone());
    if (this.tracePoints.length > 1200) this.tracePoints.shift();
    this.trajectory.geometry.dispose(); this.trajectory.geometry = new THREE.BufferGeometry().setFromPoints(this.tracePoints);
  }

  resize(width, height) { this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); }

  render(drone, session, dt, running, time) {
    this.drone.position.copy(drone.position); this.drone.quaternion.copy(drone.quaternion);
    this.rotors.forEach((rotor, index) => {
      rotor.group.rotation.y += (index % 2 ? 1 : -1) * (running ? 8 + Math.sqrt(drone.motors[index]) * 100 : 0) * dt;
      rotor.blur.visible = running && drone.armed && drone.throttle > 0.08;
    });
    const p = drone.position;
    const mode = running ? this.cameraMode : 'preview';
    this.drone.visible = mode !== 'fpv';
    const yaw = drone.angles.y;
    let position, look;
    const arcade = this.lesson === 'arcade';
    const targetFov = arcade ? (drone.focusing ? 52 : drone.boosting && !this.reducedMotion ? 89 : 74) : 58;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 10));
    this.camera.updateProjectionMatrix();
    if (arcade && (mode === 'fpv' || mode === 'chase')) {
      const aim = drone.aimDirection;
      position = mode === 'fpv' ? p.clone().add(new THREE.Vector3(0, .12, 0)) : p.clone().addScaledVector(aim, -4.5).add(new THREE.Vector3(0, 1.15, 0));
      // Keep aim synchronous with mouse input; lag here makes shooting swim.
      this.camera.position.copy(position);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(p.clone().addScaledVector(aim, 25));
      this.cameraBank += ((this.reducedMotion ? 0 : drone.angles.z * .12) - this.cameraBank) * (1 - Math.exp(-dt * 8));
      this.camera.rotateZ(this.cameraBank);
      this.impact *= Math.exp(-dt * 17);
      if (!this.reducedMotion) {
        this.camera.position.x += Math.sin(time * 91) * this.impact;
        this.camera.position.y += Math.cos(time * 113) * this.impact * .6;
      }
      this.cameraInitialized = true;
    } else if (mode === 'fpv') {
      const offset = new THREE.Vector3(0, 0.05, -0.27).applyQuaternion(drone.quaternion);
      this.camera.position.copy(p).add(offset); this.camera.quaternion.copy(drone.quaternion);
    } else {
      if (mode === 'observer') {
        position = new THREE.Vector3(16, 4.5, 20); look = p.clone();
      } else if (mode === 'chase') {
        position = new THREE.Vector3(Math.sin(yaw) * 5, 2.4, Math.cos(yaw) * 5).add(p);
        look = p.clone().add(new THREE.Vector3(-Math.sin(yaw) * 1.4, -0.1, -Math.cos(yaw) * 1.4));
      } else {
        position = this.mapId==='training'?new THREE.Vector3(7.8,5.8,10.4):new THREE.Vector3(5,9,12);
        look = this.mapId==='training'?new THREE.Vector3(0,1.2,-1):new THREE.Vector3(0,5,-8);
      }
      if (!this.cameraInitialized) this.camera.position.copy(position);
      else this.camera.position.lerp(position, 1 - Math.exp(-dt * 7));
      this.camera.position.y = Math.max(0.5, this.camera.position.y);
      this.camera.up.set(0, 1, 0); this.camera.lookAt(look); this.cameraInitialized = true;
    }
    if(this.lesson==='arcade') {
      renderRush(this, session, session?.elapsed || time);
      this.drone.visible = mode !== 'fpv' && (!(drone.immunity > 0) || Math.sin(time * 28) > -.2);
      this.targets.forEach((target,i)=>{
        const current = i === (session?.ringIndex || 0);
        target.visible = i >= (session?.ringIndex || 0);
        target.children[0].material.emissiveIntensity = current ? 1.6 + Math.sin(time * 4) * .35 : .15;
        target.userData.center.visible = current;
      });
      this.routeSegments?.forEach((line, i) => { line.visible = i === (session?.ringIndex || 0) || i === ((session?.ringIndex || 0) + 1) % 8; });
      this.crystalMeshes.forEach((gem,i)=>{gem.visible=!session?.collected.has(i);gem.rotation.y=time*.9;});
    } else if (session) this.targets.forEach((target, i) => { target.visible = this.lesson !== 'square' || i >= session.stage; });
    if(this.windSock) {
      this.windSock.rotation.y = Math.atan2(-drone.wind.z, drone.wind.x || 0.01);
      this.windSock.rotation.z = -0.5 / (1 + drone.windSpeed) + (drone.gusts ? Math.sin(time * 2.5) * 0.08 : 0);
    }
    this.renderer.render(this.scene, this.camera);
  }

  projectTarget(target) {
    const position = new THREE.Vector3(target[0], target[1] + GROUND + 0.8, target[2]);
    const relative = position.clone().sub(this.camera.position);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const behind = relative.dot(forward) < 0;
    position.project(this.camera);
    return { x: (position.x + 1) / 2, y: (1 - position.y) / 2, visible: !behind && Math.abs(position.x) < 0.95 && Math.abs(position.y) < 0.9 };
  }

  projectPoint(point) {
    const p = new THREE.Vector3(...point).project(this.camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
  }
}
