import test from 'node:test';
import assert from 'node:assert/strict';
import {parseShape,clipShape,getShapeOnQuery,cleanLine,geometryState} from '../route-geometry.js';
import {writePlan,readPlans} from '../plan-model.js';
const rows=[127.10,127.11,127.12,127.13].map((x,i)=>({linkId:'a',vtxSeq:String(i),vtxx:String(x),vtxy:'35.83'}));
const from={number:'a',name:'출발',lon:127.105,lat:35.83},to={number:'b',name:'환승',lon:127.125,lat:35.83};
test('only the selected, forward section is clipped; off-route and unknown XY are rejected',()=>{
  const shape=parseShape(rows),result=clipShape(shape,from,to,{fromSeq:1,toSeq:3});
  assert.equal(result.status,'ready');assert.deepEqual(result.segment.coordinates[0],[127.105,35.83]);assert.deepEqual(result.segment.coordinates.at(-1),[127.125,35.83]);
  assert.equal(clipShape(shape,to,from,{fromSeq:1,toSeq:3}).segment,null);
  assert.equal(clipShape(shape,{...from,lat:35.9},to,{fromSeq:1,toSeq:3}).segment,null);
  assert.equal(clipShape(parseShape([{vtxx:'980000',vtxy:'1750000'}]),from,to,{}).status,'unsupported');
  assert.equal(clipShape(shape,from,to,{}).status,'unverified');
});
test('disconnected links and a repeated loop position do not get invented connectors',()=>{
  const disconnected=parseShape([...rows.slice(0,2),...rows.slice(2).map(r=>({...r,linkId:'b'}))]);
  assert.equal(disconnected.parts.length,2);assert.equal(clipShape(disconnected,from,to,{fromSeq:1,toSeq:3}).segment,null);
  const loop={status:'ready',parts:[[[127.10,35.83],[127.11,35.83],[127.12,35.83],[127.11,35.83],[127.13,35.83]]]};
  assert.equal(clipShape(loop,{...from,lon:127.11},{...to,lon:127.125},{fromSeq:1,toSeq:3}).segment,null);
});
test('explicit first shape query calls API once; cache restore never calls again',async()=>{
  let calls=0;const data=new Map(),store={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
  const client={get:async(source,operation,params)=>{calls++;assert.equal(source,'routes');assert.equal(operation,'bus_nosun_drawing_common');assert.deepEqual(params,{brtStdid:'route61'});return {rows};}};
  await Promise.all([getShapeOnQuery(client,store,'route61'),getShapeOnQuery(client,store,'route61')]);await getShapeOnQuery(client,store,'route61');assert.equal(calls,1);
});
test('saved sections survive local restore without fetching shapes',()=>{
  const segment=clipShape(parseShape(rows),from,to,{fromSeq:1,toSeq:3}).segment;
  const route={number:'61',routeId:'r',selected:true,shapeKey:'r',segment,geometryStatus:'ready'};
  const p={id:'x',name:'묶음',transfer:to,origins:[{stop:from,routes:[route]}],destinations:[{stop:{...from,number:'c'},routes:[{...route,number:'75'}]}]};
  const storage={value:null,getItem(){return this.value;},setItem(k,v){this.value=v;}};writePlan(storage,p);const saved=readPlans(storage)[0];
  assert.deepEqual(saved.origins[0].routes[0].segment,segment);assert.equal(saved.origins[0].routes[0].shapeKey,'r');
  assert.equal(cleanLine({type:'LineString',coordinates:[[Infinity,0],[1,2]]}),null);
});

test('legacy missing geometry is not reported as an API error, and new failures retain their reason',()=>{
  assert.match(geometryState({geometryStatus:'missing'}).label,/원인 미기록/);
  const state=geometryState({geometryStatus:'request-error',geometryMessage:'서비스 연결실패 에러'});
  assert.equal(state.label,'선형 조회 실패');assert.equal(state.detail,'서비스 연결실패 에러');
  const storage={value:null,getItem(){return this.value;},setItem(k,v){this.value=v;}};
  const r={number:'74',selected:true,geometryStatus:'request-error',geometryMessage:'서비스 연결실패 에러'};
  writePlan(storage,{id:'failure',name:'확인',transfer:to,origins:[{stop:from,routes:[r]}],destinations:[{stop:{...from,number:'c'},routes:[{...r,number:'75'}]}]});
  assert.equal(readPlans(storage)[0].origins[0].routes[0].geometryMessage,'서비스 연결실패 에러');
});
