import {field as f} from './api.js';
const METERS=111195;
const distance=(a,b)=>Math.hypot((a[0]-b[0])*METERS*Math.cos((a[1]+b[1])/2*Math.PI/180),(a[1]-b[1])*METERS);
const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>120&&p[0]<135&&p[1]>30&&p[1]<40;
export function cleanLine(line) {
  if(line?.type!=='LineString'||!Array.isArray(line.coordinates)||line.coordinates.length<2||line.coordinates.length>20000||!line.coordinates.every(valid))return null;
  return {type:'LineString',coordinates:line.coordinates.map(p=>p.map(n=>Math.round(n*1e7)/1e7))};
}
export function geometryState(route) {
  if(route.segment)return {label:'선형 확보',detail:''};
  const states={
    'not-requested':{label:'선형 미조회',detail:'아직 이 노선의 형상을 요청하지 않았습니다.'},
    'request-error':{label:'선형 조회 실패',detail:route.geometryMessage||'요청에 실패했습니다. 자동 재시도하지 않습니다.'},
    unsupported:{label:'형식 확인 필요',detail:route.geometryMessage||'형상 좌표계를 확인하지 못해 표시를 보류했습니다.'},
    ambiguous:{label:'구간 연결 미확정',detail:route.geometryMessage||'승차·하차 구간을 유일하게 연결하지 못했습니다.'},
    unverified:{label:'정류장 순서 미확인',detail:route.geometryMessage||'경유 정류장 순서를 확인해야 구간을 표시할 수 있습니다.'},
  };
  if(states[route.geometryStatus])return states[route.geometryStatus];
  if(route.geometryMessage)return {label:'선형 응답 없음',detail:route.geometryMessage};
  return {label:'선형 미확보 · 원인 미기록',detail:'기존 저장 정보에 미확보 사유가 남아 있지 않습니다. API 오류인지 미조회 상태인지 단정할 수 없습니다.'};
}
export function parseShape(rows) {
  const groups=[];
  for(const row of rows){const p=[Number(f(row,'vtxx')),Number(f(row,'vtxy'))];if(!valid(p))return {status:'unsupported',parts:[],message:'좌표계를 확인할 수 없어 선을 표시하지 않습니다.'};
    const id=f(row,'linkId');let group=groups.at(-1);if(!group||group.id!==id){group={id,points:[]};groups.push(group);}group.points.push({p,seq:Number(f(row,'vtxSeq'))});
  }
  if(!groups.length)return {status:'missing',parts:[],message:'제공된 노선 형상이 없습니다.'};
  const links=groups.map(g=>g.points.sort((a,b)=>a.seq-b.seq).map(x=>x.p));
  const assemble=reverseFirst=>{const parts=[];let current=reverseFirst?[...links[0]].reverse():[...links[0]];for(const raw of links.slice(1)){
    let next=[...raw];if(distance(current.at(-1),next.at(-1))<distance(current.at(-1),next[0]))next.reverse();
    if(distance(current.at(-1),next[0])<=12)current.push(...next);else{parts.push(current);current=next;}
  }parts.push(current);return parts;};
  const forward=assemble(false),reverse=assemble(true);const parts=forward.length<=reverse.length?forward:reverse;
  return {status:'ready',parts};
}
function projections(points,point){
  let along=0;const list=[],target=[point.lon,point.lat];
  for(let i=0;i<points.length-1;i++){
    const a=points[i],b=points[i+1],cos=Math.cos(target[1]*Math.PI/180),dx=(b[0]-a[0])*cos,dy=b[1]-a[1],length=distance(a,b);
    const t=Math.max(0,Math.min(1,(((target[0]-a[0])*cos)*dx+(target[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
    const p=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];list.push({index:i,t,p,along:along+length*t,distance:distance(p,target)});along+=length;
  }
  const minimum=Math.min(...list.map(p=>p.distance));if(minimum>75)return [];
  const near=list.filter(p=>p.distance<=Math.min(75,minimum+5)),clusters=[];
  for(const p of near){const last=clusters.at(-1);if(last&&Math.abs(last.along-p.along)<25){if(p.distance<last.distance)clusters[clusters.length-1]=p;}else clusters.push(p);}
  return clusters;
}
export function clipShape(shape,from,to,route) {
  if(shape.status!=='ready'||!Array.isArray(shape.parts))return {status:shape.status||'missing',message:shape.message,segment:null};
  if(!Number.isFinite(route.fromSeq)||!Number.isFinite(route.toSeq)||route.fromSeq>=route.toSeq)return {status:'unverified',message:'정류장 순서 확인 후 구간을 표시합니다.',segment:null};
  const choices=[];
  for(const points of shape.parts){for(const a of projections(points,from))for(const b of projections(points,to))if(b.along-a.along>5){
    const coordinates=[a.p,...points.slice(a.index+1,b.index+1),b.p];const segment=cleanLine({type:'LineString',coordinates});if(segment)choices.push({segment,distance:a.distance+b.distance});
  }}
  if(choices.length!==1)return {status:'ambiguous',message:'구간 연결을 확정할 수 없어 선을 표시하지 않습니다.',segment:null};
  return {status:'ready',message:'저장된 구간 선형',segment:choices[0].segment};
}
const inflight=new WeakMap();
export async function getShapeOnQuery(client,store,routeId) {
  const cached=await store.get(routeId);if(cached)return cached;
  let jobs=inflight.get(store);if(!jobs){jobs=new Map();inflight.set(store,jobs);}if(jobs.has(routeId))return jobs.get(routeId);
  const job=(async()=>{const {rows}=await client.get('routes','bus_nosun_drawing_common',{brtStdid:routeId});const value={...parseShape(rows),fetchedAt:new Date().toISOString()};try{await store.put(routeId,value);}catch{value.storageWarning=true;}return value;})();
  jobs.set(routeId,job);try{return await job;}finally{jobs.delete(routeId);}
}
