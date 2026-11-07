import {ApiRequestError, field as f, latestStopDataset, STOP_SPEC_URL} from './api.js';
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
  const numbered=rows.filter(row=>f(row,'stopId').replace(/^0+/,'')===String(point.number).replace(/^0+/,'')
    && /^\d{9}$/.test(f(row,'stopStandardid')));
  let matches=placeholder?numbered:numbered.filter(row=>matchesStop(point,{number:f(row,'stopId'),name:f(row,'stopKname')}));
  // A rename can be resolved only when the public number is unambiguous and the location agrees.
  if(!matches.length && new Set(numbered.map(row=>f(row,'stopStandardid'))).size===1){
    matches=numbered.filter(row=>samePosition(point,{lat:Number(f(row,'stopY')),lon:Number(f(row,'stopX'))}));
  }
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

function fresh(entry){
  const age=Date.now()-entry?.date;
  return Number.isFinite(entry?.date)&&age>=0&&age<=86400000&&Array.isArray(entry.stops);
}

function samePosition(a,b){
  if(![a.lat,a.lon,b.lat,b.lon].every(Number.isFinite))return false;
  return Math.hypot((a.lat-b.lat)*111000,(a.lon-b.lon)*111000*Math.cos(a.lat*Math.PI/180))<=25;
}

export function cachedPlatformId(point,entries,platforms=[]){
  if(point.standardId)return '';
  const ids=new Set();
  for(const entry of Object.values(entries)){
    if(!fresh(entry))continue;
    for(const stop of entry.stops)if(/^\d{9}$/.test(stop?.standardId)&&matchesStop(point,stop))ids.add(stop.standardId);
  }
  for(const platform of platforms){
    if(platform.number===point.number && samePosition(point,platform))ids.add(platform.standardId);
  }
  return ids.size===1?[...ids][0]:'';
}

// Old records and regional hints select which route to ask about, never the answer.
async function searchAlternateRoutes(client,from,to,{routeHints={},check=()=>{},entries,memberships}){
  const hints=new Map(routeHints[from.number+':'+to.number]||[]);
  for(const [id,e] of Object.entries(entries)){
    if(e?.number&&Array.isArray(e.stops)&&[from,to].every(p=>e.stops.some(s=>matchesStop(p,s))))hints.set(id,e.number);
  }
  const candidates=[...hints].filter(([id])=>/^\d{9}$/.test(id)&&memberships.every(list=>list.has(id))).slice(0,4);
  if(!candidates.length)return null;
  const checked=[];let examined=0,alternateError='';
  for(const [id,number] of candidates){
    check();let entry=entries[id];
    if(!fresh(entry)){
      let rows;
      try{({rows}=await client.get('routes','bus_location_busstop_list_common',{brtStdid:id}));}
      catch(error){if(!(error instanceof ApiRequestError))throw error;alternateError=error.message;break;}
      check();
      if(!rows.length||rows.some(r=>f(r,'brtStdid')!==id)){
        alternateError='경유 목록에서 요청한 노선 ID를 확인하지 못했습니다.';break;
      }
      entry={date:Date.now(),number,stops:rows.map(routeStop)};entries[id]=entry;
    }
    examined++;
    checked.push({...entry,id,number});
  }
  // Resolve both selected platforms uniquely across the checked sequences.
  const points=[from,to].map(point=>{
    const ids=new Set(checked.flatMap(r=>r.stops.filter(stop=>(point.standardId ? stop.standardId===point.standardId && stop.number===point.number : matchesStop(point,stop))&&/^\d{9}$/.test(stop.standardId)).map(s=>s.standardId)));
    if(ids.size!==1||(point.standardId&&!ids.has(point.standardId)))return null;
    return {...point,standardId:[...ids][0]};
  });
  const routes=points.every(Boolean)?findDirectRoutes(checked,...points):[];
  return {routes,examined,alternateError};
}

// Two static membership lists are intersected before requesting stop sequences.
// No realtime arrivals, transfer suggestions, whole-city catalogs or retries.
export async function queryDirectLeg(client,from,to,options={}) {
  const entries=options.entries??{};
  const memberships=[];
  for(const stop of [from,to]){const id=cachedPlatformId(stop,entries,options.platforms);if(id)stop.standardId=id;}
  try {
    return await queryLiveLeg(client,from,to,{...options,entries,memberships});
  } catch(error) {
    if(!(error instanceof ApiRequestError)||!error.unavailable)throw error;
    options.check?.();
    // Recovery uses verified platform identities, never infers one after a lookup failure.
    const known=[from,to].every(stop=>/^\d{9}$/.test(stop.standardId||''));
    const now=Date.now();
    const cached=Object.entries(entries).filter(([id,e])=>memberships.every(list=>list.has(id))&&e?.number&&Array.isArray(e.stops)
      &&e.date<=now&&now-e.date<=86400000).map(([id,e])=>({...e,id,
        stops:e.stops.filter(s=>/^\d{9}$/.test(s?.standardId||''))}));
    const routes=known?findDirectRoutes(cached,from,to):[];
    if(routes.length)return {routes,examined:cached.length,partial:true,sourceFailed:true,error:error.message};
    if(error.source!=='busstop'||!error.unavailable)throw error;
    const result=await searchAlternateRoutes(client,from,to,{...options,entries,memberships});
    if(!result)throw error;
    if(result.alternateError&&!result.routes.length)throw new Error(`${error.message} / 경유 목록 확인: ${result.alternateError}`);
    return {...result,partial:true,alternate:true,sourceFailed:true,error:error.message};
  }
}
async function queryLiveLeg(client,from,to,{entries,memberships,ids=new Map(),check=()=>{},onProgress=()=>{}}) {
  const fromId=await resolvePlatformIdentity(client,from,ids,check);check();
  const toId=await resolvePlatformIdentity(client,to,ids,check);check();
  const start=await client.get('busstop','general_busstop_common',{stopStandardid:fromId});check();
  memberships.push(new Set(start.rows.map(row=>f(row,'brtStdId'))));
  const end=await client.get('busstop','general_busstop_common',{stopStandardid:toId});check();
  memberships.push(new Set(end.rows.map(row=>f(row,'brtStdId'))));
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
