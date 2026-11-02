import {field as f, latestStopDataset, STOP_SPEC_URL} from './api.js';
import {routeStop, findDirectRoutes, matchesStop} from './journey.js';

export async function fetchStopSpec() {
  const response=await fetch(STOP_SPEC_URL,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('정류장 식별정보 명세를 불러오지 못했습니다.');
  return response.json();
}

export function identityDataset(spec) {
  const paths=Object.fromEntries(Object.entries(spec.paths||{}).filter(([,path])=>{
    const ref=path.get?.responses?.['200']?.schema?.$ref?.split('/').pop();
    const modelRef=spec.definitions?.[ref]?.properties?.data?.items?.$ref?.split('/').pop();
    return Object.hasOwn(spec.definitions?.[modelRef]?.properties||{},'정류장ID');
  }));
  return latestStopDataset({...spec,paths});
}

export async function resolveStopIdentity(client,point,spec,ids=new Map(),check=()=>{}) {
  const cacheKey=`${point.number}:${point.lat}:${point.lon}`;
  if(ids.has(cacheKey))return ids.get(cacheKey);
  const dataset=identityDataset(spec);
  const {rows}=await client.get('stops',dataset.path,{page:1,perPage:5,returnType:'JSON','cond[정류장번호::EQ]':point.number});
  check();
  const row=rows.find(r=>String(r['정류장번호'])===String(point.number));
  // The historical file uses TAGO's JUB prefix. Use its numeric identifier only
  // to find candidates; current route stop number AND name must still match.
  const match=String(row?.['정류장ID']||'').match(/^JUB(\d{9})$/);
  const lat=Number(row?.['위도']),lon=Number(row?.['경도']);
  const meters=Math.hypot((lat-point.lat)*111000,(lon-point.lon)*111000*Math.cos(point.lat*Math.PI/180));
  if(!match || !Number.isFinite(meters) || meters>150)throw new Error(`${point.name}: 기존 식별정보와 현재 위치를 연결하지 못했습니다. 표준ID 확인이 필요합니다.`);
  ids.set(cacheKey,match[1]);return match[1];
}

export async function queryDirectLeg(client,from,to,{getSpec=fetchStopSpec,ids=new Map(),entries={},check=()=>{},onProgress=()=>{}}={}) {
  const spec=await getSpec();check();
  const fromId=await resolveStopIdentity(client,from,spec,ids,check);
  const toId=await resolveStopIdentity(client,to,spec,ids,check);
  const lookups=await Promise.allSettled([
    client.get('realtime','bus_location_low_busstop_infomation_common',{stopStdid:fromId}),
    client.get('transfer','fromto_bus_search_transfer_detail_common',{sStandardId:fromId,eStandardId:toId,maxCnt:50}),
  ]);check();
  if(lookups.every(r=>r.status==='rejected'))throw new Error('후보 노선 조회 실패: '+lookups.map(r=>r.reason.message).join(' / '));
  const candidates=new Map();
  if(lookups[0].status==='fulfilled')for(const row of lookups[0].value.rows) {
    const id=f(row,'brtStdid');if(id)candidates.set(id,{id,number:f(row,'brtId'),destination:f(row,'brtVianame'),direction:f(row,'brtDirection')});
  }
  if(lookups[1].status==='fulfilled')for(const row of lookups[1].value.rows) {
    const id=f(row,'startId');if(id && !candidates.has(id))candidates.set(id,{id,number:f(row,'startNo'),destination:'',direction:''});
  }
  const routes=[];let n=0;
  for(const route of candidates.values()) {
    check();
    let saved=entries[route.id];
    if(!saved || Date.now()-saved.date>86400000) {
      const {rows}=await client.get('routes','bus_location_busstop_list_common',{brtStdid:route.id});check();
      saved={date:Date.now(),stops:rows.map(routeStop)};entries[route.id]=saved;
    }
    routes.push({...route,stops:saved.stops});onProgress(++n,candidates.size);
  }
  // Existence is checked only against queried candidates, never a whole-city index.
  const confirmed=routes.flatMap(r=>r.stops);
  const unmatched=[from,to].filter(p=>!confirmed.some(s=>matchesStop(p,s)));
  const direct=findDirectRoutes(routes,from,to);
  return {routes:direct,examined:candidates.size,unmatched:unmatched.map(p=>p.number),partial:true,sourceFailed:lookups.some(r=>r.status==='rejected')};
}
