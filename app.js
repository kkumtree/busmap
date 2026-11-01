import * as ML from './vendor/maplibre-gl.mjs';
import {createClient,latestStopDataset,normalizeStop,arrivalTime,field as f} from './api.js';
import {queryDirectLeg,fetchStopSpec,resolveStopIdentity} from './targeted.js';
import {readJourneys} from './journey.js';
import {networkView} from './network-view.js';
import {shapeStore} from './shape-cache.js';
import {getShapeOnQuery,clipShape} from './route-geometry.js';
import {PLANS_KEY,emptyPlan,cleanPoint,cleanRoute,normalizePlan,pointKey,validatePlan,readPlans,writePlan,arrivalTargets,stopHint} from './plan-model.js';

const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let storage;try{storage=localStorage;}catch{storage={getItem:()=>null,setItem:()=>{throw new Error('브라우저의 로컬 저장이 차단되어 있습니다.');}};}
const read=(key,fallback)=>{try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}};
let focused='',geometryVersion=0,routeFeatures={type:'FeatureCollection',features:[]};
const shapes=shapeStore();
let plan=emptyPlan(),tab='plan',activeRole='origin',service={from:null,to:null},viewedPlan=null;
let keys={},version=0,loading=false,popup,toastTimer,specPromise,deleted;
const client=createClient(source=>keys[source]||keys.default||'');
const ids=new Map(),markers=[],pending=new Set();
const cache=read('busmap.route-stops.v2',{}),entries=cache&&typeof cache==='object'&&!Array.isArray(cache)?cache:{};
const stopCache=read('busmap.stops.v1',{});
let stops=Array.isArray(stopCache.stops)?stopCache.stops.filter(s=>s && typeof s.number==='string' && typeof s.name==='string'):[];
const legacy=readJourneys(storage);
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
let map;
try{
  map=new ML.Map({container:'map',style:'./map-style.json',center:[127.135,35.825],zoom:12.3,attributionControl:false,pitchWithRotate:false,dragRotate:false});
  map.addControl(new ML.NavigationControl({showCompass:false}),'top-right');map.addControl(new ML.AttributionControl({compact:false}),'bottom-right');
  map.on('error',()=>{$('map-error').textContent='배경지도 연결을 확인하세요. 정류장 선택과 로컬 저장은 계속 사용할 수 있습니다.';$('map-error').hidden=false;});
  map.on('load',()=>{
    map.addSource('route-sections',{type:'geojson',data:routeFeatures});
    map.addLayer({id:'route-section-halo',type:'line',source:'route-sections',paint:{'line-color':'#fff','line-width':8,'line-opacity':.85}});
    map.addLayer({id:'route-section-lines',type:'line',source:'route-sections',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':['get','color'],'line-width':4,'line-offset':['get','offset']}});
    map.addLayer({id:'route-section-numbers',type:'symbol',source:'route-sections',layout:{'symbol-placement':'line','text-field':['get','number'],'text-font':['Noto Sans Regular'],'text-size':12},paint:{'text-color':'#214f36','text-halo-color':'#fff','text-halo-width':2}});
    map.addSource('bus-stops',{type:'geojson',data:features()});map.addLayer({id:'bus-stops',type:'circle',source:'bus-stops',layout:{visibility:$('stop-picker').open?'visible':'none'},paint:{'circle-radius':['interpolate',['linear'],['zoom'],10,2,14,4,17,6],'circle-color':'#63816b','circle-opacity':.8,'circle-stroke-color':'#fff','circle-stroke-width':1}});
    map.on('click','bus-stops',e=>{const s=stops[Number(e.features?.[0]?.properties.index)];if(s)showStop(s);});
    map.on('mouseenter','bus-stops',()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave','bus-stops',()=>map.getCanvas().style.cursor='');
  });
}catch{$('map-error').hidden=false;$('map-error').textContent='지도 대신 정류장 이름·번호로 선택할 수 있습니다.';}
function features(){return {type:'FeatureCollection',features:stops.flatMap((s,index)=>validCoordinates(s)?[{type:'Feature',geometry:{type:'Point',coordinates:[s.lon,s.lat]},properties:{index}}]:[])};}
function currentRoles(){return tab==='service'?[['serviceFrom','출발지'],['serviceTo','도착지']]:[['origin','출발지 추가'],['transfer','환승지 지정'],['destination','도착지 추가']];}
function focusStop(s){if(map&&validCoordinates(s))map.flyTo({center:[s.lon,s.lat],zoom:15,padding:window.matchMedia('(max-width:650px)').matches?{top:35,left:25,right:25,bottom:300}:{top:50,left:460,right:60,bottom:50}});}
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
  if(fit&&selected.length){const bounds=new ML.LngLatBounds();selected.forEach(s=>bounds.extend([s.lon,s.lat]));const mobile=window.matchMedia('(max-width:650px)').matches;map.fitBounds(bounds,{maxZoom:15.5,duration:400,padding:mobile?{top:60,left:30,right:30,bottom:window.innerHeight*.52}:{top:70,left:Math.min(480,innerWidth*.45),right:Math.min(180,innerWidth*.15),bottom:70}});}
}
function addPoint(role,value){
  const s=cleanPoint(value);edit();
  if(role==='origin'||role==='destination'){
    const group=role==='origin'?plan.origins:plan.destinations;
    if(group.some(e=>pointKey(e.stop)===pointKey(s))){tell('이미 추가한 정류장입니다.');return;}
    if(plan.transfer&&pointKey(plan.transfer)===pointKey(s)){tell('환승지와 다른 정류장을 골라 주세요.');return;}
    group.push({stop:s,routes:[]});
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
  if(!q){message(box,stops.length?`${stops.length.toLocaleString()}개 정류장 · 지도에서 선택하거나 검색하세요.`:'저장된 정류장이 없습니다. 불러오기 또는 번호 직접 추가를 이용하세요.');return;}
  const found=stops.filter(s=>`${s.name} ${s.number}`.toLowerCase().includes(q));
  for(const s of found.slice(0,30)){const b=document.createElement('button');b.className='search-item';b.innerHTML=`<span>${stopLabel(s)}</span>${meta(s)}`;b.onclick=()=>{addPoint(activeRole,s);focusStop(s);};box.append(b);}
  if(!found.length)message(box,'검색 결과가 없습니다. 번호로 직접 추가할 수 있습니다.');
  if(found.length>30)messageFooter(box,'처음 30개입니다. 검색어를 더 입력하세요.');
}
function messageFooter(el,text){const p=document.createElement('p');p.className='small-note';p.textContent=text;el.append(p);}
$('stop-search').oninput=renderSearch;
$('manual-stop-form').onsubmit=e=>{e.preventDefault();const number=$('manual-number').value.trim();if(!/^\d+$/.test(number))return;const s=stops.find(p=>p.number===number)||{number,name:$('manual-name').value.trim()||`정류장 ${number}`,lat:null,lon:null};addPoint(activeRole,s);$('manual-stop-form').reset();};
function stopCard(s){const card=document.createElement('div');card.className='stop-card';card.innerHTML=`<button type="button" class="stop-location">${stopLabel(s)}${meta(s)}</button>`;card.querySelector('button').onclick=()=>focusStop(s);return card;}
function renderPlan(){
  $('plan-name').value=plan.name;
  $('plan-network').replaceChildren(networkView(plan,{selected:focused,onSelect:(kind,index)=>{
    if(kind==='transfer'){pick('transfer');return;}
    if(kind.startsWith('add-')){pick(kind.slice(4));return;}
    focused=focused===`${kind}:${index}`?'':`${kind}:${index}`;renderPlan();
    const entry=(kind==='origin'?plan.origins:plan.destinations)[index];if(focused)showEdgeLines(plan,kind,entry,true);else clearLines();
  }}));
  $('connection-detail').replaceChildren();
  if(focused){const [kind,raw]=focused.split(':'),group=kind==='origin'?plan.origins:plan.destinations,entry=group[Number(raw)];if(entry)renderConnection(kind,entry,group);else focused='';}
}
function renderConnection(kind,entry,group){
  const box=$('connection-detail'),card=stopCard(entry.stop);card.classList.add('edge-card');
  const h=document.createElement('h3');h.className='edge-title';h.textContent=kind==='origin'?'출발지 → 환승지':'환승지 → 도착지';card.prepend(h);
  const remove=document.createElement('button');remove.className='quiet remove-stop';remove.textContent='×';remove.setAttribute('aria-label',`${entry.stop.name} ${entry.stop.number} 삭제`);remove.onclick=()=>{edit();group.splice(group.indexOf(entry),1);renderPlan();showPoints();};card.append(remove);
  const routeBox=document.createElement('div');routeBox.className='route-choices';
  for(const route of entry.routes){const label=document.createElement('label');label.className='route-check';label.innerHTML=`<input type="checkbox" ${route.selected?'checked':''}><span><b>${esc(route.number)}번</b>${route.destination?'<small>'+esc(route.destination)+'</small>':''}<small>${route.verified?'경유 확인':'경유 확인 전'} · ${route.segment?'선형 저장됨':'선형 미확보'}</small></span>`;label.querySelector('input').onchange=e=>{route.selected=e.target.checked;renderPlan();showEdgeLines(plan,kind,entry);};routeBox.append(label);}
  card.append(routeBox);const tools=document.createElement('div');tools.className='edge-tools';const query=document.createElement('button');query.textContent=pending.has(entry)?'조회 중…':'후보 노선 조회';query.disabled=!plan.transfer||pending.has(entry);query.onclick=()=>queryEdge(kind,entry);tools.append(query);card.append(tools);
  const note=document.createElement('p');note.className=entry.error?'error':'small-note';note.textContent=entry.error||entry.note||'이 버튼을 누를 때만 후보 노선과 형상을 조회합니다. 저장된 형상은 재사용합니다.';card.append(note);box.append(card);
}
$('add-origin').onclick=()=>pick('origin');$('add-destination').onclick=()=>pick('destination');$('change-transfer').onclick=()=>pick('transfer');
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
  if(fit){if(features.length&&map){const bounds=new ML.LngLatBounds();for(const feature of features)for(const p of feature.geometry.coordinates)bounds.extend(p);map.fitBounds(bounds,{padding:{top:100,left:Math.min(480,innerWidth*.45),right:90,bottom:60},maxZoom:15.5});}else focusStop(entry.stop);}
  $('map-line-status').hidden=false;$('map-line-status').textContent=features.length?`선택 구간 ${features.length}개 노선 · 저장된 선형${missing?' · 미확보 '+missing+'개':''}`:'이 구간의 저장된 선형이 없습니다. 임의의 연결선은 표시하지 않습니다.';
}
for(const [id,layer]of [['show-dong','legal-dong-names'],['show-apartments','apartment-names']])$(id).onchange=e=>{if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility',e.target.checked?'visible':'none');};

async function queryEdge(kind,entry){
  if(pending.has(entry)||!plan.transfer||!requireKeys(['stops','routes','realtime','transfer']))return;
  const token=version;pending.add(entry);entry.error='';renderPlan();
  try{const from=kind==='origin'?entry.stop:plan.transfer,to=kind==='origin'?plan.transfer:entry.stop;await hydrate(from);await hydrate(to);if(token!==version)return;
    const result=await queryDirectLeg(client,from,to,{ids,entries,getSpec,allowedNumbers:({'30887:30920':['61'],'30927:30920':['200'],'30920:36347':['101'],'30920:36351':['74','75']})[`${from.number}:${to.number}`],check:()=>{if(token!==version)throw new DOMException('변경','AbortError');}});if(token!==version)return;
    for(const r of result.routes){const old=entry.routes.find(x=>x.routeId===r.routeId||(!x.routeId&&x.number===r.number));const checked=old?old.selected:false;const route=cleanRoute({...r,verified:true,selected:checked});if(old)Object.assign(old,route);else entry.routes.push(route);}
    if(result.routes[0]){from.standardId=result.routes[0].fromStandardId;to.standardId=result.routes[0].toStandardId;}
    let geometryFailures=0;
    for(const r of entry.routes.filter(r=>result.routes.some(x=>x.routeId===r.routeId))){
      if(r.segment)continue;
      try{const shape=await getShapeOnQuery(client,shapes,r.routeId);if(token!==version)return;const section=clipShape(shape,from,to,r);r.shapeKey=r.routeId;r.segment=section.segment;r.geometryStatus=section.status;if(!r.segment)geometryFailures++;}
      catch{r.geometryStatus='missing';geometryFailures++;}
    }
    entry.note=`후보 ${result.examined}개 확인 · 저장된 형상은 재사용합니다.${geometryFailures?' 선형 미확보 '+geometryFailures+'개.':''}`;
    showEdgeLines(plan,kind,entry);
    try{storage.setItem('busmap.route-stops.v2',JSON.stringify(entries));}catch{}
  }catch(e){if(token===version&&e.name!=='AbortError')entry.error=e.message;}finally{pending.delete(entry);if(token===version)renderPlan();}
}
$('plan-name').oninput=e=>plan.name=e.target.value;
$('new-plan').onclick=()=>{edit();plan=emptyPlan();renderPlan();showPoints();};
$('save-form').onsubmit=e=>{e.preventDefault();try{const copy=validatePlan(plan);copy.id=copy.id||crypto.randomUUID();copy.name=copy.name||`${copy.transfer.name} 환승`;plan=writePlan(storage,copy);renderSaved();message($('plan-message'),'저장했습니다. 출발지와 도착지별 노선 선택을 함께 보관합니다.');tell('경로 묶음을 이 브라우저에 저장했습니다.');}catch(err){message($('plan-message'),err.message,true);}};

function renderSaved(){
  const saved=readPlans(storage);$('saved-count').textContent=saved.length;$('saved-list').replaceChildren();if(!saved.length)message($('saved-list'),'아직 저장한 묶음이 없습니다. 환승지 지정 탭에서 만들어 보세요.');
  for(const p of saved){const card=document.createElement('article');card.className='saved-card';card.innerHTML=`<h3>${esc(p.name)}</h3><p>출발 ${p.origins.length}곳 → <b>${esc(p.transfer.name)}</b> → 도착 ${p.destinations.length}곳</p><div class="saved-actions"><button aria-expanded="false">연결도 펼치기</button><button class="primary">도착정보 조회</button><button>편집</button><button>삭제</button></div>`;
    const diagram=document.createElement('div');diagram.hidden=true;diagram.className='saved-diagram';card.append(diagram);
    const [toggle,query,editButton,remove]=card.querySelectorAll('.saved-actions button');
    let selected='';const draw=()=>{diagram.replaceChildren(networkView(p,{selected,onSelect:(kind,index)=>{if(kind==='transfer'){focusStop(p.transfer);return;}if(kind.startsWith('add-'))return;selected=`${kind}:${index}`;viewedPlan=p;showPoints();draw();const e=(kind==='origin'?p.origins:p.destinations)[index];messageFooter(diagram,`${e.stop.name} · ${e.stop.number} / ${e.routes.filter(r=>r.selected).map(r=>r.number+'번').join(' · ')}`);showEdgeLines(p,kind,e,true);}}));};
    toggle.onclick=()=>{diagram.hidden=!diagram.hidden;toggle.setAttribute('aria-expanded',String(!diagram.hidden));toggle.textContent=diagram.hidden?'연결도 펼치기':'연결도 접기';if(!diagram.hidden){viewedPlan=p;draw();showPoints(true);}};
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
function selectTab(name){clearLines();tab=name;for(const b of document.querySelectorAll('[data-tab]')){if(b.dataset.tab===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}for(const t of ['plan','saved','service'])$(t+'-panel').hidden=t!==name;$('picker').hidden=name==='saved';activeRole=name==='service'?'serviceFrom':'origin';renderPicker();if(name==='saved')renderSaved();showPoints();}
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>selectTab(b.dataset.tab);
$('panel-toggle').onclick=()=>{const collapsed=document.querySelector('.sidebar').classList.toggle('collapsed');$('panel-body').hidden=collapsed;$('panel-toggle').textContent=collapsed?'펼치기':'접기';$('panel-toggle').setAttribute('aria-expanded',String(!collapsed));};
$('settings-open').onclick=()=>$('settings').showModal();$('settings-close').onclick=()=>$('settings').close();
$('settings-form').onsubmit=e=>{e.preventDefault();const next={default:$('api-key').value.trim()};for(const source of ['stops','routes','realtime','transfer'])next[source]=$(source+'-key').value.trim();if(!Object.values(next).some(Boolean)){$('settings-error').textContent='키를 입력하세요.';return;}++version;client.reset();keys=next;$('settings-form').reset();$('settings-error').textContent='';$('settings').close();tell('키를 적용했습니다. 조회 버튼을 누를 때만 요청합니다.');};
$('clear-key').onclick=()=>{++version;client.reset();keys={};$('settings-form').reset();$('settings').close();tell('키를 지웠습니다. 저장한 묶음은 유지됩니다.');};
$('load-data').onclick=async()=>{
  if(loading||!requireKeys(['stops']))return;loading=true;$('load-data').disabled=true;
  try{const dataset=latestStopDataset(await getSpec()),rows=[];for(let page=1;;page++){const result=await client.get('stops',dataset.path,{page,perPage:1000,returnType:'JSON'});rows.push(...result.rows);if(rows.length>=result.total)break;if(!result.rows.length||page>=50)throw new Error('정류장 일부를 받지 못했습니다.');}
    stops=rows.map(normalizeStop).filter(s=>s.name&&s.number&&validCoordinates(s));try{storage.setItem('busmap.stops.v1',JSON.stringify({date:dataset.date,stops}));}catch{tell('정류장 로컬 저장 공간이 부족합니다.');}
    $('dataset-label').textContent=`${dataset.date} · ${stops.length.toLocaleString()}개`;map?.getSource('bus-stops')?.setData(features());renderPicker();tell('최신 정류장 목록을 불러왔습니다.');
  }catch(e){if(e.name!=='AbortError')tell(e.message);}finally{loading=false;$('load-data').disabled=false;}
};
if(stops.length)$('dataset-label').textContent=`저장된 정류장 ${stops.length.toLocaleString()}개`;
renderPlan();renderServicePoints();renderSaved();renderPicker();

// Local reference assets only: never query government APIs during initialization.
fetch('./data/focus-plan.json').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(reference=>{
  const p=normalizePlan(reference.plan),points=[p.transfer,...p.origins.map(e=>e.stop),...p.destinations.map(e=>e.stop)];
  for(const s of points)if(!stops.some(x=>pointKey(x)===pointKey(s)))stops.push(s);
  const saved=readPlans(storage).find(x=>x.transfer.number==='30920'&&x.origins.some(e=>e.stop.number==='30887')&&x.origins.some(e=>e.stop.number==='30927'));
  if(!plan.origins.length&&!plan.destinations.length&&!plan.transfer)plan=saved?structuredClone(saved):p;
  $('dataset-label').textContent=stops.length>5?`저장된 정류장 ${stops.length.toLocaleString()}개`:'지정 정류장 5곳';
  map?.getSource('bus-stops')?.setData(features());renderPlan();renderPicker();showPoints(true);
}).catch(()=>{});

$('stop-picker').addEventListener('toggle',()=>{if(map?.getLayer('bus-stops'))map.setLayoutProperty('bus-stops','visibility',$('stop-picker').open&&tab!=='saved'?'visible':'none');});
