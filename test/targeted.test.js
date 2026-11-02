import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {queryDirectLeg,identityDataset,resolveStopIdentity} from '../targeted.js';
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
test('missing static memberships never fall back to realtime',async()=>{
  await assert.rejects(queryDirectLeg({get:()=>assert.fail('Unexpected API')},from,to),/경유/);
});
test('identity mapping uses a version with an ID column and rejects a distant historical match',async()=>{
  assert.equal(identityDataset(spec).date,'2024-01-10');
  const client={get:async()=>({rows:[{'정류장번호':30887,'정류장ID':'JUB306100887','위도':'36.1','경도':String(from.lon)}]})};
  await assert.rejects(resolveStopIdentity(client,from,spec),/위치|식별정보/);
});
