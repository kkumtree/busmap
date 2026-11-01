import {DOMParser} from '@xmldom/xmldom';
import {buildURL, parsePayload, unpack, field} from '../api.js';

const key = process.env.ROUTES_SERVICE_KEY || process.env.DATA_GO_KR_SERVICE_KEY;
if (!key?.trim()) {
  console.error('.env의 DATA_GO_KR_SERVICE_KEY 또는 ROUTES_SERVICE_KEY에 인증키를 입력하세요.');
  process.exit(1);
}

// Only field names and counts are printed, never request URLs or body values.
function shape(value, depth=0) {
  if (Array.isArray(value)) return {arrayLength:value.length, item:depth<4 && value.length ? shape(value[0],depth+1) : undefined};
  if (value && typeof value === 'object') return depth<4 ? Object.fromEntries(Object.entries(value).slice(0,25).map(([k,v])=>[k,shape(v,depth+1)])) : Object.keys(value);
  return typeof value;
}
try {
  const url = buildURL('routes','bus_location_all_common',{},key);
  const response = await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error'});
  console.log('HTTP:',response.status,'Content-Type:',response.headers.get('content-type'));
  const payload = parsePayload(await response.text(),DOMParser);
  console.log('응답 구조:',JSON.stringify(shape(payload),null,2));
  try {
    const rows=unpack(payload);
    console.log('파싱된 노선:',rows.length,'/ 노선ID가 있는 항목:',rows.filter(r=>field(r,'brtStdid')).length);
    if(!response.ok || !rows.length) process.exitCode=1;
  } catch {
    console.error('API가 오류를 반환했습니다. 위 구조를 바탕으로 인증 오류 처리와 파서를 확인해야 합니다.');
    process.exitCode=1;
  }
} catch {
  console.error('진단 요청 또는 응답 해석에 실패했습니다. 키와 응답 원문은 출력하지 않았습니다.');
  process.exitCode=1;
}
