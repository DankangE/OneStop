import { MAPS, ringDefinitions, crystalDefinitions } from './maps.js';
import { crossesRing, segmentDistanceSquared } from './collision.js';

export class ArcadeSession {
  constructor(mapId,mode='position',wind=0,gusts=false) {
    this.mapId=mapId;this.mode=mode;this.wind=wind;this.gusts=gusts;
    this.elapsed=0;this.score=0;this.ringIndex=0;this.ringsPassed=0;this.crystalsCollected=0;
    this.lap=1;this.combo=1;this.lastRingTime=-Infinity;this.maxCombo=1;
    this.rings=ringDefinitions(mapId);this.crystals=crystalDefinitions(mapId);this.collected=new Set();
    this.previous=[0,5.26,0];this.target=MAPS[mapId].rings[0];this.progress=0;
    this.finished=false;this.passed=false;this.crashed=false;this.reason='';this.events=[];
    this.samples=[];this.sampleTimer=0;this.maxSpeed=0;this.assistance=0;this.wasRescue=false;
    this.hint='↑로 앞으로 날아가세요. 주황색 링을 통과하고 파란 크리스털을 모으세요.';
  }

  tick(dt,drone,input={}) {
    if(this.finished)return;
    this.elapsed+=dt;
    const current=drone.position.toArray();
    this.maxSpeed=Math.max(this.maxSpeed,drone.velocity.length());
    if(input.rescue&&!this.wasRescue)this.assistance++;
    this.wasRescue=!!input.rescue;
    if(drone.crashed || drone.contact || drone.grounded) {
      this.crashed=true;this.finish(false,drone.crashed?drone.crashReason:'지면에 닿았습니다. 다음에는 고도를 조금 더 확보하세요.');return;
    }
    if(this.elapsed-this.lastRingTime>12)this.combo=1;
    for(const crystal of this.crystals) {
      if(!this.collected.has(crystal.id)&&segmentDistanceSquared(this.previous,current,crystal.position)<1.0**2) {
        this.collected.add(crystal.id);this.crystalsCollected++;this.score+=25;
        this.events.push({type:'crystal',points:25});
      }
    }
    if(crossesRing(this.previous,current,this.rings[this.ringIndex])) {
      this.combo=this.elapsed-this.lastRingTime<=12?Math.min(3,this.combo+1):1;
      this.lastRingTime=this.elapsed;this.maxCombo=Math.max(this.maxCombo,this.combo);
      const points=100*this.combo;this.score+=points;this.ringsPassed++;this.ringIndex++;
      this.events.push({type:'ring',points,combo:this.combo});
      if(this.ringIndex===this.rings.length) {this.ringIndex=0;this.lap++;this.collected.clear();this.events.push({type:'lap',lap:this.lap});}
      this.target=MAPS[this.mapId].rings[this.ringIndex];
    }
    this.progress=this.ringIndex/this.rings.length;
    this.previous=current;
    this.sampleTimer+=dt;
    if(this.sampleTimer>=.2) {this.sampleTimer-=.2;this.samples.push({t:this.elapsed,x:current[0],y:drone.altitude,z:current[2],pitch:drone.pitch,roll:drone.roll,speed:drone.velocity.length()});if(this.samples.length>3600)this.samples.shift();}
    this.hint=`${this.ringIndex+1}번 링을 향해 비행하세요. ${this.combo>1?`콤보 ×${this.combo} · 12초 안에 다음 링!`:'파란 크리스털은 순서 없이 수집할 수 있어요.'}`;
  }

  finish(_passed,reason) {this.finished=true;this.reason=reason;}
  report() {return {id:Date.now(),mapId:this.mapId,mode:this.mode,wind:this.wind,gusts:this.gusts,score:this.score,rings:this.ringsPassed,crystals:this.crystalsCollected,lap:this.lap,maxCombo:this.maxCombo,elapsed:this.elapsed,crashed:this.crashed,reason:this.reason,assistance:this.assistance,date:new Date().toISOString()};}
}
