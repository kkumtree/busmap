import {DOMParser} from '@xmldom/xmldom';
import {createClient,latestStopDataset,normalizeStop} from '../api.js';
import {queryDirectLeg,fetchStopSpec} from '../targeted.js';

const numbers=process.argv.slice(2);
if(numbers.length<2 || numbers.length>3 || numbers.some(n=>!/^\d+$/.test(n))) {
  console.error('사용법: npm run check:journey -- 출발번호 [환승번호] 도착번호');process.exit(1);
}
globalThis.DOMParser=DOMParser;
const key=process.env.DATA_GO_KR_SERVICE_KEY;
if(!key){console.error('.env에 DATA_GO_KR_SERVICE_KEY를 입력하세요.');process.exit(1);}
const client=createClient(source=>source==='routes' ? process.env.ROUTES_SERVICE_KEY||key : key);
try {
  const spec=await fetchStopSpec(),dataset=latestStopDataset(spec),points=[];
  for(const number of numbers) {
    const {rows}=await client.get('stops',dataset.path,{page:1,perPage:5,returnType:'JSON','cond[정류장번호::EQ]':number});
    const row=rows.find(r=>String(r['정류장번호'])===number);
    if(!row)throw new Error('선택한 정류장을 찾지 못했습니다.');
    points.push(normalizeStop(row));
  }
  console.log('선택 정류장:',points.map(p=>`${p.number} ${p.name}`).join(' → '));
  const ids=new Map(),entries={};
  for(let i=0;i<points.length-1;i++) {
    const result=await queryDirectLeg(client,points[i],points[i+1],{getSpec:async()=>spec,ids,entries});
    console.log(`${i+1}구간: 후보 ${result.examined}개만 조회`);
    console.log(result.routes.map(r=>({number:r.number,routeId:r.routeId,fromSeq:r.fromSeq,toSeq:r.toSeq,stopCount:r.stopCount})));
  }
  console.log('전체 노선 목록·전체 노선 정류장 수집은 수행하지 않았습니다.');
} catch (error) {
  let message=String(error.message);
  for(const value of [key,process.env.ROUTES_SERVICE_KEY].filter(Boolean))for(const variant of [value,encodeURIComponent(value)])message=message.split(variant).join('[인증키]');
  console.error('선택 구간 진단 실패:',message.slice(0,240));process.exitCode=1;
}
