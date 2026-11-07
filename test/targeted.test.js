import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ApiRequestError} from '../api.js';
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

test('service interruption reuses fresh ordered stops only within known membership, without a retry',async()=>{
  const stops=[{...from,seq:2},{...to,seq:5}];
  const row={number:'61',date:Date.now(),stops};
  const entries={allowed:row,excluded:row,expired:{...row,date:Date.now()-86400001},reverse:{...row,stops:[{...to,seq:2},{...from,seq:5}]}};
  let calls=0;
  const client={get:async()=>{calls++;if(calls===1)return {rows:['allowed','expired','reverse'].map(id=>({brtStdId:id}))};throw new ApiRequestError('HTTP 503','busstop',true);}};
  const result=await queryDirectLeg(client,from,to,{entries});
  assert.equal(calls,2);assert.equal(result.partial,true);assert.equal(result.error,'HTTP 503');
  assert.deepEqual(result.routes.map(r=>r.routeId),['allowed']);
  assert.deepEqual((await queryDirectLeg(client,{...from,standardId:''},to,{entries})).routes.map(r=>r.routeId).sort(),['allowed','excluded']);
  await assert.rejects(queryDirectLeg(client,{...from,standardId:'',name:'다른 정류장'},to,{entries}),/HTTP 503/);
});

test('503 with no cached IDs checks a leg-specific static route sequence once',async()=>{
  const route='305001089',calls=[];
  const client={get:async(source,op,params)=>{
    calls.push([source,op]);
    if(source==='busstop')throw new ApiRequestError('HTTP 503','busstop',true);
    assert.deepEqual(params,{brtStdid:route});
    return {rows:stopRows([from,to]).map(r=>({...r,brtStdid:route}))};
  }};
  const options={routeHints:{'30887:30920':[[route,'61']]}};
  const result=await queryDirectLeg(client,{...from,standardId:''},{...to,standardId:''},options);
  assert.deepEqual(result.routes.map(r=>[r.routeId,r.fromStandardId,r.toStandardId]),[[route,from.standardId,to.standardId]]);
  assert.equal(result.partial,true);
  assert.deepEqual(calls,[['busstop','bus_location2_stopno_common'],['routes','bus_location_busstop_list_common']]);
});

test('route hints reject reversed, conflicting, and mismatched platforms',async()=>{
  const route='305001089';
  for(const stops of [[to,from],[from,{...from,standardId:'305123456'},to],[{...from,name:'다른 승강장'},to]]){
    const result=await queryDirectLeg({get:async(s)=>{
      if(s==='busstop')throw new ApiRequestError('HTTP 503','busstop',true);
      return {rows:stopRows(stops).map(r=>({...r,brtStdid:route}))};
    }},{...from,standardId:''},{...to,standardId:''},{routeHints:{'30887:30920':[[route,'61']]}});
    assert.deepEqual(result.routes,[]);assert.equal(result.partial,true);
  }
});

test('a second service outage preserves the two failures and does not try additional IDs',async()=>{
  for(const status of [403,503]){
    const calls=[];
    const client={get:async(source)=>{calls.push(source);throw new ApiRequestError(source==='busstop'?'HTTP '+status:'노선 서비스 연결 실패',source,status===503);}};
    await assert.rejects(queryDirectLeg(client,{...from},{...to},{routeHints:{'30887:30920':[['305001089','61'],['305001090','61']]}}),status===503?/503.*노선 서비스 연결 실패/:/403/);
    assert.deepEqual(calls,status===503?['busstop','routes']:['busstop']);
  }
});

test('recorded public 101 sequence confirms the actual pair from a cold 503',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/101-section.json',import.meta.url)));
  const {default:region}=await import('../regions/jeonju.js');
  const client={get:async(source,op,params)=>{
    if(source==='busstop')throw new ApiRequestError('HTTP 503','busstop',true);
    assert.equal(op,'bus_location_busstop_list_common');assert.equal(params.brtStdid,fixture.route.routeId);
    return {rows:fixture.stops.map(s=>({stopKname:s.name,stopId:s.number,stopStandardid:s.standardId,brsSeqno:String(s.seq),brtStdid:params.brtStdid}))};
  }};
  const actual=await queryDirectLeg(client,{...fixture.from,standardId:''},{...fixture.to,standardId:''},{routeHints:region.routeHints});
  assert.deepEqual(actual.routes.map(r=>[r.number,r.fromSeq,r.toSeq]),[['101',31,38]]);
});

test('registered platforms bypass name lookup only for matching number and position',async()=>{
  const {cachedPlatformId}=await import('../targeted.js');
  const {default:region}=await import('../regions/jeonju.js');
  const p={...region.platforms[1],standardId:'',name:'변경된 표시명'};
  assert.equal(cachedPlatformId(p,{},region.platforms),'305032417');
  assert.equal(cachedPlatformId({...p,number:'36348'},{},region.platforms),'');
  assert.equal(cachedPlatformId({...p,lat:p.lat+.001},{},region.platforms),'');
  const entries={route:{date:Date.now(),stops:[{...p,standardId:'305032418'}]}};
  assert.equal(cachedPlatformId(p,entries,region.platforms),'');
});

test('platform name change requires unique public number and close coordinates',async()=>{
  const row={stopId:from.number,stopKname:'새 정류장명',stopStandardid:from.standardId,stopX:from.lon,stopY:from.lat};
  const resolve=rows=>resolvePlatformIdentity({get:async()=>({rows})},{...from,standardId:''});
  assert.equal(await resolve([row]),from.standardId);
  await assert.rejects(resolve([{...row,stopY:''}]),/하나로/);
  await assert.rejects(resolve([row,{...row,stopStandardid:'306100888'}]),/하나로/);
});
