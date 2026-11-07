import * as ML from './vendor/maplibre-gl.mjs';
import {createClient,latestStopDataset,normalizeStop,arrivalEstimate,field as f} from './api.js';
import {queryDirectLeg,fetchStopSpec,resolvePlatformIdentity,cachedPlatformId} from './targeted.js';
import {readJourneys,sectionAnchors} from './journey.js';
import {networkView} from './network-view.js';
import {shapeStore} from './shape-cache.js';
import {getSectionOnQuery,readSectionCache,clipShape,geometryState,SECTION_VERSION} from './route-geometry.js';
import {PLANS_KEY,emptyPlan,cleanPoint,cleanRoute,pointKey,validatePlan,readPlans,writePlan,arrivalTargets,stopHint} from './plan-model.js';
import {DEFAULT_REGION_ID,regionById,inRegion,applyRegion} from './regions/index.js';
import {mapPadding,observeMapContainer} from './ui-layout.js';
import {initResponsiveNavigation} from './navigation.js';

const $=id=>document.getElementById(id);
initResponsiveNavigation();
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
function requireKeys(sources){if(sources.every(s=>keys[s]||keys.default))return true;openKeySettings('API 키를 입력한 뒤 조회 버튼을 다시 눌러 주세요.');return false;}
async function getSpec(){if(!specPromise)specPromise=fetchStopSpec().catch(e=>{specPromise=null;throw e;});return specPromise;}
async function standard(s){const id=cachedPlatformId(s,entries,region.platforms);if(id)s.standardId=id;return resolvePlatformIdentity(client,s,ids);}
function identityKeys(points){return points.some(s=>!/^\d{9}$/.test(s.standardId||'')&&!cachedPlatformId(s,entries,region.platforms))?['busstop']:[];}
function sectionOptions(r){return {anchors:sectionAnchors(entries[r.routeId]?.stops,stops,r)};}

ML.setWorkerUrl(new URL('./vendor/maplibre-gl-worker.mjs',import.meta.url).href);
// 지도 +/− 바로 아래에 붙는 레이어 선택 버튼(모달 아님, 지도 위 작은 팝오버).
class LayerToggleControl{
  constructor(panel){this.panel=panel;this.button=null;
    this.handleClick=e=>{if(this.panel.contains(e.target)||this.button?.contains(e.target))return;this.close();};
    this.handleKey=e=>{if(e.key==='Escape'&&!this.panel.hidden){e.preventDefault();this.close(true);}};}
  onAdd(){
    const div=document.createElement('div');div.className='maplibregl-ctrl maplibregl-ctrl-group layer-toggle';
    const b=document.createElement('button');b.type='button';b.className='layer-toggle-button';b.title='레이어 선택';b.setAttribute('aria-label','지도 레이어 선택');b.setAttribute('aria-expanded','false');b.setAttribute('aria-controls',this.panel.id);
    b.innerHTML='<svg class="layer-icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.4 15.1 10.9 10.7a2.4 2.4 0 0 1 2.2 0l8.5 4.4c.9.5.9 1.7 0 2.2l-8.5 4.4a2.4 2.4 0 0 1-2.2 0l-8.5-4.4c-.9-.5-.9-1.7 0-2.2Z"/><path d="M2.4 7.1 10.9 2.7a2.4 2.4 0 0 1 2.2 0l8.5 4.4c.9.5.9 1.7 0 2.2l-8.5 4.4a2.4 2.4 0 0 1-2.2 0L2.4 9.3c-.9-.5-.9-1.7 0-2.2Z"/></svg>';
    b.onclick=e=>{if(this.panel.hidden)this.open(e.detail===0);else this.close();};
    div.append(b);this.button=b;return div;
  }
  onRemove(){this.close();this.button?.parentNode?.remove();}
  open(focusFirst=false){this.panel.hidden=false;this.button?.setAttribute('aria-expanded','true');document.addEventListener('click',this.handleClick);document.addEventListener('keydown',this.handleKey);if(focusFirst)this.panel.querySelector('input')?.focus();}
  close(restoreFocus=false){this.panel.hidden=true;this.button?.setAttribute('aria-expanded','false');document.removeEventListener('click',this.handleClick);document.removeEventListener('keydown',this.handleKey);if(restoreFocus)this.button?.focus();}
}
let map,refitOnReveal=false;
try{
  map=new ML.Map({container:'map',style:region.mapStyle,center:[...region.center],zoom:region.zoom,attributionControl:false,pitchWithRotate:false,dragRotate:false,locale:{'NavigationControl.ZoomIn':'지도 확대','NavigationControl.ZoomOut':'지도 축소','GeolocateControl.FindMyLocation':'현재 위치로 이동','GeolocateControl.LocationNotAvailable':'현재 위치를 확인할 수 없습니다'}});
  map.addControl(new ML.NavigationControl({showCompass:false}),'top-right');map.addControl(new LayerToggleControl($('layer-menu')),'top-right');const locate=new ML.GeolocateControl({positionOptions:{enableHighAccuracy:false,timeout:10000},trackUserLocation:false,showAccuracyCircle:true,fitBoundsOptions:{maxZoom:15.5}});map.addControl(locate,'bottom-right');locate.on('error',()=>tell('현재 위치를 확인하지 못했습니다. 브라우저 위치 권한과 기기 위치 설정을 확인하세요.'));// Mount the standard provider credits outside the camera viewport so they have their own row.
  const attribution=new ML.AttributionControl({compact:false});
  $('map-attribution').append(attribution.onAdd(map));
  map.on('remove',()=>attribution.onRemove());
  map.on('error',()=>{$('map-error').textContent='배경지도 연결을 확인하세요. 정류장 선택과 로컬 저장은 계속 사용할 수 있습니다.';$('map-error').hidden=false;});
  map.on('load',()=>{
    for(const [id,layer] of labelLayers)applyLabelVisibility(id,layer);
    map.addSource('route-sections',{type:'geojson',data:routeFeatures});
    map.addLayer({id:'route-section-halo',type:'line',source:'route-sections',paint:{'line-color':'#fff','line-width':8,'line-opacity':.85}});
    map.addLayer({id:'route-section-lines',type:'line',source:'route-sections',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':['get','color'],'line-width':4,'line-offset':['get','offset']}});
    map.addLayer({id:'route-section-numbers',type:'symbol',source:'route-sections',layout:{'symbol-placement':'line','text-field':['get','number'],'text-font':['Noto Sans Regular'],'text-size':12},paint:{'text-color':'#214f36','text-halo-color':'#fff','text-halo-width':2}});
    map.addSource('bus-stops',{type:'geojson',data:features(),cluster:true,clusterRadius:75,clusterMaxZoom:14});
    const stopVisibility=$('stop-picker').open?'visible':'none';
    map.addLayer({id:'stop-clusters',type:'circle',source:'bus-stops',filter:['has','point_count'],layout:{visibility:stopVisibility},paint:{'circle-color':'#fdfbf5','circle-stroke-color':'#79736a','circle-stroke-width':1.2,'circle-radius':['step',['get','point_count'],18,100,23,500,28]}});
    map.addLayer({id:'stop-cluster-count',type:'symbol',source:'bus-stops',filter:['has','point_count'],layout:{visibility:stopVisibility,'text-field':['to-string',['get','point_count_abbreviated']],'text-font':['Noto Sans Regular'],'text-size':12},paint:{'text-color':'#26241f'}});
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
if(map){const stopObserving=observeMapContainer(map.getContainer(),resizeMap);map.on('remove',stopObserving);}
function cameraPadding(){return mapPadding(map?.getContainer().getBoundingClientRect());}
function mapHasSize(){const container=map?.getContainer();return container?.clientWidth>0&&container.clientHeight>0;}
function fitRouteFeatures(){
  if(!map||!routeFeatures.features.length)return;
  if(!mapHasSize()){refitOnReveal=true;return;}
  const bounds=new ML.LngLatBounds();
  for(const feature of routeFeatures.features)for(const point of feature.geometry.type==='MultiLineString'?feature.geometry.coordinates.flat():feature.geometry.coordinates)bounds.extend(point);
  map.fitBounds(bounds,{padding:cameraPadding(),retainPadding:false,maxZoom:15.5});
}
function resizeMap(){
  if(!mapHasSize())return;
  map.resize();
  // A camera fit made in a hidden map has no usable viewport. Replay it once
  // on reveal; ordinary visible resizes preserve the user's centre and zoom.
  if(refitOnReveal){refitOnReveal=false;if(routeFeatures.features.length)fitRouteFeatures();else showPoints(true);}
}
function features(){return {type:'FeatureCollection',features:stops.flatMap((s,index)=>validCoordinates(s)?[{type:'Feature',geometry:{type:'Point',coordinates:[s.lon,s.lat]},properties:{index}}]:[])};}
function currentRoles(){return tab==='service'?[['serviceFrom','출발지'],['serviceTo','도착지']]:plan.mode==='direct'?[['origin','출발지 추가'],['transfer','도착지 지정']]:[['origin','출발지 추가'],['transfer','환승지 지정'],['destination','도착지 추가']];}
function focusStop(s){if(map&&validCoordinates(s))map.flyTo({center:[s.lon,s.lat],zoom:inRegion(region,s)?15:13.5,padding:cameraPadding(),retainPadding:false});}
function showStop(s){
  if(tab==='saved'){tell('정류장을 지정하려면 환승지 지정 탭을 선택하세요.');return;}
  if(!map)return addPoint(activeRole,s);
  popup?.remove();const el=document.createElement('div');el.className='stop-popup';el.innerHTML=`<strong>${stopLabel(s)}</strong>${meta(s)}<div class="popup-actions"></div>`;
  for(const [role,name]of currentRoles()){const b=document.createElement('button');b.textContent=name;b.onclick=()=>addPoint(role,s);el.querySelector('.popup-actions').append(b);}
  popup=new ML.Popup({maxWidth:'340px'}).setLngLat([s.lon,s.lat]).setDOMContent(el).addTo(map);
}
function displayPoints(){if(tab==='service')return [['from',service.from],['to',service.to]];const p=tab==='saved'?viewedPlan:plan;if(!p)return [];return [...p.origins.map(e=>['from',e.stop]),[p.mode==='direct'?'to':'via',p.transfer],...p.destinations.map(e=>['to',e.stop])];}
function showPoints(fit=false){
  markers.splice(0).forEach(m=>m.remove());if(!map)return;
  const selected=[];
  for(const [role,s]of displayPoints()){if(!validCoordinates(s))continue;selected.push(s);const el=document.createElement('div');el.className='point-marker '+role;el.innerHTML=`<span>${{from:'출발',via:'환승',to:'도착'}[role]}</span><b>${esc(s.name)} · ${esc(s.number)}</b>`;markers.push(new ML.Marker({element:el,anchor:'left',offset:[-14,0]}).setLngLat([s.lon,s.lat]).addTo(map));}
  if(fit&&selected.length){if(!mapHasSize()){refitOnReveal=true;return;}const bounds=new ML.LngLatBounds();selected.forEach(s=>bounds.extend([s.lon,s.lat]));map.fitBounds(bounds,{maxZoom:15.5,duration:400,padding:cameraPadding(),retainPadding:false});}
}
function focusInPanel(element){
  if(!element)return;
  element.focus({preventScroll:true});
  element.scrollIntoView({block:'nearest',inline:'nearest'});
}
function addPoint(role,value,fromPicker=false){
  const s=cleanPoint(value);
  if(role==='origin'||role==='destination'){
    const group=role==='origin'?plan.origins:plan.destinations;
    if(group.some(e=>pointKey(e.stop)===pointKey(s))){tell('이미 추가한 정류장입니다.');return false;}
    if(plan.transfer&&pointKey(plan.transfer)===pointKey(s)){tell(plan.mode==='direct'?'도착지와 다른 정류장을 골라 주세요.':'환승지와 다른 정류장을 골라 주세요.');return false;}
    edit();
    group.push({stop:s,routes:[]});focused=`${role}:${group.length-1}`;
  }else if(role==='transfer'){
    if([...plan.origins,...plan.destinations].some(e=>pointKey(e.stop)===pointKey(s))){tell(plan.mode==='direct'?'출발지와 다른 도착지를 골라 주세요.':'출발지·도착지와 다른 환승지를 골라 주세요.');return false;}
    edit();
    if(plan.transfer&&pointKey(plan.transfer)!==pointKey(s)){
      for(const entry of [...plan.origins,...plan.destinations]){
        entry.routes=[];delete entry.note;delete entry.error;
      }
    }
    plan.transfer=s;
  }else {edit();service[role==='serviceFrom'?'from':'to']=s;message($('service-results'),'선택한 정류장으로 조회 버튼을 눌러 주세요.');}
  popup?.remove();clearEntry();renderPlan();renderServicePoints();showPoints();tell(`${s.name} · ${s.number} 선택`);
  if(fromPicker){
    const target=tab==='plan'?$('plan-network').querySelector(`[data-network-action="${role==='transfer'?'transfer':focused}"]`):$('service-points').querySelectorAll('.service-point')[role==='serviceFrom'?0:1]?.querySelector('.stop-location');
    focusInPanel(target);
  }
  return true;
}
function pick(role){
  const picker=$('stop-picker');
  if(!picker.open){clearEntry();picker.open=true;}
  activeRole=role;renderPicker();focusInPanel($('stop-search'));
}
function renderPicker(){
  $('pick-roles').replaceChildren();for(const [role,name]of currentRoles()){const b=document.createElement('button');b.textContent=name;b.className=activeRole===role?'active':'';b.setAttribute('aria-pressed',String(activeRole===role));b.onclick=()=>pick(role);$('pick-roles').append(b);}
  const name=currentRoles().find(([role])=>role===activeRole)?.[1]||'출발지';$('selection-help').textContent=name;$('stop-search').placeholder=`${name} · 이름 또는 번호`;renderSearch();
}
function renderSearch(){
  const q=$('stop-search').value.trim().toLowerCase(),box=$('stop-results');box.replaceChildren();
  if(!q){message(box,stops.length?`${stops.length.toLocaleString()}개 정류장 · 숫자 묶음을 눌러 확대하거나 검색하세요.`:'저장된 정류장이 없습니다. 불러오기 또는 번호 직접 추가를 이용하세요.');return;}
  const found=stops.filter(s=>`${s.name} ${s.number}`.toLowerCase().includes(q)).sort((a,b)=>Number(b.number===q)-Number(a.number===q));
  for(const s of found.slice(0,30)){const b=document.createElement('button');b.className='search-item';b.innerHTML=`<span>${stopLabel(s)}</span>${meta(s)}`;b.onclick=()=>{if(addPoint(activeRole,s,true))focusStop(s);};box.append(b);}
  if(!found.length)message(box,'검색 결과가 없습니다. 번호로 직접 추가할 수 있습니다.');
  if(found.length>30)messageFooter(box,'처음 30개입니다. 검색어를 더 입력하세요.');
}
function messageFooter(el,text){const p=document.createElement('p');p.className='small-note';p.textContent=text;el.append(p);}
$('stop-search').oninput=renderSearch;
$('manual-stop-form').onsubmit=e=>{e.preventDefault();const number=$('manual-number').value.trim();if(!/^\d+$/.test(number))return;const s=stops.find(p=>p.number===number)||{number,name:$('manual-name').value.trim()||`정류장 ${number}`,lat:null,lon:null};addPoint(activeRole,s,true);};
function stopCard(s){const card=document.createElement('div');card.className='stop-card';card.innerHTML=`<button type="button" class="stop-location">${stopLabel(s)}${meta(s)}</button>`;card.querySelector('button').onclick=()=>focusStop(s);return card;}
function selectConnection(kind,index){
  focused=`${kind}:${index}`;renderPlan();
  const entry=(kind==='origin'?plan.origins:plan.destinations)[index];
  if(entry)showEdgeLines(plan,kind,entry,true);
  focusInPanel($('connection-detail').querySelector('.edge-title'));
}
function renderNetwork(box,p,options){
  const action=box.contains(document.activeElement)?document.activeElement.getAttribute('data-network-action'):null;
  box.replaceChildren(networkView(p,options));
  if(action)Array.from(box.querySelectorAll('[data-network-action]')).find(button=>button.getAttribute('data-network-action')===action)?.focus({preventScroll:true});
}
function renderPlanNetwork(){
  renderNetwork($('plan-network'),plan,{selected:focused,onSelect:(kind,index)=>{
    if(kind==='transfer'){pick('transfer');return;}
    if(kind.startsWith('add-')){pick(kind.slice(4));return;}
    selectConnection(kind,index);
  }});
}
function renderPlan(){
  const connections=[...plan.origins.map((entry,index)=>({kind:'origin',entry,index})),...plan.destinations.map((entry,index)=>({kind:'destination',entry,index}))];
  $('plan-hint').textContent=!connections.length&&!plan.transfer?'출발 정류장 찾기를 눌러 이름이나 번호로 검색하세요.':'구간을 눌러 후보 노선을 조회하고 이용할 버스를 선택하세요.';
  if(!connections.some(({kind,index})=>focused===`${kind}:${index}`))focused=connections.length?`${connections[0].kind}:${connections[0].index}`:'';
  $('plan-name').value=plan.name;renderPlanNetwork();
  $('connection-detail').replaceChildren();
  if(focused){const [kind,raw]=focused.split(':'),group=kind==='origin'?plan.origins:plan.destinations,entry=group[Number(raw)];if(entry)renderConnection(kind,entry,group);else focused='';}
}
function renderConnection(kind,entry,group){
  const box=$('connection-detail'),card=stopCard(entry.stop);card.classList.add('edge-card');
  const h=document.createElement('h3');h.className='edge-title';h.tabIndex=-1;h.dataset.focusKey='heading';h.textContent=kind==='origin'?`1구간 · ${entry.stop.number} → ${plan.transfer?.number||(plan.mode==='direct'?'도착지 미지정':'환승지 미지정')}`:`2구간 · ${plan.transfer?.number||(plan.mode==='direct'?'도착지 미지정':'환승지 미지정')} → ${entry.stop.number}`;card.prepend(h);
  card.querySelector('.stop-location').dataset.focusKey='location';
  const remove=document.createElement('button');remove.type='button';remove.className='quiet remove-stop';remove.dataset.focusKey='remove';remove.textContent='×';remove.setAttribute('aria-label',`${entry.stop.name} ${entry.stop.number} 삭제`);remove.onclick=()=>{edit();group.splice(group.indexOf(entry),1);renderPlan();showPoints();focusInPanel($('connection-detail').querySelector('.edge-title')||$('plan-network').querySelector(`[data-network-action="add-${kind}"]`));};card.append(remove);
  const routeBox=document.createElement('div');routeBox.className='route-choices';
  for(const route of entry.routes){const label=document.createElement('label');label.className='route-check';label.innerHTML=`<input type="checkbox" ${route.selected?'checked':''}><span><b>${esc(route.number)}번</b>${route.destination?'<small>'+esc(route.destination)+'</small>':''}<small>${route.verified?'경유 확인':'경유 확인 전'} · ${esc(geometryState(route).label)}</small>${geometryState(route).detail?'<small class="geometry-reason">'+esc(geometryState(route).detail)+'</small>':''}</span>`;const input=label.querySelector('input');input.dataset.focusKey=`route:${route.routeId||route.number}`;input.onchange=e=>{route.selected=e.target.checked;renderPlanNetwork();showEdgeLines(plan,kind,entry);};routeBox.append(label);}
  if(!entry.routes.length){
    const empty=document.createElement('p');empty.className='small-note';
    empty.textContent=!plan.transfer?(plan.mode==='direct'?'도착지를 지정하세요.':'환승지를 지정하면 이 구간의 후보 노선을 조회할 수 있습니다.'):entry.note?'조회 결과에서 이 구간에 맞는 후보 노선을 찾지 못했습니다.':'후보 노선을 조회한 뒤 이용할 버스를 선택하세요.';
    routeBox.append(empty);
  }
  card.setAttribute('aria-busy',String(pending.has(entry)));const tools=document.createElement('div');tools.className='edge-tools';const query=document.createElement('button');query.dataset.focusKey='query';query.textContent=pending.has(entry)?'조회 중…':'후보 노선 조회';query.disabled=!plan.transfer||pending.has(entry);query.onclick=()=>queryEdge(kind,entry,query);if(!plan.transfer){const choose=document.createElement('button');choose.type='button';choose.textContent=plan.mode==='direct'?'도착지 지정':'환승지 지정';choose.onclick=()=>pick('transfer');tools.append(choose);}query.type='button';tools.append(query);card.append(tools);
  const note=document.createElement('p');note.className=entry.error?'error':'small-note';note.textContent=entry.error||entry.note||'이 버튼을 누를 때만 후보 노선과 형상을 조회합니다. 저장된 형상은 재사용합니다.';card.append(note,routeBox);box.append(card);
}

function clearLines(){++geometryVersion;refitOnReveal=false;routeFeatures={type:'FeatureCollection',features:[]};map?.getSource('route-sections')?.setData(routeFeatures);$('map-line-status').hidden=true;}
function displaysEdge(p,kind,entry){
  if(tab==='saved')return viewedPlan===p;
  if(tab!=='plan'||plan!==p)return false;
  const [selectedKind,index]=focused.split(':');
  const group=kind==='origin'?p.origins:p.destinations;
  return selectedKind===kind&&group[Number(index)]===entry;
}
async function showEdgeLines(p,kind,entry,fit=false){
  if(!displaysEdge(p,kind,entry))return;
  clearLines();const token=geometryVersion,from=kind==='origin'?entry.stop:p.transfer,to=kind==='origin'?p.transfer:entry.stop;if(!from||!to)return;
  const features=[];let missing=0;const colors=['#246644','#426fa3','#b07832','#7b589a'];
  for(const r of entry.routes.filter(r=>r.selected)){
    let segment=r.segment;if((!segment||r.geometryVersion<SECTION_VERSION)&&r.shapeKey){const raw=await shapes.get(r.shapeKey);if(raw){const section=readSectionCache(raw,r,from,to,sectionOptions(r))||(Array.isArray(raw.parts)?clipShape(raw,from,to,r):null);if(section){segment=section.segment;r.segment=segment;r.geometryStatus=section.status;r.geometryMessage=section.message||'';r.geometryDiagnostics=section.diagnostics||null;r.geometryVersion=SECTION_VERSION;}}}
    if(token!==geometryVersion)return;if(!segment){missing++;continue;}
    features.push({type:'Feature',geometry:segment,properties:{number:r.number,color:colors[features.length%colors.length],offset:features.length*1.5}});
  }
  if(token!==geometryVersion||!displaysEdge(p,kind,entry))return;
  routeFeatures={type:'FeatureCollection',features};map?.getSource('route-sections')?.setData(routeFeatures);
  if(fit){if(features.length&&map)fitRouteFeatures();else focusStop(entry.stop);}
  $('map-line-status').hidden=false;$('map-line-status').textContent=features.length?`선택 구간 ${features.length}개 노선 · 저장된 선형${missing?' · 미확보 '+missing+'개':''}`:entry.routes.filter(r=>r.selected).map(r=>`${r.number}번: ${geometryState(r).label}`).join(' / ')||'표시할 노선을 선택하세요.';
}
function applyLabelVisibility(id,layer){
  if(!map?.getLayer(layer))return;
  const visibility=$(id).checked?'visible':'none';
  if((map.getLayoutProperty(layer,'visibility')??'visible')!==visibility){
    map.setLayoutProperty(layer,'visibility',visibility);
  }
}
for(const [id,layer] of labelLayers)$(id).onchange=()=>applyLabelVisibility(id,layer);

function pendingFocus(button){
  let owned=document.activeElement===button;
  const moved=e=>{if(e.target!==button)owned=false;},tabbed=e=>{if(e.key==='Tab')owned=false;};
  document.addEventListener('focusin',moved,true);document.addEventListener('pointerdown',moved,true);document.addEventListener('keydown',tabbed,true);
  return target=>{
    document.removeEventListener('focusin',moved,true);document.removeEventListener('pointerdown',moved,true);document.removeEventListener('keydown',tabbed,true);
    if(owned&&target?.isConnected&&!target.disabled&&(document.activeElement===button||document.activeElement===document.body))target.focus({preventScroll:true});
  };
}
function refreshQueriedConnection(kind,entry){
  renderPlanNetwork();const [currentKind,index]=focused.split(':'),group=kind==='origin'?plan.origins:plan.destinations;
  if(kind!==currentKind||group[Number(index)]!==entry)return null;
  const box=$('connection-detail'),active=document.activeElement,focusKey=box.contains(active)?active.dataset.focusKey:null;
  box.replaceChildren();renderConnection(kind,entry,group);
  if(tab!=='plan'||!panelOpen)return null;
  if(focusKey)(Array.from(box.querySelectorAll('[data-focus-key]')).find(el=>el.dataset.focusKey===focusKey)||box.querySelector('.edge-title'))?.focus({preventScroll:true});
  return box.querySelector('[data-focus-key="query"]');
}
async function queryEdge(kind,entry,button){
  if(pending.has(entry)||!plan.transfer||!requireKeys(['busstop','routes','transfer']))return;
  const token=version,restoreFocus=pendingFocus(button);pending.add(entry);entry.error='';button.disabled=true;button.textContent='조회 중…';button.closest('.edge-card').setAttribute('aria-busy','true');
  try{const from=kind==='origin'?entry.stop:plan.transfer,to=kind==='origin'?plan.transfer:entry.stop;
    const result=await queryDirectLeg(client,from,to,{entries,ids,platforms:region.platforms,routeHints:region.routeHints,check:()=>{if(token!==version)throw new DOMException('변경','AbortError');}});if(token!==version)return;
    if(!result.partial)entry.routes=entry.routes.filter(old=>result.routes.some(r=>r.routeId===old.routeId));
    for(const r of result.routes){const old=entry.routes.find(x=>x.routeId===r.routeId||(!x.routeId&&x.number===r.number));const checked=old?old.selected:false;const route=cleanRoute({...old,...r,geometryStatus:old?.geometryStatus||'not-requested',verified:true,selected:checked});if(old)Object.assign(old,route);else entry.routes.push(route);}
    if(result.routes[0]){if(/^\d{9}$/.test(result.routes[0].fromStandardId||''))from.standardId=result.routes[0].fromStandardId;if(/^\d{9}$/.test(result.routes[0].toStandardId||''))to.standardId=result.routes[0].toStandardId;}
    let geometryFailures=0;
    for(const r of entry.routes.filter(r=>result.routes.some(x=>x.routeId===r.routeId))){
      if(token!==version)return;
      if(r.segment)continue;
      if(!validCoordinates(from)||!validCoordinates(to)){r.geometryStatus='not-requested';continue;}
      try{const section=await getSectionOnQuery(client,shapes,r,from,to,sectionOptions(r));if(token!==version)return;r.shapeKey=section.shapeKey;r.segment=section.segment;r.geometryStatus=section.status;r.geometryMessage=section.message||'';r.geometrySource=section.source;r.geometryVersion=SECTION_VERSION;r.geometryDiagnostics=section.diagnostics||null;if(!r.segment)geometryFailures++;}
      catch(error){if(token!==version||error.name==='AbortError')return;r.geometryStatus='request-error';r.geometryMessage=error.message;geometryFailures++;}
    }
    entry.note=result.alternate?`승강장 조회 실패: ${result.error}. 알려진 노선 ${result.examined}개의 경유 순서를 대조해 이 구간을 지나는 후보 ${result.routes.length}개를 확인했습니다. 전체 목록은 아닙니다.${result.alternateError?' 추가 경유 목록 확인 실패: '+result.alternateError:''}${geometryFailures?' 선형 미확보 '+geometryFailures+'개.':''}`:result.sourceFailed?`조회 실패: ${result.error}. 최근 24시간 내 저장된 경유 순서에서 확인한 후보 ${result.routes.length}개를 확인했습니다. 기존 선택은 유지합니다.${geometryFailures?' 선형 미확보 '+geometryFailures+'개.':''}`:`두 정류장의 공통 경유 노선 ${result.examined}개에서 운행 순서를 확인했습니다.${!result.routes.length?' 이 구간에 맞는 노선이 없습니다.':''}${geometryFailures?' 선형 미확보 '+geometryFailures+'개.':''}`;
    if(displaysEdge(plan,kind,entry))showEdgeLines(plan,kind,entry);
    try{storage.setItem('busmap.route-stops.v2',JSON.stringify(entries));}catch{}
  }catch(e){if(token===version&&e.name!=='AbortError'){entry.error=e.message;}}finally{pending.delete(entry);restoreFocus(refreshQueriedConnection(kind,entry));}
}
$('plan-name').oninput=e=>plan.name=e.target.value;
$('new-direct').onclick=()=>{edit();plan=emptyPlan('direct');clearEntry();renderPlan();showPoints();pick('origin');};
$('new-plan').onclick=()=>{
  edit();plan=emptyPlan();clearEntry();renderPlan();showPoints();pick('origin');
};
function savedCardFor(id){
  return Array.from($('saved-list').children).find(card=>card.dataset.planId===id);
}
function openSavedPlan(id){
  selectTab('saved');
  const toggle=savedCardFor(id)?.querySelector('[data-saved-toggle]');
  if(!toggle)return;
  if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();
  focusInPanel(toggle);
}
$('save-form').onsubmit=event=>{
  event.preventDefault();
  try{
    const copy=validatePlan(plan);
    copy.id=copy.id||crypto.randomUUID();copy.name=copy.name||`${copy.transfer.name} ${copy.mode==='direct'?'직행':'환승'}`;
    writePlan(storage,copy);
    // Keep the draft's candidates and the entry objects used by its open controls.
    plan.id=copy.id;plan.name=copy.name;$('plan-name').value=copy.name;
    renderSaved();
    const status=$('plan-message');
    message(status,`‘${copy.name}’에 선택한 노선을 저장했습니다.`);
    const view=document.createElement('button');view.type='button';view.textContent='저장한 경로 보기';
    view.onclick=()=>openSavedPlan(copy.id);status.append(view);
    tell('경로 묶음을 이 브라우저에 저장했습니다.');
  }catch(err){message($('plan-message'),err.message,true);}
};

function renderSavedSummary(saved){
  const box=$('saved-summary');if(!box)return;
  const stops=new Set();let origins=0,destinations=0;
  for(const p of saved){origins+=p.origins.length;destinations+=p.mode==='direct'?1:p.destinations.length;for(const s of [p.transfer,...p.origins.map(e=>e.stop),...p.destinations.map(e=>e.stop)])if(s)stops.add(pointKey(s));}
  box.innerHTML=`<span class="stat-head">${saved.length?'저장된 묶음':'기록 없음'}</span>`+[['묶음',saved.length],['출발지',origins],['도착지',destinations],['정류장',stops.size]].map(([label,n])=>`<span><b>${n}</b>${label}</span>`).join('');
}
function renderSaved(){
  const saved=readPlans(storage);
  if(tab==='saved'){viewedPlan=null;clearLines();showPoints();}
  $('saved-count').textContent=saved.length;$('saved-list').replaceChildren();renderSavedSummary(saved);if(!saved.length)message($('saved-list'),'아직 저장한 묶음이 없습니다. 환승지 지정 탭에서 만들어 보세요.');
  for(const [index,p] of saved.entries()){
    const card=document.createElement('article');card.className='saved-card';card.dataset.planId=p.id;
    const diagramId=`saved-itinerary-${index}`;
    card.innerHTML=`<h3>${esc(p.name)}</h3><p>출발 ${p.origins.length}곳 → <b>${esc(p.transfer.name)}</b> ${p.mode==='direct'?'직행':'→ 도착 '+p.destinations.length+'곳'}</p><div class="saved-actions"><button type="button" data-saved-toggle aria-expanded="false" aria-controls="${diagramId}">경로 펼치기</button><button type="button" class="primary" aria-controls="saved-detail">도착정보 조회</button><button type="button">편집</button><button type="button">삭제</button></div>`;
    const diagram=document.createElement('div');diagram.id=diagramId;diagram.hidden=true;diagram.className='saved-diagram';card.append(diagram);
    const [toggle,query,editButton,remove]=card.querySelectorAll('.saved-actions button');
    let selected='';
    function draw(){
      renderNetwork(diagram,p,{selected,editable:false,onSelect:(kind,index)=>{
        viewedPlan=p;showPoints();
        if(kind==='transfer'){
          selected='';clearLines();draw();focusStop(p.transfer);return;
        }
        selected=`${kind}:${index}`;draw();
        const entry=(kind==='origin'?p.origins:p.destinations)[index];
        messageFooter(diagram,`${entry.stop.name} · ${entry.stop.number} / ${entry.routes.filter(r=>r.selected).map(r=>r.number+'번').join(' · ')}`);
        showEdgeLines(p,kind,entry,true);
      }});
    }
    toggle.onclick=()=>{
      diagram.hidden=!diagram.hidden;
      toggle.setAttribute('aria-expanded',String(!diagram.hidden));
      toggle.textContent=diagram.hidden?'경로 펼치기':'경로 접기';
      selected='';
      if(!diagram.hidden){viewedPlan=p;clearLines();draw();showPoints(true);}
      else if(viewedPlan===p){viewedPlan=null;clearLines();showPoints();}
    };
    query.onclick=()=>querySaved(p,query);
    editButton.onclick=()=>{
      edit();plan=structuredClone(p);renderPlan();selectTab('plan');showPoints(true);
      focusInPanel($('plan-network').querySelector('[aria-pressed="true"]'));
    };
    remove.onclick=()=>{
      try{
        storage.setItem(PLANS_KEY,JSON.stringify(readPlans(storage).filter(item=>item.id!==p.id)));
        const results=$('saved-detail');
        if(results.dataset.planId===p.id){results.replaceChildren();results.hidden=true;delete results.dataset.planId;}
        deleted=p;$('undo-delete').hidden=false;renderSaved();focusInPanel($('undo-button'));
      }catch(error){tell(error.message);}
    };
    $('saved-list').append(card);
  }
  $('legacy-section').hidden=!legacy.length;$('legacy-list').innerHTML=legacy.map(j=>`<p class="small-note"><b>${esc(j.name)}</b><br>${[j.points.from,j.points.via,j.points.to].filter(Boolean).map(s=>`${esc(s.name)} · ${esc(s.number)}`).join(' → ')}<br>${j.routes.map(r=>esc(r.number)+'번').join(' → ')} · 원래 저장 데이터는 유지됩니다.</p>`).join('');
}
$('undo-button').onclick=()=>{
  if(!deleted)return;
  try{
    const restored=writePlan(storage,deleted);deleted=null;$('undo-delete').hidden=true;renderSaved();
    focusInPanel(savedCardFor(restored.id)?.querySelector('[data-saved-toggle]'));
  }catch(error){tell(error.message);}
};
async function querySaved(p,button){
  if(pending.has('saved')){tell('도착정보를 조회하고 있습니다.');return;}
  const targets=arrivalTargets(p);
  if(!requireKeys(['realtime',...identityKeys(targets.map(target=>target.stop))]))return;
  pending.add('saved');button.disabled=true;
  if(viewedPlan?.id!==p.id)clearLines();
  viewedPlan=p;showPoints(true);
  const results=$('saved-detail'),box=document.createElement('div'),token=version;
  results.dataset.planId=p.id;results.hidden=false;results.replaceChildren(box);
  const current=()=>token===version&&box.isConnected;
  message(box,`${p.name}: 출발지 ${p.origins.length}곳${p.mode==='direct'?'':'과 환승지'}의 도착정보를 조회합니다.`);
  focusInPanel(results);
  try{
    for(const target of targets){
      if(!current())break;
      const section=document.createElement('section');section.className='arrival-block';
      section.innerHTML=`<h3>${esc(target.kind)} · ${stopLabel(target.stop)}</h3>`;box.append(section);
      try{
        const id=await standard(target.stop);
        if(!current())break;
        const {rows}=await client.get('realtime','bus_location_low_busstop_infomation_common',{stopStdid:id});
        if(!current())break;
        const serves=(row,r)=>r.routeId?f(row,'brtStdid')===r.routeId:f(row,'brtId')===r.number;
        const seconds=row=>/^\d+$/.test(f(row,'RTime'))?Number(f(row,'RTime')):Infinity;
        const matching=rows.filter(row=>target.routes.some(r=>serves(row,r))).sort((a,b)=>seconds(a)-seconds(b));
        if(!matching.length)messageFooter(section,rows.length?'현재 도착 목록에 선택한 노선이 없습니다.':'이 정류장에 제공된 도착정보가 없습니다.');
        for(const row of matching){
          const line=document.createElement('div');line.className='arrival-card';
          line.innerHTML=`<span><b>${esc(f(row,'brtId'))}번</b><small>${esc([f(row,'brtVianame'),f(row,'viaStopname')&&f(row,'viaStopname')+' 통과',f(row,'busLow')==='1'?'저상버스':''].filter(Boolean).join(' · '))}</small></span><b>${esc(arrivalEstimate(row))}</b>`;section.append(line);
        }
        if(matching.length){
          const missing=target.routes.filter(r=>!matching.some(row=>serves(row,r)));
          for(const route of new Map(missing.map(r=>[r.routeId||r.number,r])).values()){
            messageFooter(section,`${route.number}번 ${route.destination||''} · 현재 도착정보 없음`);
          }
        }
      }catch(error){if(current()&&error.name!=='AbortError')messageFooter(section,'조회 실패: '+error.message);}
    }
    if(current())messageFooter(box,new Date().toLocaleTimeString('ko-KR')+' 수동 조회 · 자동 갱신 없음');
  }finally{pending.delete('saved');button.disabled=false;}
}
function renderServicePoints(){const box=$('service-points');box.replaceChildren();for(const [role,label]of [['from','출발지'],['to','도착지']]){const s=service[role];const card=document.createElement('div');card.className='service-point';card.innerHTML=`<label>${label}</label>`;if(s)card.append(stopCard(s));const b=document.createElement('button');b.className='add-stop wide';b.textContent=s?'다른 정류장 선택':`+ ${label} 선택`;b.onclick=()=>pick(role==='from'?'serviceFrom':'serviceTo');card.append(b);box.append(card);}}
$('service-query').onclick=async()=>{
  const button=$('service-query');if(button.disabled)return;if(!service.from||!service.to){message($('service-results'),'출발지와 도착지를 선택하세요.',true);return;}if(pointKey(service.from)===pointKey(service.to)){message($('service-results'),'서로 다른 정류장을 선택하세요.',true);return;}if(!requireKeys(['transfer',...identityKeys([service.from,service.to])]))return;
  button.disabled=true;const token=version;message($('service-results'),'한 번 조회하는 중…');
  try{const from=await standard(service.from),to=await standard(service.to);if(token!==version)return;const {rows}=await client.get('transfer','fromto_bus_search_transfer_detail_common',{sStandardId:from,eStandardId:to,maxCnt:10});if(token!==version)return;
    $('service-results').replaceChildren();if(!rows.length)message($('service-results'),'제공된 경로가 없습니다.');
    rows.forEach((row,i)=>{
      const card=document.createElement('article');card.className='journey-card';
      const first=f(row,'startNo'),second=f(row,'finNo'),via=f(row,'chgName');
      const routeLabel=[first,second].filter(Boolean).map(n=>n+'번').join(' → ')||'노선 미제공';
      const title=document.createElement('h3');title.textContent=`경로 ${i+1} · ${routeLabel}`;card.append(title);
      const count=key=>/^\d+$/.test(f(row,key))?' · '+f(row,key)+'정류장':'';
      if(via||second){
        messageFooter(card,`승차 · ${service.from.name} → ${via||'환승지 미제공'}${count('RStop1')}`);
        messageFooter(card,`환승 · ${via||'환승지 미제공'} → ${service.to.name}${count('RStop2')}`);
      }else{
        messageFooter(card,`${service.from.name} → ${service.to.name}${count('RStop1')}`);
      }
      const metrics=[['예상시간','tripTime'],['거리','tripDistance']].filter(([,key])=>f(row,key));
      if(metrics.length)messageFooter(card,metrics.map(([name,key])=>name+' '+f(row,key)).join(' · ')+' (제공값)');
      $('service-results').append(card);
    });
  }catch(e){if(token===version&&e.name!=='AbortError')message($('service-results'),e.message,true);}finally{button.disabled=false;}
};
function clearEntry(){
  for(const id of ['stop-search','manual-number','manual-name'])$(id).value='';
  $('stop-picker').open=false;
  $('manual-stop-form').closest('details').open=false;
  renderSearch();
}
const panelTitles = {plan:'환승지 지정', saved:'저장한 경로', service:'환승정보 서비스', about:'데이터 출처'};
function updatePanelHeading(name){
  if($('panel-title').textContent===panelTitles[name])return;
  $('panel-title').textContent=panelTitles[name];
  $('planning-panel').scrollTop=0;
}
function selectTab(name){setPanel(true);clearLines();tab=name;updatePanelHeading(name);for(const b of document.querySelectorAll('[data-tab]')){if(b.dataset.tab===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}for(const t of ['plan','saved','service','about'])$(t+'-panel').hidden=t!==name;$('picker').hidden=name==='saved'||name==='about';activeRole=name==='service'?'serviceFrom':'origin';clearEntry();renderPicker();if(name==='saved')renderSaved();showPoints();}
let panelOpen=true;
function setPanel(open){
  const mapWasHidden=map&&!mapHasSize();panelOpen=open;const panel=$('planning-panel'),toggle=$('panel-toggle');
  if(!open&&panel.contains(document.activeElement))toggle.focus();
  document.querySelector('main').classList.toggle('panel-collapsed',!open);panel.classList.toggle('collapsed',!open);$('panel-body').hidden=!open;
  toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-controls','planning-panel');toggle.textContent=open?'지도 크게':'경로 보기';
  if(mapWasHidden){refitOnReveal=true;requestAnimationFrame(resizeMap);}
}
$('panel-toggle').onclick=()=>setPanel(!panelOpen);
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>selectTab(b.dataset.tab);
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
  $('mobile-dataset-meta').textContent=detail;
  $('mobile-dataset-meta').hidden=!detail;
  el.classList.toggle('needs-key',!keyed);
  el.textContent=keyed?(detail||'API 키 적용됨'):'API 키 입력';
  el.title='API 키 설정 열기';
}
function renderKeyState(){
  for(const [source,id] of KEY_FIELDS){const el=$(id+'-state');if(!el)continue;const key=keys[source]||'';el.classList.toggle('set',Boolean(key));el.classList.toggle('stored',Boolean(key)&&persistKeys);el.textContent=key?`적용됨 · ${maskKey(key)} · ${persistKeys?'브라우저에 저장됨':'이 탭의 메모리에만 보관'}`:'미설정';}
  paintKeyOptions();renderDataset();
}
function openKeySettings(message=''){
  renderKeyState();
  $('settings-error').textContent=message;
  $('settings').showModal();
}
$('dataset-label').onclick=()=>openKeySettings();
function stopConsent(){clearInterval(consentTimer);consentTimer=null;}
function cancelConsent(){stopConsent();consentOpen=consentReady=false;consentLeft=0;paintKeyOptions();}
function startConsent(){consentOpen=true;consentReady=false;consentLeft=CONSENT_SECONDS;stopConsent();paintKeyOptions();consentTimer=setInterval(()=>{consentLeft-=1;if(consentLeft<=0){consentReady=true;stopConsent();}paintKeyOptions();},1000);}
$('key-persist').onchange=e=>{
  if(!e.target.checked){cancelConsent();if(persistKeys){persistKeys=false;eraseStoredKeys();renderKeyState();tell('브라우저 저장을 끄고 저장된 키를 지웠습니다. 이 탭에서는 계속 사용합니다.');}return;}
  startConsent();
};
$('key-consent-ok').onclick=()=>{if(!consentReady)return;stopConsent();consentOpen=consentReady=false;persistKeys=true;if(hasKeys()&&!writeStoredKeys())persistKeys=false;renderKeyState();tell(persistKeys?'브라우저 저장에 동의했습니다. 현재 키를 저장했습니다.':'키를 먼저 적용한 뒤 다시 시도하세요.');};
$('settings-open').onclick=()=>openKeySettings();
$('settings-close').onclick=()=>$('settings').close();
$('settings').addEventListener('close',()=>{
  cancelConsent();
  for(const [,id] of KEY_FIELDS)$(id).value='';
});
$('settings-form').onsubmit=e=>{e.preventDefault();const next={...keys};for(const [source,id] of KEY_FIELDS){const value=$(id).value.trim();if(value)next[source]=value;}if(!Object.values(next).some(Boolean)){$('settings-error').textContent='키를 입력하세요.';return;}++version;client.reset({keysChanged:true});keys=next;$('settings-form').reset();$('settings-error').textContent='';if(persistKeys)writeStoredKeys();renderKeyState();$('settings').close();tell(persistKeys?'키를 적용하고 이 브라우저에 저장했습니다.':'키를 적용했습니다. 이 탭의 메모리에만 있습니다.');};
$('clear-key').onclick=()=>{++version;client.reset({keysChanged:true});keys={};persistKeys=false;eraseStoredKeys();$('settings-form').reset();renderKeyState();$('settings').close();tell('키를 지웠습니다. 저장한 묶음은 유지됩니다.');};
$('key-warning').addEventListener('close',()=>{try{sessionStorage.setItem(KEY_NOTICE,'1');}catch{}});
$('key-warning-ack').onclick=()=>$('key-warning').close();
$('key-warning-manage').onclick=()=>{
  $('key-warning').close();
  openKeySettings();
};
function maybeWarnStoredKeys(){if(!persistKeys||!hasKeys())return;let seen=false;try{seen=sessionStorage.getItem(KEY_NOTICE)==='1';}catch{}if(seen||$('key-warning').open)return;$('key-warning').showModal();}
$('load-data').onclick=async()=>{
  if(loading||!requireKeys(['stops']))return;loading=true;const token=version;$('load-data').disabled=true;
  try{const dataset=latestStopDataset(await getSpec()),rows=[];for(let page=1;;page++){if(token!==version)return;const result=await client.get('stops',dataset.path,{page,perPage:1000,returnType:'JSON'});if(token!==version)return;rows.push(...result.rows);if(rows.length>=result.total)break;if(!result.rows.length||page>=50)throw new Error('정류장 일부를 받지 못했습니다.');}
    const updated=rows.map(normalizeStop).filter(s=>s.name&&s.number&&validCoordinates(s));
    if(!updated.length)throw new Error('사용 가능한 정류장이 없어 이전 목록을 유지합니다.');
    stops=updated;try{storage.setItem('busmap.stops.v1',JSON.stringify({date:dataset.date,stops}));}catch{tell('정류장 로컬 저장 공간이 부족합니다.');}
    datasetLabel=`${dataset.date} · ${stops.length.toLocaleString()}개`;renderDataset();map?.getSource('bus-stops')?.setData(features());renderPicker();tell('최신 정류장 목록을 불러왔습니다.');
  }catch(e){if(e.name!=='AbortError')tell(e.message);}finally{loading=false;$('load-data').disabled=false;}
};

renderPlan();renderServicePoints();renderSaved();renderPicker();renderKeyState();applyRegion(document,region);maybeWarnStoredKeys();

$('stop-picker').addEventListener('toggle',()=>{for(const layer of ['bus-stops','stop-clusters','stop-cluster-count'])if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility',$('stop-picker').open&&tab!=='saved'&&tab!=='about'?'visible':'none');});
