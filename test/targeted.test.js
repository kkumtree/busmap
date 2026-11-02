import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {queryDirectLeg,resolvePlatformIdentity,identityDataset,resolveStopIdentity} from '../targeted.js';
const spec=JSON.parse(readFileSync(new URL('../docs/15080859.json',import.meta.url)));
const from={name:'출발',number:'30887',lat:35.832,lon:127.132,standardId:'306100887'};
const to={name:'환승',number:'30920',lat:35.834,lon:127.111,standardId:'305100920'};
const stopRows=points=>points.map((p,i)=>({stopKname:p.name,stopId:p.number,stopStandardid:p.standardId,brsSeqno:String(i+22)}));
test('static stop memberships intersect before sequence queries, without realtime or catalogs',async()=>{
  const calls=[],entries={};
  const client={get:async(source,op,params)=>{
    calls.push({source,op,params});
    if(source==='busstop'){
      assert.equal(op,'general_busstop_common');
      assert.ok([from.standardId,to.standardId].includes(params.stopStandardid));
      const rows=[{brtStdId:'r61',brtId:'61'},{brtStdId:'reverse',brtId:'61'}];
      if(params.stopStandardid===from.standardId)rows.push({brtStdId:'onlyFrom',brtId:'200'});
      return {rows};
    }
    assert.equal(source,'routes');assert.equal(op,'bus_location_busstop_list_common');assert.notEqual(params.brtStdid,'onlyFrom');
    return {rows:stopRows(params.brtStdid==='reverse'?[to,from]:[from,to])};
  }};
  const result=await queryDirectLeg(client,{...from},{...to},{entries});
  assert.deepEqual(result.routes.map(r=>r.routeId),['r61']);assert.equal(result.examined,2);assert.equal(result.partial,false);
  await queryDirectLeg(client,{...from},{...to},{entries});
  assert.equal(calls.filter(r=>r.source==='routes').length,2);
  assert.equal(calls.filter(r=>r.source==='busstop').length,4);
});
test('current platform lookup requests one stop number and caches its validated standard ID',async()=>{
  let calls=0;const ids=new Map();const point={...from,standardId:''};
  const client={get:async(source,op,params)=>{calls++;assert.equal(source,'busstop');assert.equal(op,'bus_location2_stopno_common');assert.deepEqual(params,{searchNm:'30887'});return {rows:[{stopId:'30887',stopKname:'출발',stopStandardid:from.standardId,stopX:127.132,stopY:35.832}]};}};
  assert.equal(await resolvePlatformIdentity(client,point,ids),from.standardId);
  assert.equal(await resolvePlatformIdentity(client,{...from,standardId:''},ids),from.standardId);assert.equal(calls,1);
});
test('ambiguous platform IDs are rejected rather than guessed',async()=>{
  const client={get:async()=>({rows:[{stopId:'30887',stopKname:'출발',stopStandardid:'306100887'},{stopId:'30887',stopKname:'출발',stopStandardid:'306100888'}]})};
  await assert.rejects(resolvePlatformIdentity(client,{...from,standardId:''}),/하나로/);
});
test('provider failure stops immediately without retries or realtime fallback',async()=>{
  let calls=0;const client={get:async(source,op)=>{calls++;assert.equal(source,'busstop');assert.equal(op,'general_busstop_common');throw new Error('서비스 연결실패 에러');}};
  await assert.rejects(queryDirectLeg(client,{...from},{...to}),/서비스 연결실패/);assert.equal(calls,1);
});
test('identity mapping uses a version with an ID column and rejects a distant historical match',async()=>{
  assert.equal(identityDataset(spec).date,'2024-01-10');
  const client={get:async()=>({rows:[{'정류장번호':30887,'정류장ID':'JUB306100887','위도':'36.1','경도':String(from.lon)}]})};
  await assert.rejects(resolveStopIdentity(client,from,spec),/위치|식별정보/);
});
