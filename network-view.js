const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function networkView(plan,{selected='',onSelect=()=>{},editable=true}={}) {
  const box=document.createElement('div');box.className='transfer-network itinerary-network';
  const direct=plan.mode==='direct',hubLabel=direct?'도착지':'환승지';
  for(const [kind,list,label]of [['origin',plan.origins,'1구간 · 출발지 → 환승지'],['destination',plan.destinations,'2구간 · 환승지 → 도착지']]){
    if(kind==='destination'){
      const hub=document.createElement('button');hub.type='button';hub.className='itinerary-hub';hub.setAttribute('data-network-action','transfer');
      hub.innerHTML=`<small>${hubLabel}</small><span class="itinerary-hub-name"><b>${escape(plan.transfer?.name||hubLabel+' 찾기')}</b>${plan.transfer?`<small>정류장 ${escape(plan.transfer.number)}</small>`:''}</span>`;
      if(editable)hub.setAttribute('aria-controls','stop-picker');
      hub.setAttribute('aria-label',plan.transfer?`${hubLabel} ${plan.transfer.name} ${plan.transfer.number}`:hubLabel+' 지정');hub.onclick=()=>onSelect('transfer',0);box.append(hub);if(direct)continue;
    }
    const section=document.createElement('section');section.className='itinerary-group';
    const heading=document.createElement('h3');heading.textContent=direct?'직행 · 출발지 → 도착지':label;section.append(heading);
    list.forEach((entry,index)=>{
      const button=document.createElement('button');button.type='button';button.className='itinerary-stop';button.setAttribute('aria-pressed',String(selected===`${kind}:${index}`));button.setAttribute('data-network-action',`${kind}:${index}`);
      const routes=entry.routes.filter(r=>r.selected),numbers=[...new Set(routes.map(r=>r.number+'번'))];
      const action=editable?'노선 선택':'저장 구간 보기';
      button.setAttribute('aria-label',`${kind==='origin'?'출발':'도착'} ${entry.stop.name} ${entry.stop.number} ${numbers.join(' · ')} ${action}`.replace(/\s+/g,' '));
      if(editable)button.setAttribute('aria-controls','connection-detail');
      button.innerHTML=`<span class="itinerary-stop-name"><b>${escape(entry.stop.name)}</b><small>${escape(entry.stop.number)}</small></span><span class="itinerary-routes">${numbers.length?numbers.map(escape).join(' · '):action} <span aria-hidden="true">→</span></span>`;
      button.onclick=()=>onSelect(kind,index);section.append(button);
    });
    if(editable){
      const add=document.createElement('button');
      add.type='button';add.className='itinerary-add';
      add.setAttribute('data-network-action','add-'+kind);
      add.setAttribute('aria-controls','stop-picker');
      const role=kind==='origin'?'출발':'도착';
      add.textContent=list.length?`+ ${role}지 추가`:`${role} 정류장 찾기`;
      if(kind==='origin'&&!list.length&&!plan.transfer&&!plan.destinations.length)add.className+=' primary';
      add.onclick=()=>onSelect('add-'+kind,0);section.append(add);
    }
    box.append(section);
  }
  return box;
}
