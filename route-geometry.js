import {field as f} from './api.js';
const METERS=111195;
const distance=(a,b)=>Math.hypot((a[0]-b[0])*METERS*Math.cos((a[1]+b[1])/2*Math.PI/180),(a[1]-b[1])*METERS);
const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>120&&p[0]<135&&p[1]>30&&p[1]<40;
export function cleanLine(line) {
  if(!line||!['LineString','MultiLineString'].includes(line.type)||!Array.isArray(line.coordinates))return null;
  const lines=line.type==='LineString'?[line.coordinates]:line.coordinates;
  if(!lines.length||lines.reduce((n,l)=>n+(Array.isArray(l)?l.length:20001),0)>20000||!lines.every(l=>Array.isArray(l)&&l.length>=2&&l.every(valid)))return null;
  const rounded=lines.map(l=>l.map(p=>p.map(n=>Math.round(n*1e7)/1e7)));
  return {type:line.type,coordinates:line.type==='LineString'?rounded[0]:rounded};
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

// A provider-selected section is not an unordered whole-route shape. Preserve
// every link separately: intersection gaps must never become invented lines.
export const SECTION_VERSION=1;
const sectionSource='transfer/bus_stop_drawing_common';
export function sectionRequest(route,from,to) {
  const fromId=route.fromStandardId||from.standardId,toId=route.toStandardId||to.standardId;
  if(!/^\d+$/.test(route.routeId||'')||![fromId,toId].every(id=>/^\d{9}$/.test(id||'')))throw new Error('구간 형상 조회에 필요한 노선·정류장 표준ID를 확인하지 못했습니다.');
  if((from.standardId&&from.standardId!==fromId)||(to.standardId&&to.standardId!==toId))throw new Error('선택한 정류장과 노선 구간의 표준ID가 일치하지 않습니다.');
  // Each manually selected edge is one direct ride, including either side of
  // a transfer. Mode 1 was verified with the retained 101 response fixture.
  return {sStdId1:route.routeId,sStdId2:fromId,sStdId3:toId,sStdId4:'1'};
}
export function sectionCacheKey(route,from,to) {
  const p=sectionRequest(route,from,to);
  return `section:transfer:v1:${p.sStdId1}:${p.sStdId2}:${p.sStdId3}:1:${route.fromSeq}:${route.toSeq}`;
}
function sectionProjections(links,point){
  let offset=0;const found=[];
  for(let i=0;i<links.length;i++){
    if(i)offset+=distance(links[i-1].at(-1),links[i][0]);
    found.push(...projections(links[i],point).map(p=>({...p,link:i,along:p.along+offset})));
    for(let j=1;j<links[i].length;j++)offset+=distance(links[i][j-1],links[i][j]);
  }
  const minimum=Math.min(...found.map(p=>p.distance)),groups=[];
  for(const p of found.filter(p=>p.distance<=minimum+5)){
    const last=groups.at(-1);
    if(last&&p.along-last.along<25){if(p.distance<last.distance)groups[groups.length-1]=p;}else groups.push(p);
  }
  return groups;
}
export function parseSection(rows,from,to,route,{anchors=[]}={}) {
  const fail=(status,reason,message,extra={})=>({status,segment:null,message,diagnostics:{reason,...extra}});
  if(!Number.isFinite(route.fromSeq)||!Number.isFinite(route.toSeq)||route.fromSeq>=route.toSeq)return fail('unverified','stop-sequence','경유 정류장의 진행 순서를 먼저 확인해야 합니다.');
  if(!valid([from.lon,from.lat])||!valid([to.lon,to.lat]))return fail('unverified','stop-position','승차·하차 정류장의 위치를 확인하지 못했습니다.');
  if(!rows.length)return fail('missing','empty-response','해당 구간의 형상 응답이 비어 있습니다.');
  const groups=[];
  for(const row of rows){
    const p=[Number(f(row,'vtxx')),Number(f(row,'vtxy'))],seq=Number(f(row,'vtxSeq')),id=f(row,'linkId');
    if(!valid(p)||!id||f(row,'vtxSeq')===''||!Number.isFinite(seq))return fail('unsupported','invalid-vertex','형상의 좌표계 또는 링크·꼭짓점 순번을 확인하지 못했습니다.');
    let group=groups.at(-1);if(!group||group.id!==id){group={id,points:[]};groups.push(group);}group.points.push({p,seq});
  }
  const raw=groups.map(g=>g.points.sort((a,b)=>a.seq-b.seq).map(x=>x.p));
  if(raw.some(l=>l.length<2))return fail('unsupported','incomplete-link','꼭짓점이 부족한 도로 조각이 있어 구간 표시를 보류했습니다.');
  const candidates=new Map();let endpointPairs=0,anchorFailures=0,gapFailures=0;
  for(const reverseOrder of [false,true])for(const reverseFirst of [false,true]){
    const ordered=reverseOrder?[...raw].reverse():raw;
    const links=[reverseFirst?[...ordered[0]].reverse():[...ordered[0]]];
    for(const points of ordered.slice(1))links.push(distance(links.at(-1).at(-1),points[0])<=distance(links.at(-1).at(-1),points.at(-1))?[...points]:[...points].reverse());
    for(const a of sectionProjections(links,from))for(const b of sectionProjections(links,to))if(b.along-a.along>5){
      endpointPairs++;let cursor=a.along,orderedStops=true;
      for(const stop of anchors){const next=sectionProjections(links,stop).find(p=>p.along>=cursor&&p.along<=b.along);if(!next){orderedStops=false;break;}cursor=next.along;}
      if(!orderedStops){anchorFailures++;continue;}
      let maxGap=0;for(let i=a.link+1;i<=b.link;i++)maxGap=Math.max(maxGap,distance(links[i-1].at(-1),links[i][0]));
      // This is a rejection bound, never permission to draw across a gap.
      if(maxGap>75){gapFailures++;continue;}
      const pieces=[];
      for(let i=a.link;i<=b.link;i++){
        let points;
        if(a.link===b.link)points=[a.p,...links[i].slice(a.index+1,b.index+1),b.p];
        else if(i===a.link)points=[a.p,...links[i].slice(a.index+1)];
        else if(i===b.link)points=[...links[i].slice(0,b.index+1),b.p];
        else points=links[i];
        points=points.filter((p,j)=>!j||distance(p,points[j-1])>0.01);
        if(points.length>=2)pieces.push(points);
      }
      const segment=cleanLine(pieces.length===1?{type:'LineString',coordinates:pieces[0]}:{type:'MultiLineString',coordinates:pieces});
      if(segment)candidates.set(JSON.stringify(segment),{segment,maxGap});
    }
  }
  const diagnostics={choiceCount:candidates.size,linkCount:groups.length,anchorCount:anchors.length};
  if(candidates.size!==1){
    const reason=candidates.size>1?'multiple-sections':gapFailures?'large-link-gap':anchorFailures?'stop-order-mismatch':endpointPairs?'empty-section':'outside-section';
    const messages={'multiple-sections':'서로 다른 구간 후보가 여러 개여서 선을 확정하지 못했습니다.','large-link-gap':'구간 응답의 도로 조각 사이에 큰 누락이 있어 표시를 보류했습니다.','stop-order-mismatch':'구간 형상과 중간 경유 정류장의 위치·순서가 일치하지 않습니다.','empty-section':'표시할 유효한 구간이 없습니다.','outside-section':'승차·하차 위치가 구간 형상에서 75m 이내로 확인되지 않습니다.'};
    return fail('ambiguous',reason,messages[reason],diagnostics);
  }
  const result=candidates.values().next().value;
  return {status:'ready',segment:result.segment,message:'구간 형상 확보 · 도로 조각 사이의 틈은 연결하지 않습니다.',diagnostics:{reason:'',...diagnostics,maxGapMeters:Math.round(result.maxGap*10)/10}};
}
export async function getSectionOnQuery(client,store,route,from,to,options={}) {
  const params=sectionRequest(route,from,to),key=sectionCacheKey(route,from,to);
  const cached=await store.get(key);
  if(cached?.source===sectionSource&&cached.request&&Object.entries(params).every(([k,v])=>cached.request[k]===v)&&Array.isArray(cached.rawRows))return {...cached,...parseSection(cached.rawRows,from,to,route,options),parserVersion:SECTION_VERSION,shapeKey:key};
  let jobs=inflight.get(store);if(!jobs){jobs=new Map();inflight.set(store,jobs);}
  if(!jobs.has(key))jobs.set(key,(async()=>{
    const {rows}=await client.get('transfer','bus_stop_drawing_common',params);
    const rawRows=rows.map(row=>Object.fromEntries(['linkId','vtxSeq','vtxx','vtxy'].map(k=>[k,f(row,k)])));
    const record={source:sectionSource,request:params,rawRows,parserVersion:SECTION_VERSION,fetchedAt:new Date().toISOString()};
    try{await store.put(key,record);}catch{record.storageWarning=true;}return record;
  })());
  try{const record=await jobs.get(key);return {...record,...parseSection(record.rawRows,from,to,route,options),shapeKey:key};}finally{jobs.delete(key);}
}
export function readSectionCache(record,route,from,to,options={}) {
  let request;try{request=sectionRequest(route,from,to);}catch{return null;}
  if(record?.source!==sectionSource||!Array.isArray(record.rawRows)||!record.request||!Object.entries(request).every(([k,v])=>record.request[k]===v))return null;
  return parseSection(record.rawRows,from,to,route,options);
}
