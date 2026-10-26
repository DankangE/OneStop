import test from 'node:test';
import assert from 'node:assert/strict';
import { DronePhysics, FIXED_DT } from '../sim/physics.js';
import { ArcadeSession } from '../sim/arcade.js';
import { MAPS, ringDefinitions, crystalDefinitions, sceneryDefinitions, sceneryObstacles } from '../sim/maps.js';
import { crossesRing, hitsObstacle } from '../sim/collision.js';

function airborne() { const d=new DronePhysics();d.reset({altitude:5.26});d.armMotors();return d; }
function cross(session,drone,index=session.ringIndex) {
  const ring=session.rings[index];session.previous=ring.center.map((v,i)=>v-ring.normal[i]);
  drone.position.set(...ring.center.map((v,i)=>v+ring.normal[i]));session.tick(FIXED_DT,drone);
}

test('both map spawn points, rings and crystals are clear of scenery',()=>{
  for(const id of Object.keys(MAPS)) {
    const obstacles=sceneryObstacles(sceneryDefinitions(id));
    assert.ok(obstacles.length>20);
    for(const obstacle of obstacles)assert.equal(hitsObstacle({x:0,y:5.26,z:0},obstacle),false);
    for(const {center} of ringDefinitions(id))for(const obstacle of obstacles)assert.equal(hitsObstacle({x:center[0],y:center[1],z:center[2]},obstacle,2.9),false,`${id} obstructed ring`);
    for(const {position:p} of crystalDefinitions(id))for(const obstacle of obstacles)assert.equal(hitsObstacle({x:p[0],y:p[1],z:p[2]},obstacle,1),false,`${id} obstructed crystal`);
  }
});

test('a ring requires a forward plane crossing through the clear opening',()=>{
  const ring=ringDefinitions('city')[0],c=ring.center;
  assert.ok(crossesRing([c[0],c[1],c[2]+2],[c[0],c[1],c[2]-2],ring));
  assert.equal(crossesRing([c[0],c[1],c[2]-2],[c[0],c[1],c[2]+2],ring),false);
  assert.equal(crossesRing([c[0]+4,c[1],c[2]+2],[c[0]+4,c[1],c[2]-2],ring),false);
  assert.equal(crossesRing([c[0],c[1],c[2]+2],[c[0],c[1],c[2]+.1],ring),false);
});

test('normal flight collects the first crystal and passes the first ring',()=>{
  for(const id of ['city','forest']) {
    const s=new ArcadeSession(id),d=airborne();d.obstacles=[...sceneryObstacles(sceneryDefinitions(id)),...ringDefinitions(id)];
    for(let i=0;i<4.5/FIXED_DT&&!s.finished;i++){d.step(FIXED_DT,{pitch:-1});s.tick(FIXED_DT,d);if(s.ringsPassed)break;}
    assert.equal(s.finished,false,`${id}: ${s.reason}`);assert.equal(s.ringsPassed,1);assert.equal(s.crystalsCollected,1);assert.equal(s.score,125);
  }
});

test('crystal sweep detection catches movement through an item and cannot farm it',()=>{
  const s=new ArcadeSession('city'),d=airborne(),p=s.crystals[0].position;
  s.previous=[p[0]-2,p[1],p[2]];d.position.set(p[0]+2,p[1],p[2]);s.tick(FIXED_DT,d);
  assert.equal(s.score,25);assert.equal(s.crystalsCollected,1);
  for(let i=0;i<5;i++){s.previous=[p[0]-2,p[1],p[2]];d.position.set(p[0]+2,p[1],p[2]);s.tick(FIXED_DT,d);}
  assert.equal(s.score,25);
});

test('future gates cannot be scored out of order and passed gates cannot be farmed',()=>{
  const s=new ArcadeSession('city'),d=airborne();cross(s,d,2);assert.equal(s.ringsPassed,0);
  cross(s,d,0);assert.equal(s.ringsPassed,1);const score=s.score;cross(s,d,0);assert.equal(s.score,score);assert.equal(s.ringIndex,1);
});

test('ring combo increases to three and expires after twelve simulated seconds',()=>{
  const s=new ArcadeSession('city'),d=airborne();
  cross(s,d);assert.equal(s.combo,1);cross(s,d);assert.equal(s.combo,2);cross(s,d);assert.equal(s.combo,3);cross(s,d);assert.equal(s.combo,3);
  s.tick(12.1,d);assert.equal(s.combo,1);cross(s,d);assert.equal(s.combo,1);
});

test('a completed lap resets collectibles and gate order without ending the run',()=>{
  const s=new ArcadeSession('forest'),d=airborne();s.collected.add(0);
  for(let i=0;i<8;i++)cross(s,d);
  assert.equal(s.lap,2);assert.equal(s.ringsPassed,8);assert.equal(s.ringIndex,0);assert.equal(s.collected.size,0);assert.equal(s.finished,false);
  cross(s,d);assert.equal(s.ringsPassed,9);
});

test('ring rim, tree crown and trunk collide while the gate center is passable',()=>{
  const ring=ringDefinitions('city')[0];
  assert.equal(hitsObstacle({x:ring.center[0],y:ring.center[1],z:ring.center[2]},ring),false);
  assert.ok(hitsObstacle({x:ring.center[0]+ring.radius,y:ring.center[1],z:ring.center[2]},ring));
  const obstacles=sceneryObstacles(sceneryDefinitions('forest'));
  for(const type of ['cylinder','sphere']){const o=obstacles.find(o=>o.type===type);assert.ok(hitsObstacle({x:o.center[0],y:o.center[1],z:o.center[2]},o));}
});

test('even a soft ground touch ends arcade, and the final score is frozen',()=>{
  const s=new ArcadeSession('city'),d=airborne();cross(s,d);const score=s.score;
  d.contact={sink:.2};s.tick(FIXED_DT,d);assert.ok(s.finished&&s.crashed);assert.equal(s.score,score);
  d.contact=null;cross(s,d);assert.equal(s.score,score);
});

test('physical obstacle collision ends a run before scoring on that step',()=>{
  const d=airborne(),s=new ArcadeSession('city');d.obstacles=[{type:'sphere',center:[0,5.26,0],radius:1,label:'나무'}];
  d.step(FIXED_DT);s.tick(FIXED_DT,d);assert.ok(d.crashed&&s.crashed&&s.finished);assert.equal(s.score,0);assert.match(s.reason,/나무/);
});
