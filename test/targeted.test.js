import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {queryDirectLeg,identityDataset} from '../targeted.js';

const spec=JSON.parse(readFileSync(new URL('../docs/15080859.json',import.meta.url)));
const from={name:'출발',number:'30887',lat:35.832,lon:127.132};
const to={name:'환승',number:'30920',lat:35.834,lon:127.111};
const rows=[from,to].map((p,i)=>({'정류장명':p.name,'정류장번호':Number(p.number),'정류장ID':'JUB'+(306100887+i),'위도':String(p.lat),'경도':String(p.lon)}));

test('only selected stops and candidate route IDs are requested, never the empty-ID catalog',async()=>{
  const requests=[];
  const client={get:async(source,operation,params)=>{
    requests.push({source,operation,params});
    if(source==='stops'){
      assert.ok(['30887','30920'].includes(params['cond[정류장번호::EQ]']));
      return {rows:rows.filter(r=>String(r['정류장번호'])===params['cond[정류장번호::EQ]'])};
    }
    if(source==='realtime')return {rows:[{brtStdid:'route61',brtId:'61'}]};
    if(source==='transfer')return {rows:[]};
    assert.equal(operation,'bus_location_busstop_list_common');
    assert.equal(params.brtStdid,'route61');
    return {rows:[from,to].map((p,i)=>({stopKname:p.name,stopId:p.number,stopStandardid:String(306100887+i),brsSeqno:String(i+22)}))};
  }};
  const options={getSpec:async()=>spec,entries:{},ids:new Map()};
  const result=await queryDirectLeg(client,from,to,options);
  assert.deepEqual(result.routes.map(r=>r.number),['61']);assert.equal(result.examined,1);assert.equal(result.partial,true);
  assert.ok(requests.every(r=>r.operation!=='bus_location_all_common'));
  const firstCount=requests.filter(r=>r.source==='routes').length;
  await queryDirectLeg(client,from,to,options);
  assert.equal(requests.filter(r=>r.source==='routes').length,firstCount);
});
test('identity mapping uses a version with an ID column, and rejects a distant historical match',async()=>{
  assert.equal(identityDataset(spec).date,'2024-01-10');
  const client={get:async()=>({rows:[{...rows[0],'위도':'36.1'}]})};
  await assert.rejects(queryDirectLeg(client,from,to,{getSpec:async()=>spec}),/位置|위치|식별정보/);
});
