import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPlan,validatePlan,writePlan,readPlans,arrivalTargets,stopHint,PLANS_KEY} from '../plan-model.js';
const point=(number,name)=>({number,name,lat:null,lon:null});
const route=(number,selected=true)=>({number,selected});
const example=()=>({...emptyPlan(),id:'group',name:'내 환승',transfer:point('2','환승'),origins:[{stop:point('1','출발A'),routes:[route('61'),route('62'),route('63',false)]},{stop:point('3','출발B'),routes:[route('100')]}],destinations:[{stop:point('4','도착C'),routes:[route('74'),route('75')]},{stop:point('5','도착D'),routes:[route('200')]}]});
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};
test('multiple origins, destinations and checked routes persist per edge without credentials',()=>{
  const storage=memory(),p=example();p.apiKey='SECRET';p.origins[0].stop.apiKey='SECRET';
  writePlan(storage,p);const saved=readPlans(storage)[0];
  assert.equal(saved.origins.length,2);assert.equal(saved.destinations.length,2);
  assert.deepEqual(saved.origins[0].routes.map(r=>r.number),['61','62']);assert.deepEqual(saved.origins[1].routes.map(r=>r.number),['100']);
  assert.deepEqual(saved.destinations[0].routes.map(r=>r.number),['74','75']);
  assert.equal(storage.getItem(PLANS_KEY).includes('SECRET'),false);
  p.name='편집';writePlan(storage,p);assert.equal(readPlans(storage).length,1);assert.equal(readPlans(storage)[0].name,'편집');
});
test('arrival targets are origins and one transfer only, never destinations',()=>{
  const targets=arrivalTargets(example());assert.deepEqual(targets.map(t=>t.stop.number),['1','3','2']);
  assert.deepEqual(targets[2].routes.map(r=>r.number),['74','75','200']);
});
test('a transfer, both endpoint groups and a checked route for every endpoint are required',()=>{
  for(const change of [p=>p.transfer=null,p=>p.origins=[],p=>p.destinations=[],p=>p.origins[0].routes.forEach(r=>r.selected=false),p=>p.origins.push(p.origins[0]),p=>p.origins[0].stop=p.transfer]){const p=example();change(p);assert.throws(()=>validatePlan(p));}
});
test('metadata uses actual next stops and never infers direction from a number',()=>{
  const s=point('36346','만성도시상가');assert.equal(stopHint(s),'방면 미확인');
  assert.equal(stopHint({...s,direction:'법원'}),'법원 방면');
  assert.equal(stopHint(s,{route:{stops:[{number:'36346',name:'만성도시상가',seq:2},{number:'36351',name:'법원',seq:3}]}}),'다음 정류장: 법원');
  assert.equal(stopHint(point('36347','만성도시상가'),{route:{stops:[{number:'36346',name:'만성도시상가',seq:2},{number:'36351',name:'법원',seq:3}]}}),'방면 미확인');
});
test('corrupt saved data does not break startup or overwrite legacy journeys',()=>{
  const storage=memory();storage.setItem('busmap.journeys.v1','legacy');storage.setItem(PLANS_KEY,'broken');assert.deepEqual(readPlans(storage),[]);
  writePlan(storage,example());assert.equal(storage.getItem('busmap.journeys.v1'),'legacy');
});
