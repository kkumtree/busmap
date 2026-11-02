import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {queryDirectLeg,identityDataset,resolveStopIdentity,loadMappingCatalog,buildMappingBatch} from '../targeted.js';
const spec=JSON.parse(readFileSync(new URL('../docs/15080859.json',import.meta.url)));
const from={name:'출발',number:'30887',lat:35.832,lon:127.132};
const to={name:'환승',number:'30920',lat:35.834,lon:127.111};
const stopRows=[from,to].map((p,i)=>({stopKname:p.name,stopId:p.number,stopStandardid:String(306100887+i),brsSeqno:String(i+22)}));

test('static memberships remain selectable after service ends, without any API request',async()=>{
  const client={get:()=>{throw new Error('No API should be called');}};
  const entries={r61:{number:'61',date:1,stops:[from,to].map((p,i)=>({...p,seq:22+i,standardId:String(306100887+i)}))},reverse:{number:'61',stops:[to,from].map((p,i)=>({...p,seq:i}))}};
  const result=await queryDirectLeg(client,from,to,{entries,mapping:{complete:true}});
  assert.deepEqual(result.routes.map(r=>r.routeId),['r61']);assert.equal(result.partial,false);
  assert.equal((await queryDirectLeg(client,from,to,{entries})).partial,true);
});
test('missing static mapping requires an explicit preparation, never a realtime fallback',async()=>{
  await assert.rejects(queryDirectLeg({get:()=>assert.fail('Unexpected API')},from,to),/매핑/);
});
test('mapping discovers IDs by number, caches stops, and respects a per-click budget',async()=>{
  const calls=[];
  const client={get:async(source,op,params)=>{assert.equal(source,'routes');calls.push(op);
    if(op==='bus_location_all_common')return {rows:[{brtId:'61',brtStdid:''},{brtId:'74',brtStdid:''}]};
    if(op==='bus_location1_common')return {rows:[{brtStdid:'r'+params.brtId,brtId:params.brtId,brtSname:'시작',brtEname:'끝'}]};
    assert.equal(op,'bus_location_busstop_list_common');return {rows:stopRows};
  }};
  const mapping=await loadMappingCatalog(client),entries={};let saves=0;
  const batch=await buildMappingBatch(client,mapping,entries,{limit:2,save:()=>saves++});
  assert.equal(batch.calls,2);assert.equal(mapping.complete,false);assert.equal(entries.r61.number,'61');
  await buildMappingBatch(client,mapping,entries,{limit:2});
  assert.equal(mapping.complete,true);assert.equal(calls.filter(op=>op==='bus_location_busstop_list_common').length,2);assert.ok(saves>=2);
  const count=calls.length;await buildMappingBatch(client,mapping,entries);assert.equal(calls.length,count);
});
test('mapping stops on the first provider failure and keeps completed progress',async()=>{
  const mapping={numbers:[{number:'61',extension:'',done:false},{number:'74',extension:'',done:false}],routes:[]},entries={};let calls=0;
  const client={get:async(source,op)=>{calls++;if(op==='bus_location1_common')return {rows:[{brtStdid:'r61',brtId:'61'}]};throw new Error('서비스 연결실패 에러');}};
  await assert.rejects(buildMappingBatch(client,mapping,entries),/서비스 연결실패/);
  assert.equal(calls,2);assert.equal(mapping.numbers[0].done,true);assert.equal(mapping.numbers[1].done,false);assert.equal(mapping.routes[0].done,false);
});
test('mapping cancellation makes no further calls',async()=>{
  let calls=0;const client={get:()=>{calls++;assert.fail('Unexpected call');}};
  await assert.rejects(buildMappingBatch(client,{numbers:[{number:'61'}],routes:[]},{},{check:()=>{throw new DOMException('중단','AbortError');}}),{name:'AbortError'});
  assert.equal(calls,0);
});
test('identity mapping uses a version with an ID column and rejects a distant historical match',async()=>{
  assert.equal(identityDataset(spec).date,'2024-01-10');
  const client={get:async()=>({rows:[{'정류장번호':30887,'정류장ID':'JUB306100887','위도':'36.1','경도':String(from.lon)}]})};
  await assert.rejects(resolveStopIdentity(client,from,spec),/위치|식별정보/);
});
