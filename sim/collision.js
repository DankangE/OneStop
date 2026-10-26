// Collision volumes use the same dimensions as map scenery. Y is up.
export function hitsObstacle(point, obstacle, radius = 0.42) {
  const { x, y, z } = point;
  if (obstacle.type === 'sphere') return Math.hypot(x-obstacle.center[0],y-obstacle.center[1],z-obstacle.center[2]) < obstacle.radius+radius;
  if (obstacle.type === 'cylinder') {
    const horizontal = Math.max(0,Math.hypot(x-obstacle.center[0],z-obstacle.center[2])-obstacle.radius);
    const vertical = Math.max(0,Math.abs(y-obstacle.center[1])-obstacle.height/2);
    return Math.hypot(horizontal,vertical)<radius;
  }
  if (obstacle.type === 'torus') {
    const dx=x-obstacle.center[0],dy=y-obstacle.center[1],dz=z-obstacle.center[2];
    const plane=dx*obstacle.normal[0]+dy*obstacle.normal[1]+dz*obstacle.normal[2];
    const radial=Math.sqrt(Math.max(0,dx*dx+dy*dy+dz*dz-plane*plane));
    return Math.hypot(radial-obstacle.radius,plane)<obstacle.tube+radius;
  }
  const closest=(v,low,high)=>Math.max(low,Math.min(high,v));
  return Math.hypot(x-closest(x,obstacle.min.x,obstacle.max.x),y-closest(y,obstacle.min.y,obstacle.max.y),z-closest(z,obstacle.min.z,obstacle.max.z))<radius;
}

export function segmentDistanceSquared(a,b,p) {
  const d=[b[0]-a[0],b[1]-a[1],b[2]-a[2]];
  const length=d.reduce((sum,v)=>sum+v*v,0);
  const t=length?Math.max(0,Math.min(1,d.reduce((sum,v,i)=>sum+(p[i]-a[i])*v,0)/length)):0;
  return p.reduce((sum,v,i)=>sum+(a[i]+d[i]*t-v)**2,0);
}

export function crossesRing(a,b,ring) {
  const distance=p=>p.reduce((sum,v,i)=>sum+(v-ring.center[i])*ring.normal[i],0);
  const before=distance(a),after=distance(b);
  if(before>=0 || after<0)return false;
  const t=before/(before-after),p=a.map((v,i)=>v+(b[i]-v)*t);
  return Math.hypot(...p.map((v,i)=>v-ring.center[i]))<ring.radius-ring.tube-.42;
}
