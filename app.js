import * as ML from './vendor/maplibre-gl.mjs';
import {createClient,latestStopDataset,normalizeStop,arrivalTime,field as f} from './api.js';
import {queryDirectLeg,fetchStopSpec,resolveStopIdentity} from './targeted.js';
import {readJourneys} from './journey.js';
import {networkView} from './network-view.js';
import {shapeStore} from './shape-cache.js';
import {getShapeOnQuery,clipShape,geometryState} from './route-geometry.js';
import {PLANS_KEY,emptyPlan,cleanPoint,cleanRoute,pointKey,validatePlan,readPlans,writePlan,arrivalTargets,stopHint} from './plan-model.js';
import {DEFAULT_REGION_ID,regionById,inRegion,applyRegion} from './regions/index.js';

const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let storage;try{storage=localStorage;}catch{storage={getItem:()=>null,setItem:()=>{throw new Error('브라우저의 로컬 저장이 차단되어 있습니다.');}};}
const read=(key,fallback)=>{try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}};
let focused='',geometryVersion=0,routeFeatures={type:'FeatureCollection',features:[]};
const shapes=shapeStore();
let plan=emptyPlan(),tab='plan',activeRole='origin',service={from:null,to:null},viewedPlan=null;
let keys={},version=0,loading=false,popup,toastTimer,specPromise,deleted;
const callCounts={stops:0,routes:0,realtime:0,transfer:0,busstop:0};
const client=createClient(source=>keys[source]||keys.default||'',{onRequest:source=>{$('calls-'+source).textContent=++callCounts[source];}});
const region=regionById(DEFAULT_REGION_ID);
const labelLayers=[['show-dong','legal-dong-names'],['show-neighbourhoods','neighbourhood-names'],['show-schools','school-names'],['show-public','public-facility-names'],['show-rail','railway-station-names'],['show-terminals','bus-terminal-names'],['show-medical','medical-facility-names'],['show-parks','park-place-names']];
const ids=new Map(),markers=[],pending=new Set();
const cache=read('busmap.route-stops.v2',{}),entries=cache&&typeof cache==='object'&&!Array.isArray(cache)?cache:{};
const stopCache=read('busmap.stops.v1',{});
let stops=Array.isArray(stopCache.stops)?stopCache.stops.filter(s=>s && typeof s.number==='string' && typeof s.name==='string'):[];
const legacy=readJourneys(storage);
// Reuse previously verified route memberships without making a request.
for(const saved of readPlans(storage))for(const edge of [...saved.origins,...saved.destinations])for(const route of edge.routes)if(route.verified&&entries[route.routeId]?.stops)Object.assign(entries[route.routeId],{number:route.number,direction:route.direction||'',destination:route.destination||''});
let datasetLabel='';
function tell(s){$('notice').textContent=s;$('notice').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('notice').hidden=true,6500);}
function message(el,s,bad=false){el.replaceChildren();const p=document.createElement('p');p.className=bad?'error':'small-note';p.textContent=s;el.append(p);}
function stopLabel(s){return `${esc(s.name)} <small class="stop-number">${esc(s.number)}</small>`;}
function meta(s){return `<span class="stop-meta">${esc(stopHint(s,entries))}</span>`;}
function validCoordinates(s){return s && Number.isFinite(s.lat)&&Number.isFinite(s.lon)&&s.lat>30&&s.lat<40&&s.lon>120&&s.lon<135;}
function edit(){focused='';clearLines();++version;client.reset();viewedPlan=null;$('plan-message').textContent='';}
function requireKeys(sources){if(sources.every(s=>keys[s]||keys.default))return true;$('settings').showModal();tell('API 키를 입력한 뒤 조회 버튼을 다시 눌러 주세요.');return false;}
async function getSpec(){if(!specPromise)specPromise=fetchStopSpec().catch(e=>{specPromise=null;throw e;});return specPromise;}
async function hydrate(s){
  if(validCoordinates(s))return s;
  const spec=await getSpec(),dataset=latestStopDataset(spec);
  const {rows}=await client.get('stops',dataset.path,{page:1,perPage:5,returnType:'JSON','cond[정류장번호::EQ]':s.number});
  const row=rows.find(r=>String(r['정류장번호'])===s.number);
  if(!row)throw new Error(`${s.number}: 정류장을 찾지 못했습니다.`);
  Object.assign(s,normalizeStop(row));return s;
}
async function standard(s){if(/^\d{9}$/.test(s.standardId||''))return s.standardId;await hydrate(s);s.standardId=await resolveStopIdentity(client,s,await getSpec(),ids,()=>{});return s.standardId;}

ML.setWorkerUrl(new URL('./vendor/maplibre-gl-worker.mjs',import.meta.url).href);
// 지도 +/− 바로 아래에 붙는 레이어 선택 버튼(모달 아님, 지도 위 작은 팝오버).
class LayerToggleControl{
  constructor(panel){this.panel=panel;this.button=null;
    this.handleClick=e=>{if(this.panel.contains(e.target)||this.button?.contains(e.target))return;this.close();};
    this.handleKey=e=>{if(e.key==='Escape')this.close();};}
  onAdd(){
    const div=document.createElement('div');div.className='maplibregl-ctrl maplibregl-ctrl-group layer-toggle';
    const b=document.createElement('button');b.type='button';b.className='layer-toggle-button';b.title='레이어 선택';b.setAttribute('aria-label','지도 레이어 선택');b.setAttribute('aria-expanded','false');
    b.innerHTML='<svg class="layer-icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.4 15.1 10.9 10.7a2.4 2.4 0 0 1 2.2 0l8.5 4.4c.9.5.9 1.7 0 2.2l-8.5 4.4a2.4 2.4 0 0 1-2.2 0l-8.5-4.4c-.9-.5-.9-1.7 0-2.2Z"/><path d="M2.4 7.1 10.9 2.7a2.4 2.4 0 0 1 2.2 0l8.5 4.4c.9.5.9 1.7 0 2.2l-8.5 4.4a2.4 2.4 0 0 1-2.2 0L2.4 9.3c-.9-.5-.9-1.7 0-2.2Z"/></svg>';
    b.onclick=()=>{if(this.panel.hidden)this.open();else this.close();};
    div.append(b);this.button=b;return div;
  }
  onRemove(){this.close();this.button?.parentNode?.remove();}
  open(){this.panel.hidden=false;this.button?.setAttribute('aria-expanded','true');document.addEventListener('click',this.handleClick);document.addEventListener('keydown',this.handleKey);}
  close(){this.panel.hidden=true;this.button?.setAttribute('aria-expanded','false');document.removeEventListener('click',this.handleClick);document.removeEventListener('keydown',this.handleKey);}
}
let map;
try{
  map=new ML.Map({container:'map',style:region.mapStyle,center:[...region.center],zoom:region.zoom,attributionControl:false,pitchWithRotate:false,dragRotate:false,locale:{'GeolocateControl.FindMyLocation':'현재 위치로 이동','GeolocateControl.LocationNotAvailable':'현재 위치를 확인할 수 없습니다'}});
  map.addControl(new ML.NavigationControl({showCompass:false}),'top-right');map.addControl(new LayerToggleControl($('layer-menu')),'top-right');const locate=new ML.GeolocateControl({positionOptions:{enableHighAccuracy:false,timeout:10000},trackUserLocation:false,showAccuracyCircle:true,fitBoundsOptions:{maxZoom:15.5}});map.addControl(locate,'bottom-right');locate.on('error',()=>tell('현재 위치를 확인하지 못했습니다. 브라우저 위치 권한과 기기 위치 설정을 확인하세요.'));map.addControl(new ML.AttributionControl({compact:false}),'bottom-right');
  map.on('error',()=>{$('map-error').textContent='배경지도 연결을 확인하세요. 정류장 선택과 로컬 저장은 계속 사용할 수 있습니다.';$('map-error').hidden=false;});
  map.on('load',()=>{
    map.addSource('route-sections',{type:'geojson',data:routeFeatures});
    map.addLayer({id:'route-section-halo',type:'line',source:'route-sections',paint:{'line-color':'#fff','line-width':8,'line-opacity':.85}});
    map.addLayer({id:'route-section-lines',type:'line',source:'route-sections',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':['get','color'],'line-width':4,'line-offset':['get','offset']}});
    map.addLayer({id:'route-section-numbers',type:'symbol',source:'route-sections',layout:{'symbol-placement':'line','text-field':['get','number'],'text-font':['Noto Sans Regular'],'text-size':12},paint:{'text-color':'#214f36','text-halo-color':'#fff','text-halo-width':2}});
    map.addSource('bus-stops',{type:'geojson',data:features(),cluster:true,clusterRadius:75,clusterMaxZoom:14});
    const stopVisibility=$('stop-picker').open?'visible':'none';
    map.addLayer({id:'stop-clusters',type:'circle',source:'bus-stops',filter:['has','point_count'],layout:{visibility:stopVisibility},paint:{'circle-color':'#fdfbf5','circle-stroke-color':'#79736a','circle-stroke-width':1.2,'circle-radius':['step',['get','point_count'],18,100,23,500,28]}});
    map.addLayer({id:'stop-cluster-count',type:'symbol',source:'bus-stops',filter:['has','point_count'],layout:{visibility:stopVisibility,'text-field':['concat',['get','point_count_abbreviated'],'곳'],'text-font':['Noto Sans Regular'],'text-size':12},paint:{'text-color':'#26241f'}});
    map.on('click','stop-clusters',async e=>{const feature=e.features?.[0];if(!feature)return;try{const zoom=await map.getSource('bus-stops').getClusterExpansionZoom(feature.properties.cluster_id);map.easeTo({center:feature.geometry.coordinates,zoom:Math.max(zoom,map.getZoom()+1)});}catch{tell('정류장 묶음을 확대하지 못했습니다. 지도 + 버튼을 이용하세요.');}});
    for(const layer of ['stop-clusters','stop-cluster-count']){map.on('mouseenter',layer,()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave',layer,()=>map.getCanvas().style.cursor='');}
    // 점 대신 테마에 맞춘 네모 버스 아이콘을 씽니다.
    const busCanvas=document.createElement('canvas');busCanvas.width=busCanvas.height=40;const busCtx=busCanvas.getContext('2d');
    busCtx.fillStyle='#fdfbf5';busCtx.fillRect(0,0,40,40);busCtx.strokeStyle='#26241f';busCtx.lineWidth=4;busCtx.strokeRect(2,2,36,36);
    busCtx.fillStyle='#26241f';busCtx.fillRect(9,11,22,15);busCtx.fillStyle='#fdfbf5';busCtx.fillRect(12,14,7,6);busCtx.fillRect(21,14,7,6);
    busCtx.fillStyle='#26241f';busCtx.fillRect(11,27,5,4);busCtx.fillRect(24,27,5,4);
    map.addImage('bus-square',busCtx.getImageData(0,0,40,40),{pixelRatio:2});
    map.addLayer({id:'bus-stops',type:'symbol',source:'bus-stops',minzoom:14,filter:['!', ['has','point_count']],layout:{visibility:$('stop-picker').open?'visible':'none','icon-image':'bus-square','icon-size':['interpolate',['linear'],['zoom'],10,.55,14,.8,17,1.05],'icon-allow-overlap':false,'icon-ignore-placement':false,'icon-padding':5}});
    for(const layer of labelLayers.map(([,layer])=>layer)){map.on('click',layer,e=>{const feature=e.features?.[0];if(feature?.geometry.type==='Point')map.flyTo({center:feature.geometry.coordinates,zoom:layer==='legal-dong-names'?15:16.5});});map.on('mouseenter',layer,()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave',layer,()=>map.getCanvas().style.cursor='');}
    map.on('click','bus-stops',e=>{const s=stops[Number(e.features?.[0]?.properties.index)];if(s)showStop(s);});
    map.on('mouseenter','bus-stops',()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave','bus-stops',()=>map.getCanvas().style.cursor='');
  });
}catch{$('map-error').hidden=false;$('map-error').textContent='지도 대신 정류장 이름·번호로 선택할 수 있습니다.';}
function features(){return {type:'FeatureCollection',features:stops.flatMap((s,index)=>validCoordinates(s)?[{type:'Feature',geometry:{type:'Point',coordinates:[s.lon,s.lat]},properties:{index}}]:[])};}
function currentRoles(){return tab==='service'?[['serviceFrom','출발지'],['serviceTo','도착지']]:[['origin','출발지 추가'],['transfer','환승지 지정'],['destination','도착지 추가']];}
function focusStop(s){if(map&&validCoordinates(s))map.flyTo({center:[s.lon,s.lat],zoom:inRegion(region,s)?15:13.5,padding:window.matchMedia('(max-width:940px)').matches?{top:35,left:25,right:25,bottom:300}:{top:70,left:70,right:70,bottom:70}});}
function showStop(s){
  if(tab==='saved'){tell('정류장을 지정하려면 환승지 지정 탭을 선택하세요.');return;}
  if(!map)return addPoint(activeRole,s);
  popup?.remove();const el=document.createElement('div');el.className='stop-popup';el.innerHTML=`<strong>${stopLabel(s)}</strong>${meta(s)}<div class="popup-actions"></div>`;
  for(const [role,name]of currentRoles()){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{addPoint(role,s);popup.remove();};el.querySelector('.popup-actions').append(b);}
  popup=new ML.Popup({maxWidth:'340px'}).setLngLat([s.lon,s.lat]).setDOMContent(el).addTo(map);
}
function displayPoints(){if(tab==='service')return [['from',service.from],['to',service.to]];const p=tab==='saved'&&viewedPlan?viewedPlan:plan;return [...p.origins.map(e=>['from',e.stop]),['via',p.transfer],...p.destinations.map(e=>['to',e.stop])];}
function showPoints(fit=false){
  markers.splice(0).forEach(m=>m.remove());if(!map)return;
  const selected=[];
  for(const [role,s]of displayPoints()){if(!validCoordinates(s))continue;selected.push(s);const el=document.createElement('div');el.className='point-marker '+role;el.innerHTML=`<span>${{from:'출발',via:'환승',to:'도착'}[role]}</span><b>${esc(s.name)} · ${esc(s.number)}</b>`;markers.push(new ML.Marker({element:el,anchor:'left',offset:[-14,0]}).setLngLat([s.lon,s.lat]).addTo(map));}
  if(fit&&selected.length){const bounds=new ML.LngLatBounds();selected.forEach(s=>bounds.extend([s.lon,s.lat]));const mobile=window.matchMedia('(max-width:940px)').matches;map.fitBounds(bounds,{maxZoom:15.5,duration:400,padding:mobile?{top:60,left:30,right:30,bottom:window.innerHeight*.52}:{top:70,left:70,right:70,bottom:70}});}
}
function addPoint(role,value){
  const s=cleanPoint(value);edit();
  if(role==='origin'||role==='destination'){
    const group=role==='origin'?plan.origins:plan.destinations;
    if(group.some(e=>pointKey(e.stop)===pointKey(s))){tell('이미 추가한 정류장입니다.');return;}
    if(plan.transfer&&pointKey(plan.transfer)===pointKey(s)){tell('환승지와 다른 정류장을 골라 주세요.');return;}
    group.push({stop:s,routes:[]});focused=`${role}:${group.length-1}`;
  }else if(role==='transfer'){
    if([...plan.origins,...plan.destinations].some(e=>pointKey(e.stop)===pointKey(s))){tell('출발지·도착지와 다른 환승지를 골라 주세요.');return;}
    if(plan.transfer&&pointKey(plan.transfer)!==pointKey(s))for(const e of [...plan.origins,...plan.destinations])e.routes=[];
    plan.transfer=s;
  }else {service[role==='serviceFrom'?'from':'to']=s;message($('service-results'),'선택한 정류장으로 조회 버튼을 눌러 주세요.');}
  popup?.remove();$('stop-picker').open=false;renderPlan();renderServicePoints();showPoints();tell(`${s.name} · ${s.number} 선택`);
}
function pick(role){activeRole=role;$('stop-picker').open=true;renderPicker();$('stop-search').focus();}
function renderPicker(){
  $('pick-roles').replaceChildren();for(const [role,name]of currentRoles()){const b=document.createElement('button');b.textContent=name;b.className=activeRole===role?'active':'';b.setAttribute('aria-pressed',String(activeRole===role));b.onclick=()=>pick(role);$('pick-roles').append(b);}
  const name=currentRoles().find(([role])=>role===activeRole)?.[1]||'출발지';$('selection-help').textContent=name;$('stop-search').placeholder=`${name} · 이름 또는 번호`;renderSearch();
}
function renderSearch(){
  const q=$('stop-search').value.trim().toLowerCase(),box=$('stop-results');box.replaceChildren();
  if(!q){message(box,stops.length?`${stops.length.toLocaleString()}개 정류장 · 숫자 묶음을 눌러 확대하거나 검색하세요.`:'저장된 정류장이 없습니다. 불러오기 또는 번호 직접 추가를 이용하세요.');return;}
  const found=stops.filter(s=>`${s.name} ${s.number}`.toLowerCase().includes(q));
  for(const s of found.slice(0,30)){const b=document.createElement('button');b.className='search-item';b.innerHTML=`<span>${stopLabel(s)}</span>${meta(s)}`;b.onclick=()=>{addPoint(activeRole,s);focusStop(s);};box.append(b);}
  if(!found.length)message(box,'검색 결과가 없습니다. 번호로 직접 추가할 수 있습니다.');
  if(found.length>30)messageFooter(box,'처음 30개입니다. 검색어를 더 입력하세요.');
}
function messageFooter(el,text){const p=document.createElement('p');p.className='small-note';p.textContent=text;el.append(p);}
$('stop-search').oninput=renderSearch;
$('manual-stop-form').onsubmit=e=>{e.preventDefault();const number=$('manual-number').value.trim();if(!/^\d+$/.test(number))return;const s=stops.find(p=>p.number===number)||{number,name:$('manual-name').value.trim()||`정류장 ${number}`,lat:null,lon:null};addPoint(activeRole,s);$('manual-stop-form').reset();};
function stopCard(s){const card=document.createElement('div');card.className='stop-card';card.innerHTML=`<button type="button" class="stop-location">${stopLabel(s)}${meta(s)}</button>`;card.querySelector('button').onclick=()=>focusStop(s);return card;}
function selectConnection(kind,index){
  focused=`${kind}:${index}`;renderPlan();
  const entry=(kind==='origin'?plan.origins:plan.destinations)[index];
  if(entry)showEdgeLines(plan,kind,entry,true);
  $('connection-detail').scrollIntoView({block:'nearest'});
}
function renderPlan(){
  const connections=[...plan.origins.map((entry,index)=>({kind:'origin',entry,index})),...plan.destinations.map((entry,index)=>({kind:'destination',entry,index}))];
  if(!connections.some(({kind,index})=>focused===`${kind}:${index}`))focused=connections.length?`${connections[0].kind}:${connections[0].index}`:'';
  $('plan-name').value=plan.name;
  $('plan-network').replaceChildren(networkView(plan,{selected:focused,onSelect:(kind,index)=>{
    if(kind==='transfer'){pick('transfer');return;}
    if(kind.startsWith('add-')){pick(kind.slice(4));return;}
    selectConnection(kind,index);
  }}));
  $('connection-detail').replaceChildren();
  if(focused){const [kind,raw]=focused.split(':'),group=kind==='origin'?plan.origins:plan.destinations,entry=group[Number(raw)];if(entry)renderConnection(kind,entry,group);else focused='';}
}
function renderConnection(kind,entry,group){
  const box=$('connection-detail'),card=stopCard(entry.stop);card.classList.add('edge-card');
  const h=document.createElement('h3');h.className='edge-title';h.textContent=kind==='origin'?`1구간 · ${entry.stop.number} → ${plan.transfer?.number||'환승지 미지정'}`:`2구간 · ${plan.transfer?.number||'환승지 미지정'} → ${entry.stop.number}`;card.prepend(h);
  const remove=document.createElement('button');remove.className='quiet remove-stop';remove.textContent='×';remove.setAttribute('aria-label',`${entry.stop.name} ${entry.stop.number} 삭제`);remove.onclick=()=>{edit();group.splice(group.indexOf(entry),1);renderPlan();showPoints();};card.append(remove);
  const routeBox=document.createElement('div');routeBox.className='route-choices';
  for(const route of entry.routes){const label=document.createElement('label');label.className='route-check';label.innerHTML=`<input type="checkbox" ${route.selected?'checked':''}><span><b>${esc(route.number)}번</b>${route.destination?'<small>'+esc(route.destination)+'</small>':''}<small>${route.verified?'경유 확인':'경유 확인 전'} · ${esc(geometryState(route).label)}</small>${geometryState(route).detail?'<small class="geometry-reason">'+esc(geometryState(route).detail)+'</small>':''}</span>`;label.querySelector('input').onchange=e=>{route.selected=e.target.checked;renderPlan();showEdgeLines(plan,kind,entry);};routeBox.append(label);}
  if(!entry.routes.length){const empty=document.createElement('p');empty.className='small-note';empty.textContent=plan.transfer?'아직 조회한 후보 노선이 없습니다. 아래 버튼으로 조회한 뒤 이용할 노선을 선택하세요.':'환승지를 지정하면 이 구간의 후보 노선을 조회할 수 있습니다.';routeBox.append(empty);}
  card.append(routeBox);const tools=document.createElement('div');tools.className='edge-tools';const query=document.createElement('button');query.textContent=pending.has(entry)?'조회 중…':'후보 노선 조회';query.disabled=!plan.transfer||pending.has(entry);query.onclick=()=>queryEdge(kind,entry);if(!plan.transfer){const choose=document.createElement('button');choose.type='button';choose.textContent='환승지 지정';choose.onclick=()=>pick('transfer');tools.append(choose);}query.type='button';tools.append(query);card.append(tools);
  const note=document.createElement('p');note.className=entry.error?'error':'small-note';note.textContent=entry.error||entry.note||'이 버튼을 누를 때만 후보 노선과 형상을 조회합니다. 저장된 형상은 재사용합니다.';card.append(note);box.append(card);
}

function clearLines(){++geometryVersion;routeFeatures={type:'FeatureCollection',features:[]};map?.getSource('route-sections')?.setData(routeFeatures);$('map-line-status').hidden=true;}
async function showEdgeLines(p,kind,entry,fit=false){
  clearLines();const token=geometryVersion,from=kind==='origin'?entry.stop:p.transfer,to=kind==='origin'?p.transfer:entry.stop;if(!from||!to)return;
  const features=[];let missing=0;const colors=['#246644','#426fa3','#b07832','#7b589a'];
  for(const r of entry.routes.filter(r=>r.selected)){
    let segment=r.segment;if(!segment&&r.shapeKey){const raw=await shapes.get(r.shapeKey);if(raw)segment=clipShape(raw,from,to,r).segment;}
    if(token!==geometryVersion)return;if(!segment){missing++;continue;}
    features.push({type:'Feature',geometry:segment,properties:{number:r.number,color:colors[features.length%colors.length],offset:features.length*1.5}});
  }
  routeFeatures={type:'FeatureCollection',features};map?.getSource('route-sections')?.setData(routeFeatures);
  if(fit){if(features.length&&map){const bounds=new ML.LngLatBounds();for(const feature of features)for(const p of feature.geometry.coordinates)bounds.extend(p);map.fitBounds(bounds,{padding:{top:90,left:70,right:70,bottom:70},maxZoom:15.5});}else focusStop(entry.stop);}
  $('map-line-status').hidden=false;$('map-line-status').textContent=features.length?`선택 구간 ${features.length}개 노선 · 저장된 선형${missing?' · 미확보 '+missing+'개':''}`:entry.routes.filter(r=>r.selected).map(r=>`${r.number}번: ${geometryState(r).label}`).join(' / ')||'표시할 노선을 선택하세요.';
}
for(const [id,layer]of labelLayers)$(id).onchange=e=>{if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility',e.target.checked?'visible':'none');};

async function queryEdge(kind,entry){
  if(pending.has(entry)||!plan.transfer||!requireKeys(['busstop','routes']))return;
  const token=version;pending.add(entry);entry.error='';renderPlan();
  try{const from=kind==='origin'?entry.stop:plan.transfer,to=kind==='origin'?plan.transfer:entry.stop;
    const result=await queryDirectLeg(client,from,to,{entries,ids,check:()=>{if(token!==version)throw new DOMException('변경','AbortError');}});if(token!==version)return;
    if(!result.partial)entry.routes=entry.routes.filter(old=>result.routes.some(r=>r.routeId===old.routeId));
    for(const r of result.routes){const old=entry.routes.find(x=>x.routeId===r.routeId||(!x.routeId&&x.number===r.number));const checked=old?old.selected:false;const route=cleanRoute({...old,...r,geometryStatus:old?.geometryStatus||'not-requested',verified:true,selected:checked});if(old)Object.assign(old,route);else entry.routes.push(route);}
    if(result.routes[0]){from.standardId=result.routes[0].fromStandardId;to.standardId=result.routes[0].toStandardId;}
    let geometryFailures=0;
    for(const r of entry.routes.filter(r=>result.routes.some(x=>x.routeId===r.routeId))){
      if(token!==version)return;
      if(r.segment)continue;
      if(!(keys.routes||keys.default)||!validCoordinates(from)||!validCoordinates(to)){r.geometryStatus='not-requested';continue;}
      try{const shape=await getShapeOnQuery(client,shapes,r.routeId);if(token!==version)return;const section=clipShape(shape,from,to,r);r.shapeKey=r.routeId;r.segment=section.segment;r.geometryStatus=section.status;r.geometryMessage=section.message||'';if(!r.segment)geometryFailures++;}
      catch(error){if(token!==version||error.name==='AbortError')return;r.geometryStatus='request-error';r.geometryMessage=error.message;geometryFailures++;}
    }
    entry.note=`두 정류장의 공통 경유 노선 ${result.examined}개에서 운행 순서를 확인했습니다.${result.partial?' 현재 저장된 경유 정보 범위의 결과입니다.':''}${!result.routes.length?' 이 구간에 맞는 노선이 없습니다.':''}${geometryFailures?' 선형 미확보 '+geometryFailures+'개.':''}`;
    showEdgeLines(plan,kind,entry);
    try{storage.setItem('busmap.route-stops.v2',JSON.stringify(entries));}catch{}
  }catch(e){if(token===version&&e.name!=='AbortError'){entry.error=e.message;}}finally{pending.delete(entry);if(token===version)renderPlan();}
}
$('plan-name').oninput=e=>plan.name=e.target.value;
$('new-plan').onclick=()=>{edit();plan=emptyPlan();clearEntry();renderPlan();renderPicker();showPoints();};
$('save-form').onsubmit=e=>{e.preventDefault();try{const copy=validatePlan(plan);copy.id=copy.id||crypto.randomUUID();copy.name=copy.name||`${copy.transfer.name} 환승`;plan=writePlan(storage,copy);renderSaved();message($('plan-message'),'저장했습니다. 출발지와 도착지별 노선 선택을 함께 보관합니다.');tell('경로 묶음을 이 브라우저에 저장했습니다.');}catch(err){message($('plan-message'),err.message,true);}};

function renderSavedSummary(saved){
  const box=$('saved-summary');if(!box)return;
  const stops=new Set();let origins=0,destinations=0;
  for(const p of saved){origins+=p.origins.length;destinations+=p.destinations.length;for(const s of [p.transfer,...p.origins.map(e=>e.stop),...p.destinations.map(e=>e.stop)])if(s)stops.add(pointKey(s));}
  box.innerHTML=`<span class="stat-head">${saved.length?'저장된 묶음':'기록 없음'}</span>`+[['묶음',saved.length],['출발지',origins],['도착지',destinations],['정류장',stops.size]].map(([label,n])=>`<span><b>${n}</b>${label}</span>`).join('');
}
function renderSaved(){
  const saved=readPlans(storage);$('saved-count').textContent=saved.length;$('saved-list').replaceChildren();renderSavedSummary(saved);if(!saved.length)message($('saved-list'),'아직 저장한 묶음이 없습니다. 환승지 지정 탭에서 만들어 보세요.');
  for(const p of saved){const card=document.createElement('article');card.className='saved-card';card.innerHTML=`<h3>${esc(p.name)}</h3><p>출발 ${p.origins.length}곳 → <b>${esc(p.transfer.name)}</b> → 도착 ${p.destinations.length}곳</p><div class="saved-actions"><button aria-expanded="false">경로 펼치기</button><button class="primary">도착정보 조회</button><button>편집</button><button>삭제</button></div>`;
    const diagram=document.createElement('div');diagram.hidden=true;diagram.className='saved-diagram';card.append(diagram);
    const [toggle,query,editButton,remove]=card.querySelectorAll('.saved-actions button');
    let selected='';const draw=()=>{diagram.replaceChildren(networkView(p,{selected,editable:false,onSelect:(kind,index)=>{if(kind==='transfer'){focusStop(p.transfer);return;}if(kind.startsWith('add-'))return;selected=`${kind}:${index}`;viewedPlan=p;showPoints();draw();const e=(kind==='origin'?p.origins:p.destinations)[index];messageFooter(diagram,`${e.stop.name} · ${e.stop.number} / ${e.routes.filter(r=>r.selected).map(r=>r.number+'번').join(' · ')}`);showEdgeLines(p,kind,e,true);}}));};
    toggle.onclick=()=>{diagram.hidden=!diagram.hidden;toggle.setAttribute('aria-expanded',String(!diagram.hidden));toggle.textContent=diagram.hidden?'경로 펼치기':'경로 접기';if(!diagram.hidden){viewedPlan=p;draw();showPoints(true);}};
    query.onclick=()=>querySaved(p,query);editButton.onclick=()=>{edit();plan=structuredClone(p);renderPlan();selectTab('plan');showPoints(true);};remove.onclick=()=>{try{storage.setItem(PLANS_KEY,JSON.stringify(readPlans(storage).filter(x=>x.id!==p.id)));deleted=p;$('undo-delete').hidden=false;renderSaved();}catch(e){tell(e.message);}};$('saved-list').append(card);
  }
  $('legacy-section').hidden=!legacy.length;$('legacy-list').innerHTML=legacy.map(j=>`<p class="small-note"><b>${esc(j.name)}</b><br>${[j.points.from,j.points.via,j.points.to].filter(Boolean).map(s=>`${esc(s.name)} · ${esc(s.number)}`).join(' → ')}<br>${j.routes.map(r=>esc(r.number)+'번').join(' → ')} · 원래 저장 데이터는 유지됩니다.</p>`).join('');
}
$('undo-button').onclick=()=>{if(deleted)try{writePlan(storage,deleted);deleted=null;$('undo-delete').hidden=true;renderSaved();}catch(e){tell(e.message);}};
async function querySaved(p,button){
  if(pending.has('saved')||!requireKeys(['realtime']))return;
  pending.add('saved');button.disabled=true;viewedPlan=p;showPoints(true);const box=$('saved-detail');box.replaceChildren();const token=version;
  message(box,`${p.name}: 출발지 ${p.origins.length}곳과 환승지만 조회합니다. 도착지는 조회하지 않습니다.`);
  for(const target of arrivalTargets(p)){
    if(token!==version)break;
    const section=document.createElement('section');section.className='arrival-block';section.innerHTML=`<h3>${esc(target.kind)} · ${stopLabel(target.stop)}</h3>`;box.append(section);
    try{const id=await standard(target.stop);if(token!==version)break;const {rows}=await client.get('realtime','bus_location_low_busstop_infomation_common',{stopStdid:id});if(token!==version)break;
      const matching=rows.filter(row=>target.routes.some(r=>r.routeId?f(row,'brtStdid')===r.routeId:f(row,'brtId')===r.number));
      if(!matching.length)messageFooter(section,'선택한 노선의 도착정보가 없습니다.');
      for(const row of matching){const line=document.createElement('div');line.className='arrival-card';line.innerHTML=`<span><b>${esc(f(row,'brtId'))}번</b><small>${esc(f(row,'brtVianame'))}</small></span><b>${esc(arrivalTime(f(row,'RTime')))}</b>`;section.append(line);}
    }catch(e){if(e.name!=='AbortError')messageFooter(section,'조회 실패: '+e.message);}
  }
  if(token===version)messageFooter(box,new Date().toLocaleTimeString('ko-KR')+' 수동 조회 · 자동 갱신 없음');pending.delete('saved');button.disabled=false;
}
function renderServicePoints(){const box=$('service-points');box.replaceChildren();for(const [role,label]of [['from','출발지'],['to','도착지']]){const s=service[role];const card=document.createElement('div');card.className='service-point';card.innerHTML=`<label>${label}</label>`;if(s)card.append(stopCard(s));const b=document.createElement('button');b.className='add-stop wide';b.textContent=s?'다른 정류장 선택':`+ ${label} 선택`;b.onclick=()=>pick(role==='from'?'serviceFrom':'serviceTo');card.append(b);box.append(card);}}
$('service-query').onclick=async()=>{
  const button=$('service-query');if(button.disabled)return;if(!service.from||!service.to){message($('service-results'),'출발지와 도착지를 선택하세요.',true);return;}if(pointKey(service.from)===pointKey(service.to)){message($('service-results'),'서로 다른 정류장을 선택하세요.',true);return;}if(!requireKeys(['transfer']))return;
  button.disabled=true;const token=version;message($('service-results'),'한 번 조회하는 중…');
  try{const from=await standard(service.from),to=await standard(service.to);if(token!==version)return;const {rows}=await client.get('transfer','fromto_bus_search_transfer_detail_common',{sStandardId:from,eStandardId:to,maxCnt:10});if(token!==version)return;
    $('service-results').replaceChildren();if(!rows.length)message($('service-results'),'제공된 경로가 없습니다.');
    rows.forEach((r,i)=>{const card=document.createElement('article');card.className='journey-card';card.innerHTML=`<h3>경로 ${i+1} · ${esc(f(r,'startNo'))}번 ${f(r,'finNo')?'→ '+esc(f(r,'finNo'))+'번':''}</h3><p>${esc(service.from.name)} → ${esc(f(r,'chgName')||'경유지 미제공')} → ${esc(service.to.name)}</p><p class="small-note">예상시간 ${esc(f(r,'tripTime')||'미제공')} · 거리 ${esc(f(r,'tripDistance')||'미제공')} (API 원문값 · 단위 미명시)</p>`;$('service-results').append(card);});
  }catch(e){if(token===version&&e.name!=='AbortError')message($('service-results'),e.message,true);}finally{button.disabled=false;}
};
function clearEntry(){for(const id of ['stop-search','manual-number','manual-name'])$(id).value='';$('stop-picker').open=false;}
function selectTab(name){clearLines();tab=name;for(const b of document.querySelectorAll('[data-tab]')){if(b.dataset.tab===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}for(const t of ['plan','saved','service','about'])$(t+'-panel').hidden=t!==name;$('picker').hidden=name==='saved'||name==='about';activeRole=name==='service'?'serviceFrom':'origin';clearEntry();renderPicker();if(name==='saved')renderSaved();showPoints();}
let panelOpen=true;
function setPanel(open){panelOpen=open;document.querySelector('.sidebar').classList.toggle('collapsed',!open);$('panel-body').hidden=!open;}
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>{
  const name=b.dataset.tab;
  if(name===tab&&panelOpen){setPanel(false);return;}
  setPanel(true);selectTab(name);
};
const KEY_FIELDS=[['default','api-key'],['stops','stops-key'],['routes','routes-key'],['realtime','realtime-key'],['transfer','transfer-key'],['busstop','busstop-key']];
const KEY_STORE='busmap.apikeys.v1',KEY_NOTICE='busmap.apikeys.notice.v1',CONSENT_SECONDS=5;
const cleanKeys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==='string'&&v.trim())):{};
function readStoredKeys(){try{return cleanKeys(JSON.parse(storage.getItem(KEY_STORE)||'null')?.keys);}catch{return {};}}
let storedKeys=readStoredKeys(),persistKeys=Object.keys(storedKeys).length>0;
let consentOpen=false,consentReady=false,consentLeft=0,consentTimer=null;
keys={...storedKeys};
function maskKey(value){const key=String(value||'');return key.length<=8?key.slice(0,2)+'••••'+key.slice(-2):key.slice(0,4)+'••••'+key.slice(-4);}
function hasKeys(){return Object.keys(keys).length>0;}
function writeStoredKeys(){try{storage.setItem(KEY_STORE,JSON.stringify({keys,savedAt:new Date().toISOString()}));storedKeys=readStoredKeys();return true;}catch(e){$('settings-error').textContent='브라우저 저장에 실패했습니다. '+e.message;return false;}}
function eraseStoredKeys(){try{storage.removeItem(KEY_STORE);}catch{}storedKeys={};}
function paintKeyOptions(){
  $('key-persist').checked=persistKeys||consentOpen;
  $('key-consent').hidden=!consentOpen;
  $('key-consent-text').textContent=consentReady?'동의하면 현재 키를 이 브라우저에 저장합니다. 공용 PC라면 권하지 않습니다.':`${Math.max(consentLeft,0)}초 뒤에 동의 버튼이 열립니다.`;
  $('key-consent-ok').disabled=!consentReady;
  const state=$('key-persist-state');state.classList.toggle('on',persistKeys);
  state.textContent=persistKeys?'켜짐 · 이 브라우저를 쓰는 사람과 페이지 스크립트가 키를 읽을 수 있습니다.':'꺼짐 · 이 탭의 메모리에만 보관합니다.';
  $('api-key-warn').hidden=!(persistKeys&&hasKeys());
}
function renderDataset(){
  const el=$('dataset-label');if(!el)return;
  const keyed=hasKeys(),detail=datasetLabel||(stops.length?`저장된 정류장 ${stops.length.toLocaleString()}개`:'');
  el.classList.toggle('needs-key',!keyed);
  el.textContent=keyed?(detail||'정류장 불러오기를 눌러 주세요'):'API 키를 입력해주세요';
  el.title=keyed?(detail||'정류장 데이터'):'API 키를 입력하려면 누르세요';
}
function renderKeyState(){
  for(const [source,id] of KEY_FIELDS){const el=$(id+'-state');if(!el)continue;const key=keys[source]||'';el.classList.toggle('set',Boolean(key));el.classList.toggle('stored',Boolean(key)&&persistKeys);el.textContent=key?`적용됨 · ${maskKey(key)} · ${persistKeys?'브라우저에 저장됨':'이 탭의 메모리에만 보관'}`:'미설정';}
  paintKeyOptions();renderDataset();
}
$('dataset-label').onclick=()=>{renderKeyState();$('settings').showModal();};
function stopConsent(){clearInterval(consentTimer);consentTimer=null;}
function cancelConsent(){stopConsent();consentOpen=consentReady=false;consentLeft=0;paintKeyOptions();}
function startConsent(){consentOpen=true;consentReady=false;consentLeft=CONSENT_SECONDS;stopConsent();paintKeyOptions();consentTimer=setInterval(()=>{consentLeft-=1;if(consentLeft<=0){consentReady=true;stopConsent();}paintKeyOptions();},1000);}
$('key-persist').onchange=e=>{
  if(!e.target.checked){cancelConsent();if(persistKeys){persistKeys=false;eraseStoredKeys();renderKeyState();tell('브라우저 저장을 끄고 저장된 키를 지웠습니다. 이 탭에서는 계속 사용합니다.');}return;}
  startConsent();
};
$('key-consent-ok').onclick=()=>{if(!consentReady)return;stopConsent();consentOpen=consentReady=false;persistKeys=true;if(hasKeys()&&!writeStoredKeys())persistKeys=false;renderKeyState();tell(persistKeys?'브라우저 저장에 동의했습니다. 현재 키를 저장했습니다.':'키를 먼저 적용한 뒤 다시 시도하세요.');};
$('settings-open').onclick=()=>{renderKeyState();$('settings-error').textContent='';$('settings').showModal();};$('settings-close').onclick=()=>{cancelConsent();$('settings').close();};
$('settings-form').onsubmit=e=>{e.preventDefault();const next={...keys};for(const [source,id] of KEY_FIELDS){const value=$(id).value.trim();if(value)next[source]=value;}if(!Object.values(next).some(Boolean)){$('settings-error').textContent='키를 입력하세요.';return;}++version;client.reset();keys=next;$('settings-form').reset();$('settings-error').textContent='';if(persistKeys)writeStoredKeys();renderKeyState();$('settings').close();tell(persistKeys?'키를 적용하고 이 브라우저에 저장했습니다.':'키를 적용했습니다. 이 탭의 메모리에만 있습니다.');};
$('clear-key').onclick=()=>{++version;client.reset();keys={};eraseStoredKeys();$('settings-form').reset();renderKeyState();$('settings').close();tell('키를 지웠습니다. 저장한 묶음은 유지됩니다.');};
$('key-warning-ack').onclick=()=>{try{sessionStorage.setItem(KEY_NOTICE,'1');}catch{}$('key-warning').close();};
function maybeWarnStoredKeys(){if(!persistKeys||!hasKeys())return;let seen=false;try{seen=sessionStorage.getItem(KEY_NOTICE)==='1';}catch{}if(seen||$('key-warning').open)return;$('key-warning').showModal();}
$('load-data').onclick=async()=>{
  if(loading||!requireKeys(['stops']))return;loading=true;$('load-data').disabled=true;
  try{const dataset=latestStopDataset(await getSpec()),rows=[];for(let page=1;;page++){const result=await client.get('stops',dataset.path,{page,perPage:1000,returnType:'JSON'});rows.push(...result.rows);if(rows.length>=result.total)break;if(!result.rows.length||page>=50)throw new Error('정류장 일부를 받지 못했습니다.');}
    stops=rows.map(normalizeStop).filter(s=>s.name&&s.number&&validCoordinates(s));try{storage.setItem('busmap.stops.v1',JSON.stringify({date:dataset.date,stops}));}catch{tell('정류장 로컬 저장 공간이 부족합니다.');}
    datasetLabel=`${dataset.date} · ${stops.length.toLocaleString()}개`;renderDataset();map?.getSource('bus-stops')?.setData(features());renderPicker();tell('최신 정류장 목록을 불러왔습니다.');
  }catch(e){if(e.name!=='AbortError')tell(e.message);}finally{loading=false;$('load-data').disabled=false;}
};

renderPlan();renderServicePoints();renderSaved();renderPicker();renderKeyState();applyRegion(document,region);maybeWarnStoredKeys();

$('stop-picker').addEventListener('toggle',()=>{for(const layer of ['bus-stops','stop-clusters','stop-cluster-count'])if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility',$('stop-picker').open&&tab!=='saved'&&tab!=='about'?'visible':'none');});
