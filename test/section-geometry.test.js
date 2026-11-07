import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSection,parseShape,clipShape,getSectionOnQuery,sectionRequest,sectionCacheKey,readSectionCache,cleanLine} from '../route-geometry.js';
import {sectionAnchors} from '../journey.js';
import {writePlan,readPlans} from '../plan-model.js';
const f=JSON.parse(readFileSync(new URL('./fixtures/101-section.json',import.meta.url)));
const options={anchors:sectionAnchors(f.stops,f.localStops,f.route)};
const store=()=>{const m=new Map();return {data:m,get:async k=>m.get(k),put:async(k,v)=>m.set(k,v)};};
test('retained 101 response validates six intermediate stops without drawing across link gaps',()=>{
  assert.equal(f.rows.length,90);assert.equal(options.anchors.length,6);
  assert.equal(clipShape(parseShape(f.rows),f.from,f.to,f.route).status,'ambiguous');
  const section=parseSection(f.rows,f.from,f.to,f.route,options);
  assert.equal(section.status,'ready');assert.equal(section.diagnostics.choiceCount,1);
  assert.equal(section.diagnostics.maxGapMeters,27.1);
  assert.equal(section.segment.type,'MultiLineString');assert.equal(section.segment.coordinates.length,16);
  // Separate links stay separate; a road segment is never invented at a gap.
  assert.notDeepEqual(section.segment.coordinates[11].at(-1),section.segment.coordinates[12][0]);
});
test('section requests use verified standard IDs and mode 1 for an independent direct ride',()=>{
  assert.deepEqual(sectionRequest(f.route,f.from,f.to),f.request);
  assert.throws(()=>sectionRequest(f.route,{...f.from,standardId:'306100887'},f.to),/일치/);
  assert.throws(()=>sectionRequest({...f.route,routeId:'101/invalid'},f.from,f.to),/확인/);
  assert.notEqual(sectionCacheKey(f.route,f.from,f.to),sectionCacheKey({...f.route,toStandardId:'305032417',toSeq:39},f.from,{...f.to,standardId:'305032417'}));
});
test('wrong positions, stop order and coordinate systems are rejected',()=>{
  assert.equal(parseSection(f.rows,{...f.from,lat:35.9},f.to,f.route,options).status,'ambiguous');
  assert.equal(parseSection(f.rows,f.from,f.to,{...f.route,fromSeq:40},options).status,'unverified');
  assert.equal(parseSection(f.rows,f.from,f.to,f.route,{anchors:[{lon:127.2,lat:35.9}]}).diagnostics.reason,'stop-order-mismatch');
  assert.equal(parseSection([{linkId:'a',vtxSeq:'1',vtxx:'980000',vtxy:'1750000'}],f.from,f.to,f.route).status,'unsupported');
  assert.equal(parseSection([],f.from,f.to,f.route).status,'missing');
});
test('section raw response is scoped by route/endpoints and reused without extra requests',async()=>{
  const cache=store();cache.data.set(f.route.routeId,parseShape(f.rows));let calls=0;
  const client={get:async(source,op,params)=>{calls++;assert.equal(source,'transfer');assert.equal(op,'bus_stop_drawing_common');assert.deepEqual(params,f.request);return {rows:f.rows};}};
  const results=await Promise.all([getSectionOnQuery(client,cache,f.route,f.from,f.to,options),getSectionOnQuery(client,cache,f.route,f.from,f.to,options)]);
  assert.equal(calls,1);assert.ok(results.every(r=>r.segment));
  const restored=await getSectionOnQuery(client,cache,f.route,f.from,f.to,options);assert.equal(calls,1);
  const record=cache.data.get(restored.shapeKey);assert.equal(record.rawRows.length,90);
  assert.equal(readSectionCache(record,f.route,f.from,f.to,options).status,'ready');
  assert.equal(readSectionCache({...record,request:{...record.request,sStdId3:'305032417'}},f.route,f.from,f.to,options),null);
});
test('provider error stops after one request, without an automatic alternate API or parameter retry',async()=>{
  let calls=0;const client={get:async()=>{calls++;throw new Error('서비스 연결실패 에러');}};
  await assert.rejects(getSectionOnQuery(client,store(),f.route,f.from,f.to,options),/서비스 연결실패/);assert.equal(calls,1);
});
test('multipart sections, provenance and failure diagnostics survive saved-plan reload',()=>{
  const section=parseSection(f.rows,f.from,f.to,f.route,options);
  const route={...f.route,selected:true,verified:true,segment:section.segment,geometryStatus:section.status,geometrySource:'transfer/bus_stop_drawing_common',geometryVersion:1,geometryDiagnostics:section.diagnostics};
  const storage={data:null,getItem(){return this.data;},setItem(k,v){this.data=v;}};
  writePlan(storage,{id:'retained101',name:'구간 검증',transfer:f.from,origins:[{stop:{...f.from,number:'origin'},routes:[route]}],destinations:[{stop:f.to,routes:[route]}]});
  const saved=readPlans(storage)[0].destinations[0].routes[0];
  assert.deepEqual(saved.segment,section.segment);assert.equal(saved.geometryDiagnostics.anchorCount,6);assert.equal(saved.geometrySource,route.geometrySource);
  assert.equal(cleanLine({type:'MultiLineString',coordinates:[[[127.1,35.8]]]}),null);
});
test('local anchor matching skips conflicting coordinates instead of guessing',()=>{
  assert.equal(sectionAnchors(f.stops,[...f.localStops,{...f.localStops[0],lon:f.localStops[0].lon+0.001}],f.route).length,5);
});

test('duplicate section vertices are safe only when their positions agree',()=>{
  const duplicate=f.rows[0];
  assert.equal(parseSection([...f.rows.slice(0,1),duplicate,...f.rows.slice(1)],f.from,f.to,f.route,options).status,'ready');
  const rows=[duplicate,{...duplicate,vtxx:'127.12'},...f.rows.slice(1)];
  assert.equal(parseSection(rows,f.from,f.to,f.route,options).diagnostics.reason,'conflicting-vertex');
});
