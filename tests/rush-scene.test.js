import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRushTargets, renderRush } from '../sim/rush-scene.js';
import { RushSession } from '../sim/rush.js';
import { ArcadeFlight } from '../sim/arcade-flight.js';

function scene() {
  return { mapId: 'city', camera: new THREE.PerspectiveCamera(), targetGroup: new THREE.Group(), label: () => new THREE.MeshBasicMaterial() };
}

test('target damage updates the visible health and destroyed targets disappear', () => {
  const host = scene(), session = new RushSession('city');
  createRushTargets(host, 'city');
  session.targets[0].health = 1; session.targets[0].hitAt = 0;
  session.targets[1].health = 0;
  renderRush(host, session, .05);
  assert.equal(host.rushMeshes[0].userData.health.children[0].visible, true);
  assert.equal(host.rushMeshes[0].userData.health.children[1].visible, false);
  assert.equal(host.rushMeshes[1].visible, false);
  assert.ok(host.rushMeshes[0].children[0].material.emissiveIntensity > 1);
});

test('combat particles animate with finite coordinates and expired effects release GPU resources', () => {
  const host = scene(), session = new RushSession('city'), drone = new ArcadeFlight();
  createRushTargets(host, 'city');
  session.shoot(drone);
  for (const type of ['ring', 'burst', 'pickup', 'spark']) session.effect(type, { position: [0, 5, -12], normal: [0, 0, -1], perfect: true });
  session.elapsed = .1; renderRush(host, session, .1);
  assert.equal(host.rushEffects.size, session.effects.length);
  let resourceCount = 0, disposed = 0;
  for (const effect of host.rushEffects.values()) effect.traverse(child => {
    if (child.geometry) {
      assert.ok([...child.geometry.attributes.position.array].every(Number.isFinite));
      child.geometry.addEventListener('dispose', () => disposed++); resourceCount++;
    }
    if (child.material) { child.material.addEventListener('dispose', () => disposed++); resourceCount++; }
  });
  session.effects = []; renderRush(host, session, 1);
  assert.equal(host.rushEffects.size, 0); assert.equal(disposed, resourceCount);
  assert.equal(host.targetGroup.children.length, 4);
});
