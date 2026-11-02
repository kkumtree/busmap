import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from '@xmldom/xmldom';
import {buildURL, parsePayload, unpack, normalizeStop, arrivalTime, createClient} from '../api.js';

test('raw and encoded keys, including +, are encoded exactly once', () => {
  for (const key of ['abc+/=', 'abc%2B%2F%3D']) {
    const url = buildURL('realtime', 'bus_location_low_busstop_infomation_common', {stopStdid:'000123', lKey:''}, key);
    assert.equal(url.searchParams.get('serviceKey'), 'abc+/=');
    assert.equal(url.searchParams.get('stopStdid'), '000123');
    assert.equal(url.searchParams.has('lKey'), false);
    assert.equal(url.hostname, 'apis.data.go.kr');
  }
  assert.throws(() => buildURL('routes', '', {}, ''), /인증키/);
  assert.throws(() => buildURL('https://example.com', '', {}, 'key'), /지원하지/);
});
test('gateway XML supports single, multiple, empty and absent records', () => {
  const parse = xml => unpack(parsePayload(xml, DOMParser));
  const row = '<list><stopStandardid>000123</stopStandardid><stopKname>전주&amp;정류장</stopKname></list>';
  assert.deepEqual(parse(`<response><code>000</code><routeList>${row}</routeList></response>`), [{stopStandardid:'000123', stopKname:'전주&정류장'}]);
  assert.equal(parse(`<response><code>0</code><routeList>${row}${row}</routeList></response>`).length, 2);
  assert.deepEqual(parse('<response><code>00</code><routeList/></response>'), []);
  assert.deepEqual(parse('<response><code>0</code><routeList><list/></routeList></response>'), []);
});
test('HTTP 200 error payloads are not mistaken for empty success', () => {
  const payload = parsePayload('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>등록되지 않은 키</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>', DOMParser);
  assert.throws(() => unpack(payload), /등록되지 않은/);
  assert.throws(() => unpack({code:-4,msg:'인증 오류'}), /인증 오류/);
});
test('ODcloud keeps stop numbers as strings and never invents standard IDs', () => {
  const rows = unpack(parsePayload('{"totalCount":1,"data":[{"정류장명":"전주역","정류장번호":"00123","위도":"35.849","경도":"127.161"}]}'));
  assert.deepEqual(normalizeStop(rows[0]), {name:'전주역',number:'00123',lat:35.849,lon:127.161});
  assert.equal(Object.hasOwn(normalizeStop(rows[0]),'standardId'), false);
});
test('arrival seconds handle zero, missing and invalid values', () => {
  assert.equal(arrivalTime('0'), '곧 도착');
  assert.equal(arrivalTime('61'), '약 2분');
  assert.equal(arrivalTime('600'), '약 10분');
  for (const v of ['', null, '-1', 'NaN']) assert.equal(arrivalTime(v), '시간 미제공');
});
test('client reports provider errors without echoing credentials', async t => {
  const key = 'my-secret-key';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({code:30,msg:'bad '+key}), {status:403}));
  await assert.rejects(createClient(() => key).get('stops','/15080859/v1/uddi:aaaa-bbbb'), e => !e.message.includes(key) && e.message.includes('[인증키]'));
});
test('request observer counts attempts including failures, but not missing-key validation',async t=>{
  const counts={stops:0,routes:0,realtime:0,transfer:0};
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:'05',msg:'연결 실패'}),{status:503}));
  const client=createClient(()=> 'fixture-key',{onRequest:source=>counts[source]++});
  await assert.rejects(client.get('routes','bus_location1_common',{brtId:'101'}),/연결 실패/);
  client.reset();
  await assert.rejects(client.get('transfer','bus_stop_drawing_common',{}),/연결 실패/);
  assert.deepEqual(counts,{stops:0,routes:1,realtime:0,transfer:1});
  await assert.rejects(createClient(()=>'',{onRequest:()=>assert.fail('No request was made')}).get('routes','bus_location1_common'),/인증키/);
});
