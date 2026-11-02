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
  if(!routes.length)throw new Error('저장된 경유 노선 정보가 없습니다. 경유 정보 데이터 연결이 필요합니다.');
  const confirmed=routes.flatMap(r=>r.stops);
  return {routes:findDirectRoutes(routes,from,to),examined:routes.length,unmatched:[from,to].filter(p=>!confirmed.some(s=>matchesStop(p,s))).map(p=>p.number),partial:!mapping?.complete,sourceFailed:false};
}
