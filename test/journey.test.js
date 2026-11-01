import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {latestStopDataset,buildURL} from '../api.js';
import {findDirectRoutes,routeStop,journeyLegs,saveJourney,readJourneys,matchesStop,SAVED_KEY} from '../journey.js';

const a={name:'A',number:'001',lat:35.81,lon:127.11};
const b={name:'B',number:'002',lat:35.82,lon:127.12};
const c={name:'C',number:'003',lat:35.83,lon:127.13};
const stop=(p,seq)=>({...p,number:String(Number(p.number)),standardId:'std-'+p.number,seq});
const route=(id,points)=>({id,number:id,direction:'상행',destination:'C',stops:points.map((p,i)=>stop(p,i+1))});
function memory(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};}

test('latest dataset is selected by date, not Swagger property order or pinned UUID',()=>{
  const spec=JSON.parse(readFileSync(new URL('../docs/15080859.json',import.meta.url)));
  assert.equal(latestStopDataset(spec).date,'2026-02-12');
  const next='/15080859/v1/uddi:aaaa-bbbb';
  spec.paths={...spec.paths,[next]:{get:{summary:'정류장_20270212'}}};
  assert.equal(latestStopDataset(spec).path,next);
  assert.equal(buildURL('stops',next,{page:1},'key').pathname,'/api'+next);
  assert.throws(()=>latestStopDataset({paths:{}}),/최신/);
  assert.throws(()=>buildURL('stops','https://other.example/key',{},'key'),/경로/);
});
test('only the same route in the correct stop order is a direct option',()=>{
  const index=[route('101',[a,b,c]),route('202',[a,b]),route('303',[b,c]),route('404',[c,b,a])];
  assert.deepEqual(findDirectRoutes(index,a,c).map(r=>r.number),['101']);
  const legs=journeyLegs({from:a,via:b,to:c});
  assert.equal(legs.length,2);
  assert.deepEqual(findDirectRoutes(index,legs[0].from,legs[0].to).map(r=>r.number),['101','202']);
  assert.deepEqual(findDirectRoutes(index,legs[1].from,legs[1].to).map(r=>r.number),['101','303']);
  assert.deepEqual(findDirectRoutes(index,c,a).map(r=>r.number),['404']);
  assert.equal(journeyLegs({from:a,via:null,to:c}).length,1);
  assert.throws(()=>journeyLegs({from:a,via:a,to:c}),/서로 다른/);
});
test('opposite platforms and same names do not create a guessed stop join',()=>{
  assert.equal(matchesStop(a,stop(a,1)),true);
  assert.equal(matchesStop(a,stop({...a,number:'999'},1)),false);
  assert.equal(matchesStop(a,stop({...a,name:'다른 이름'},1)),false);
  assert.ok(Number.isNaN(routeStop({stopKname:'A',stopId:'001'}).seq));
  const loop=route('loop',[b,c,a,b,c]);
  assert.equal(findDirectRoutes([loop],a,c)[0].fromSeq,3);
  assert.equal(findDirectRoutes([loop],a,c)[0].toSeq,5);
});
test('direct and one-transfer journeys both survive reload without API keys',()=>{
  const storage=memory(), index=[route('101',[a,c]),route('202',[a,b]),route('303',[b,c])];
  const direct=findDirectRoutes(index,a,c)[0];
  saveJourney(storage,{id:'direct',name:'직행',points:{from:a,via:null,to:c},routes:[direct],apiKey:'DO-NOT-SAVE'});
  const transfer=journeyLegs({from:a,via:b,to:c}).map(l=>findDirectRoutes(index,l.from,l.to)[0]);
  saveJourney(storage,{id:'transfer',name:'환승',points:{from:a,via:b,to:c},routes:transfer,apiKey:'DO-NOT-SAVE'});
  const loaded=readJourneys(storage);
  assert.equal(loaded.length,2);assert.equal(loaded[0].routes.length,2);assert.equal(loaded[1].routes.length,1);
  assert.equal(loaded[0].points.via.name,'B');
  assert.equal(storage.getItem(SAVED_KEY).includes('DO-NOT-SAVE'),false);
  storage.setItem(SAVED_KEY,'invalid');assert.deepEqual(readJourneys(storage),[]);
});
test('bad or incomplete journeys cannot be saved',()=>{
  const storage=memory();
  assert.throws(()=>saveJourney(storage,{id:'bad',name:'미완성',points:{from:a,via:b,to:c},routes:[]}),/확인/);
});
