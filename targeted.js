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

// Resolve current standard IDs from the new platform service, without the
// historical file or a city-wide download. searchFld has no documented values,
// so only the documented optional stop-number parameter is sent.
export async function resolvePlatformIdentity(client,point,ids=new Map(),check=()=>{}){
  if(/^\d{9}$/.test(point.standardId||''))return point.standardId;
  const key=`${point.number}:${point.name}:${point.lat}:${point.lon}`;
  if(ids.has(key)){Object.assign(point,ids.get(key));return point.standardId;}
  const {rows}=await client.get('busstop','bus_location2_stopno_common',{searchNm:point.number});check();
  const placeholder=point.name===`정류장 ${point.number}`;
  const matches=rows.filter(row=>{
    const stop={number:f(row,'stopId'),name:f(row,'stopKname')};
    return (placeholder?String(stop.number).replace(/^0+/,'')===String(point.number).replace(/^0+/,''):matchesStop(point,stop))&&/^\d{9}$/.test(f(row,'stopStandardid'));
  });
  const standards=new Set(matches.map(row=>f(row,'stopStandardid')));
  if(standards.size!==1)throw new Error(`${point.name}: 정류장번호·이름에 맞는 표준ID를 하나로 확인하지 못했습니다.`);
  const row=matches[0],lon=Number(f(row,'stopX')),lat=Number(f(row,'stopY'));
  if(lon>120&&lon<135&&lat>30&&lat<40){
    if(Number.isFinite(point.lon)&&Number.isFinite(point.lat)){
      const distance=Math.hypot((lat-point.lat)*111000,(lon-point.lon)*111000*Math.cos(lat*Math.PI/180));
      if(distance>150)throw new Error(`${point.name}: 승강장 정보와 선택한 위치가 일치하지 않습니다.`);
    }else{point.lon=lon;point.lat=lat;}
  }
  if(placeholder)point.name=f(row,'stopKname');
  point.standardId=[...standards][0];ids.set(key,{standardId:point.standardId,name:point.name,lat:point.lat,lon:point.lon});return point.standardId;
}

// Two static membership lists are intersected before requesting stop sequences.
// No realtime arrivals, transfer suggestions, whole-city catalogs or retries.
export async function queryDirectLeg(client,from,to,{entries={},ids=new Map(),check=()=>{},onProgress=()=>{}}={}) {
  const fromId=await resolvePlatformIdentity(client,from,ids,check);check();
  const toId=await resolvePlatformIdentity(client,to,ids,check);check();
  const start=await client.get('busstop','general_busstop_common',{stopStandardid:fromId});check();
  const end=await client.get('busstop','general_busstop_common',{stopStandardid:toId});check();
  for(const result of [start,end])if(result.rows.length&&!result.rows.some(row=>f(row,'brtStdId')))throw new Error('승강장 경유노선 응답에 노선 ID가 없습니다.');
  const endIds=new Set(end.rows.map(row=>f(row,'brtStdId')).filter(Boolean)),candidates=new Map();
  for(const row of start.rows){
    const id=f(row,'brtStdId'),number=f(row,'brtId');
    if(id&&number&&endIds.has(id))candidates.set(id,{id,number,direction:f(row,'brtDirection'),destination:[f(row,'brtSname'),f(row,'brtEname')].filter(Boolean).join(' → ')});
  }
  const routes=[];let examined=0;
  for(const route of candidates.values()){
    check();let saved=entries[route.id];
    if(!saved||!Array.isArray(saved.stops)||!Number.isFinite(saved.date)||Date.now()-saved.date>86400000){
      const {rows}=await client.get('routes','bus_location_busstop_list_common',{brtStdid:route.id});check();
      if(!rows.length)throw new Error(`${route.number}번 경유 정류장 응답이 비어 있습니다.`);
      saved={date:Date.now(),stops:rows.map(routeStop)};
    }
    entries[route.id]={...saved,number:route.number,direction:route.direction,destination:route.destination};
    routes.push({...route,stops:saved.stops});onProgress(++examined,candidates.size);
  }
  return {routes:findDirectRoutes(routes,from,to),examined:candidates.size,unmatched:[],partial:false,sourceFailed:false};
}
