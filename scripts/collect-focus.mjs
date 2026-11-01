// Explicit one-off collection for the user's five stops and five route numbers.
import fs from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import {createClient,normalizeStop,field as f} from '../api.js';
import {routeStop,findDirectRoutes} from '../journey.js';
globalThis.DOMParser=DOMParser;
const path=new URL('../data/focus-network.json',import.meta.url);
let data;try{data=JSON.parse(await fs.readFile(path,'utf8'));}catch{data={version:1,stops:[],routeRecords:[],shapes:{},requests:[]};}
const client=createClient(source=>source==='routes'?(process.env.ROUTES_SERVICE_KEY||process.env.DATA_GO_KR_SERVICE_KEY):process.env.DATA_GO_KR_SERVICE_KEY);
const allowedNumbers=new Set(['61','200','101','74','75']);
let calls=0;
async function get(source,operation,params){
  if(calls>=16)throw new Error('이번 실행의 16회 한도에 도달했습니다.');
  if(source==='stops'&&!['30927','36347'].includes(params['cond[정류장번호::EQ]']))throw new Error('범위 외 정류장');
  if(operation==='bus_location1_common'&&!allowedNumbers.has(params.brtId))throw new Error('범위 외 노선');
  ++calls;data.requests.push({source,operation,params,at:new Date().toISOString()});
  try{return await client.get(source,operation,params);}finally{await fs.writeFile(path,JSON.stringify(data));await new Promise(r=>setTimeout(r,350));}
}
const known=[{number:'30887',name:'진북우성아파트후문',lat:35.83235206,lon:127.1326069,standardId:'306100887'},{number:'30920',name:'서신광진아파트',lat:35.834017,lon:127.111001,standardId:'305100920'},{number:'36351',name:'법원.검찰청.만성에코르',lat:35.844878,lon:127.077473,standardId:'305032417'}];
for(const p of known)if(!data.stops.some(s=>s.number===p.number))data.stops.push(p);
try{
 for(const number of ['30927','36347'])if(!data.stops.some(s=>s.number===number)){
  const {rows}=await get('stops','/15080859/v1/uddi:843bf5fa-ed46-4a3c-962e-f7c98be8a2cc',{page:1,perPage:5,returnType:'JSON','cond[정류장번호::EQ]':number});
  const row=rows.find(r=>String(r['정류장번호'])===number);if(!row)throw new Error('대상 정류장 없음');data.stops.push(normalizeStop(row));
 }
 const candidates=[['61','305001119'],['200','305001423'],['101','305001088'],['101','305001089'],['74','305001609'],['75','305001493']];
 for(const [number,id]of candidates)if(!data.routeRecords.some(r=>r.id===id)){
  const {rows}=await get('routes','bus_location_busstop_list_common',{brtStdid:id});
  data.routeRecords.push({id,number,stops:rows.map(routeStop)});
 }
 const stop=n=>data.stops.find(s=>s.number===n);
 const legs=[['30887','30920','61'],['30927','30920','200'],['30920','36347','101'],['30920','36351','74'],['30920','36351','75']];
 data.legs=legs.map(([from,to,number])=>({from,to,number,routes:findDirectRoutes(data.routeRecords.filter(r=>r.number===number),stop(from),stop(to))}));
 for(const leg of data.legs)for(const route of leg.routes){
  if(!data.shapes[route.routeId]){
   const {rows}=await get('routes','bus_nosun_drawing_common',{brtStdid:route.routeId});
   data.shapes[route.routeId]={fetchedAt:new Date().toISOString(),rows:rows.map(r=>({linkId:f(r,'linkId'),vtxSeq:f(r,'vtxSeq'),vtxx:f(r,'vtxx'),vtxy:f(r,'vtxy')}))};
  }
 }
 data.collectedAt=new Date().toISOString();await fs.writeFile(path,JSON.stringify(data));
 console.log('이번 실행 버스 API 호출:',calls);
 console.log(data.legs.map(l=>({from:l.from,to:l.to,number:l.number,matches:l.routes.length})));
 for(const [id,shape]of Object.entries(data.shapes))console.log('shape',id,shape.rows.length,shape.rows.slice(0,3));
}catch(e){await fs.writeFile(path,JSON.stringify(data));console.error('수집 중단:',e.message,'이번 호출:',calls);process.exitCode=1;}
