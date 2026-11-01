import {cleanLine} from './route-geometry.js';
export const PLANS_KEY='busmap.transfer-plans.v1';
export const pointKey=p=>String(p?.number||'');
export const emptyPlan=()=>({id:'',name:'',transfer:null,origins:[],destinations:[]});
export function cleanPoint(p) {
  if(!p || !String(p.number||'').trim())throw new Error('정류장 번호를 확인하세요.');
  const coord=v=>v!==null && v!=='' && Number.isFinite(Number(v))?Number(v):null;
  return {number:String(p.number).trim(),name:String(p.name||`정류장 ${p.number}`).trim(),lat:coord(p.lat),lon:coord(p.lon),
    standardId:String(p.standardId||''),direction:String(p.direction||''),address:String(p.address||'')};
}
export function cleanRoute(r) {
  if(!r || !String(r.number||'').trim())throw new Error('노선 번호를 확인하세요.');
  return {number:String(r.number).trim(),routeId:String(r.routeId||''),direction:String(r.direction||''),destination:String(r.destination||''),
    fromStandardId:String(r.fromStandardId||''),toStandardId:String(r.toStandardId||''),
    fromSeq:Number.isFinite(r.fromSeq)?r.fromSeq:null,toSeq:Number.isFinite(r.toSeq)?r.toSeq:null,
    verified:r.verified===true,selected:r.selected!==false,shapeKey:String(r.shapeKey||''),segment:cleanLine(r.segment),geometryStatus:String(r.geometryStatus||'missing'),geometryMessage:String(r.geometryMessage||'').slice(0,240)};
}
export function normalizePlan(plan) {
  return {id:String(plan.id||''),name:String(plan.name||'').trim().slice(0,80),transfer:plan.transfer?cleanPoint(plan.transfer):null,
    origins:(plan.origins||[]).map(e=>({stop:cleanPoint(e.stop),routes:(e.routes||[]).map(cleanRoute)})),
    destinations:(plan.destinations||[]).map(e=>({stop:cleanPoint(e.stop),routes:(e.routes||[]).map(cleanRoute)}))};
}
export function validatePlan(plan) {
  const p=normalizePlan(plan);
  if(!p.transfer)throw new Error('환승지 한 곳을 지정하세요.');
  if(!p.origins.length || !p.destinations.length)throw new Error('출발지와 도착지를 한 곳 이상 추가하세요.');
  for(const group of [p.origins,p.destinations]) {
    if(new Set(group.map(e=>pointKey(e.stop))).size!==group.length)throw new Error('같은 구간에 정류장이 중복되어 있습니다.');
    for(const entry of group) {
      if(pointKey(entry.stop)===pointKey(p.transfer))throw new Error('출발지·도착지를 환승지와 다르게 지정하세요.');
      if(!entry.routes.some(r=>r.selected))throw new Error(`${entry.stop.name}: 저장할 노선을 한 개 이상 선택하세요.`);
    }
  }
  return p;
}
export function readPlans(storage) {
  try {const list=JSON.parse(storage.getItem(PLANS_KEY)||'[]');if(!Array.isArray(list))return [];
    return list.flatMap(p=>{try {const valid=validatePlan(p);return valid.id?[valid]:[];}catch{return [];}});
  }catch{return [];}
}
export function writePlan(storage,plan) {
  const p=validatePlan(plan);if(!p.id)throw new Error('저장 식별자가 없습니다.');
  const saved={...p,origins:p.origins.map(e=>({...e,routes:e.routes.filter(r=>r.selected)})),destinations:p.destinations.map(e=>({...e,routes:e.routes.filter(r=>r.selected)}))};
  const list=readPlans(storage),index=list.findIndex(x=>x.id===p.id);
  if(index<0 && list.length>=100)throw new Error('묶음은 최대 100개까지 저장할 수 있습니다.');
  if(index>=0)list[index]=saved;else list.unshift(saved);
  storage.setItem(PLANS_KEY,JSON.stringify(list));return saved;
}
export function arrivalTargets(plan) {
  const result=new Map();
  for(const e of plan.origins)result.set(pointKey(e.stop),{stop:e.stop,routes:e.routes.filter(r=>r.selected),kind:'출발지'});
  const viaRoutes=plan.destinations.flatMap(e=>e.routes.filter(r=>r.selected));
  result.set(pointKey(plan.transfer),{stop:plan.transfer,routes:viaRoutes,kind:'환승지'});
  return [...result.values()];
}
export function stopHint(stop,entries={}) {
  if(stop.direction)return `${stop.direction} 방면`;
  if(stop.address)return stop.address;
  const next=new Set();
  for(const route of Object.values(entries)) {
    if(!Array.isArray(route?.stops))continue;
    const sorted=[...route.stops].sort((a,b)=>a.seq-b.seq);
    sorted.forEach((s,i)=>{if(String(s.number)===String(stop.number) && s.name===stop.name && sorted[i+1]?.name)next.add(sorted[i+1].name);});
  }
  if(next.size)return '다음 정류장: '+[...next].slice(0,2).join(' / ');
  return '방면 미확인';
}
