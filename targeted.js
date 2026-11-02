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

// Route membership is independent of buses approaching right now.
export async function queryDirectLeg(client,from,to,{entries={},mapping,check=()=>{}}={}) {
  check();
  const routes=Object.entries(entries).flatMap(([id,entry])=>entry?.number&&Array.isArray(entry.stops)?[{id,...entry}]:[]);
  if(!routes.length)throw new Error('정류장별 노선 매핑이 없습니다. 노선 매핑 준비를 먼저 실행하세요.');
  const confirmed=routes.flatMap(r=>r.stops);
  return {routes:findDirectRoutes(routes,from,to),examined:routes.length,unmatched:[from,to].filter(p=>!confirmed.some(s=>matchesStop(p,s))).map(p=>p.number),partial:!mapping?.complete,sourceFailed:false};
}

export async function loadMappingCatalog(client){
  const {rows}=await client.get('routes','bus_location_all_common');
  const numbers=new Map();
  for(const row of rows){const number=f(row,'brtId'),extension=f(row,'brtClass');if(number)numbers.set(`${number}:${extension}`,{number,extension,done:false});}
  if(!numbers.size)throw new Error('노선번호 목록이 비어 있습니다. 매핑을 시작하지 않았습니다.');
  return {version:1,numbers:[...numbers.values()],routes:[],complete:false,createdAt:new Date().toISOString()};
}
export async function buildMappingBatch(client,mapping,entries,{limit=50,check=()=>{},save=()=>{},onProgress=()=>{}}={}){
  let calls=0;
  const get=async(operation,params)=>{check();++calls;onProgress(calls);return client.get('routes',operation,params);};
  try{
    while(calls<limit){
      check();
      // Consume discovered route IDs before looking up another route number.
      const route=mapping.routes.find(r=>!r.done);
      if(route){
        if(!Array.isArray(entries[route.id]?.stops)||entries[route.id].date<Date.parse(mapping.createdAt||'1970-01-01')){
          const {rows}=await get('bus_location_busstop_list_common',{brtStdid:route.id});check();
          if(!rows.length)throw new Error(`${route.number}번 경유 정류장 응답이 비어 있습니다.`);
          entries[route.id]={date:Date.now(),stops:rows.map(routeStop)};
        }
        Object.assign(entries[route.id],{number:route.number,direction:route.direction,destination:route.destination});route.done=true;save();continue;
      }
      const item=mapping.numbers.find(n=>!n.done);
      if(!item){mapping.complete=true;mapping.completedAt=new Date().toISOString();save();break;}
      const {rows}=await get('bus_location1_common',{brtId:item.number,brtClass:item.extension});check();
      const ids=rows.flatMap(row=>{const id=f(row,'brtStdid');return id?[{id,number:f(row,'brtId')||item.number,direction:f(row,'brtDirection'),destination:[f(row,'brtSname'),f(row,'brtEname')].filter(Boolean).join(' → '),done:false}]:[];});
      if(!ids.length)throw new Error(`${item.number}번 노선 ID 응답이 비어 있습니다.`);
      for(const route of ids)if(!mapping.routes.some(r=>r.id===route.id))mapping.routes.push(route);
      item.done=true;save();
    }
    if(mapping.numbers.every(n=>n.done)&&mapping.routes.every(r=>r.done)){mapping.complete=true;mapping.completedAt=new Date().toISOString();save();}
    return {calls,complete:mapping.complete};
  }catch(error){error.mappingCalls=calls;throw error;}
}
