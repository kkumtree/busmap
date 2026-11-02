const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function networkView(plan,{selected='',onSelect=()=>{},editable=true}={}) {
  const box=document.createElement('div');box.className='transfer-network itinerary-network';
  for(const [kind,list,label]of [['origin',plan.origins,'1구간 · 출발지 → 환승지'],['destination',plan.destinations,'2구간 · 환승지 → 도착지']]){
    if(kind==='destination'){
      const hub=document.createElement('button');hub.type='button';hub.className='itinerary-hub';
      hub.innerHTML=`<small>환승지</small><b>${escape(plan.transfer?.name||'환승지 지정')}</b>${plan.transfer?`<small>정류장 ${escape(plan.transfer.number)}</small>`:''}`;
      hub.setAttribute('aria-label',plan.transfer?`환승지 ${plan.transfer.name} ${plan.transfer.number}`:'환승지 지정');hub.onclick=()=>onSelect('transfer',0);box.append(hub);
    }
    const section=document.createElement('section');section.className='itinerary-group';
    const heading=document.createElement('h3');heading.textContent=label;section.append(heading);
    list.forEach((entry,index)=>{
      const button=document.createElement('button');button.type='button';button.className='itinerary-stop';button.setAttribute('aria-pressed',String(selected===`${kind}:${index}`));
      button.setAttribute('aria-label',`${kind==='origin'?'출발':'도착'} ${entry.stop.name} ${entry.stop.number} 노선 선택`);
      const routes=entry.routes.filter(r=>r.selected),numbers=[...new Set(routes.map(r=>r.number+'번'))];
      button.innerHTML=`<span class="itinerary-stop-name"><b>${escape(entry.stop.name)}</b><small>${escape(entry.stop.number)}</small></span><span class="itinerary-routes">${numbers.length?numbers.map(escape).join(' · '):'노선 선택'} <span aria-hidden="true">→</span></span>`;
      button.onclick=()=>onSelect(kind,index);section.append(button);
    });
    if(editable){const add=document.createElement('button');add.type='button';add.className='itinerary-add';add.textContent=kind==='origin'?'+ 출발지 추가':'+ 도착지 추가';add.onclick=()=>onSelect('add-'+kind,0);section.append(add);}box.append(section);
  }
  return box;
}
