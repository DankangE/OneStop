import { GROUND } from './physics.js';

const rand = n => { const x = Math.sin(n * 127.1 + 63.3) * 43758.5453; return x - Math.floor(x); };
export const MAPS = {
  city: { id: 'city', title: '스카이라인', subtitle: 'SKYLINE / CITY', description: '햇살 좋은 도시, 빌딩 사이로 나만의 라인.', accent: '#ff814f', sky: '#91d3fa', ground: '#91caaa', rings: [[0,5,-12],[0,7,-28],[16,7,-28],[30,9,-28],[30,9,-8],[30,7,12],[14,6,12],[0,5,12]] },
  forest: { id: 'forest', title: '포레스트 런', subtitle: 'FOREST RUN / WOODS', description: '초록빛 숲, 나무 사이를 스치는 짜릿함.', accent: '#45d5ad', sky: '#a5e0fc', ground: '#60b97e', rings: [[0,5,-12],[-8,6,-25],[-25,7,-28],[-36,8,-10],[-28,7,12],[-12,6,24],[6,7,21],[12,5,3]] }
};

export function ringDefinitions(id) {
  const map = MAPS[id];
  return map.rings.map((center, index) => {
    const previous = map.rings[(index + map.rings.length - 1) % map.rings.length];
    const dx = center[0] - previous[0], dz = center[2] - previous[2], length = Math.hypot(dx, dz);
    return { id: index, center: [center[0], center[1] + GROUND, center[2]], normal: [dx / length, 0, dz / length], radius: 2.8, tube: 0.12, type: 'torus', label: '링 테두리' };
  });
}

export function crystalDefinitions(id) {
  const route = [[0,5,0], ...MAPS[id].rings];
  const crystals = route.slice(1).map((point, i) => ({ id: i, position: [(point[0] + route[i][0]) / 2, (point[1] + route[i][1]) / 2 + GROUND, (point[2] + route[i][2]) / 2] }));
  return [...crystals, ...[[id === 'city' ? -4 : 5,6,-20],[id === 'city' ? 34 : -32,10,-15],[id === 'city' ? 22 : -18,8,17]].map((position, i) => ({ id: i + crystals.length, position: [position[0], position[1] + GROUND, position[2]] }))];
}

function segmentDistance(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz || 1)));
  return Math.hypot(x-a[0]-t*dx,z-a[2]-t*dz);
}

export function sceneryDefinitions(id) {
  const buildings = [], trees = [], rocks = [], cars = [];
  if (id === 'city') {
    const palette = ['#c5e4f2','#f3c1a5','#f6e4ba','#b9d9ef','#b4ded8','#e4d5ef'];
    const sites = [[-17,-14,14,19,17],[-18,-42,16,14,28],[-38,-18,15,21,23],[-38,14,16,17,19],[-18,24,15,14,14],[15,-7,14,19,19],[15,-47,17,16,27],[16,34,20,13,18],[49,-27,18,18,25],[50,1,19,19,16],[47,30,16,17,29],[-39,-47,16,15,35]];
    sites.forEach(([x,z,w,d,h],i)=>buildings.push({x,z,w,d,h,color:palette[i%palette.length]}));
    [[-7,-20],[-7,8],[-7,31],[7,-42],[23,24],[38,-14],[38,10],[-28,32],[-28,-31]].forEach(([x,z],i)=>trees.push({x,z,h:5.5+i%3,r:1.8}));
    [[-3,-38],[3,24],[27,-2],[33,23],[-26,12]].forEach(([x,z],i)=>cars.push({x,z,color:['#fb865c','#73bbed','#ffe197'][i%3]}));
  } else {
    const route = [[0,5,0],...MAPS.forest.rings,MAPS.forest.rings[0]];
    for(let i=0;i<260;i++) {
      const x=(rand(i+1)-.5)*136,z=(rand(i+72)-.5)*136,h=7+rand(i+56)*7,r=2.0+rand(i+38)*1.2;
      if (Math.hypot(x,z)<8 || route.slice(1).some((b,j)=>segmentDistance(x,z,route[j],b)<r+4.3)) continue;
      trees.push({x,z,h,r});
    }
    [[8,-16],[-19,-16],[-26,3],[-4,16],[20,3],[-45,-21],[30,31]].forEach(([x,z],i)=>rocks.push({x,z,r:1.0+(i%3)*.35}));
  }
  return { buildings, trees, rocks, cars };
}

export function sceneryObstacles(data) {
  return [
    ...data.buildings.map(b=>({type:'box', label:'건물', min:{x:b.x-b.w/2-.15,y:0,z:b.z-b.d/2-.15},max:{x:b.x+b.w/2+.15,y:b.h+.35,z:b.z+b.d/2+.15}})),
    ...data.trees.flatMap(t=>[
      {type:'cylinder',label:'나무 줄기',center:[t.x,t.h*.32,t.z],radius:.27,height:t.h*.64},
      {type:'sphere',label:'나뭇가지',center:[t.x,t.h*.66,t.z],radius:t.r}
    ]),
    ...data.rocks.map(r=>({type:'sphere',label:'바위',center:[r.x,r.r*.6,r.z],radius:r.r})),
    ...data.cars.map(c=>({type:'box',label:'자동차',min:{x:c.x-.9,y:0,z:c.z-1.8},max:{x:c.x+.9,y:1.5,z:c.z+1.8}}))
  ];
}
