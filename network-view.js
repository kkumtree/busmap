const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let serial=0;
export function networkLayout(plan) {
  const height=Math.max(210,Math.max(plan.origins.length,plan.destinations.length)*90+30);
  const branches=[];
  for(const [kind,list]of [['origin',plan.origins],['destination',plan.destinations]])list.forEach((entry,index)=>{
    branches.push({kind,index,entry,x:kind==='origin'?95:505,y:height*(index+1)/(list.length+1)});
  });
  return {height,branches};
}
export function networkView(plan,{selected='',onSelect=()=>{}}={}) {
  const {height,branches}=networkLayout(plan),id='network-'+serial++;
  const box=document.createElement('div');box.className='transfer-network';box.style.height=height+'px';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 600 ${height}`);svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
  svg.innerHTML=`<defs><marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8" fill="#9ba991"/></marker></defs>`;
  for(const branch of branches){const origin=branch.kind==='origin',start=origin?[180,branch.y]:[380,height/2],end=origin?[220,height/2]:[420,branch.y];
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',`M${start} C${origin?205:405},${start[1]} ${origin?195:395},${end[1]} ${end}`);path.setAttribute('class','network-path '+(selected===`${branch.kind}:${branch.index}`?'selected':''));path.setAttribute('marker-end',`url(#${id})`);svg.append(path);
    const hit=path.cloneNode();hit.setAttribute('class','network-path-hit');hit.removeAttribute('marker-end');hit.onclick=()=>onSelect(branch.kind,branch.index);svg.append(hit);
  }
  box.append(svg);
  for(const branch of branches){const key=`${branch.kind}:${branch.index}`,b=document.createElement('button');b.type='button';b.className=`network-node ${branch.kind} ${key===selected?'selected':''}`;b.style.left=branch.x/6+'%';b.style.top=branch.y/height*100+'%';
    const routes=branch.entry.routes.filter(r=>r.selected),numbers=[...new Set(routes.map(r=>r.number))];
    b.title=`${branch.entry.stop.name} · ${branch.entry.stop.number}`;b.setAttribute('aria-label',`${branch.kind==='origin'?'출발':'도착'} ${branch.entry.stop.name} ${branch.entry.stop.number} 구간 선택`);
    b.innerHTML=`<span>${escape(branch.entry.stop.name)}</span><small>${numbers.length>2?escape(numbers[0])+' 외 '+(numbers.length-1)+'개':numbers.length?numbers.map(escape).join(' · '):'노선 선택'}</small>`;b.onclick=()=>onSelect(branch.kind,branch.index);box.append(b);
  }
  const hub=document.createElement('button');hub.type='button';hub.className='network-node hub';hub.style.left='50%';hub.style.top='50%';hub.innerHTML=`<small>환승지</small><span>${escape(plan.transfer?.name||'환승지 지정')}</span>`;hub.onclick=()=>onSelect('transfer',0);box.append(hub);
  for(const [kind,count,label,x]of [['origin',plan.origins.length,'출발지 추가',95],['destination',plan.destinations.length,'도착지 추가',505]])if(!count){const b=document.createElement('button');b.type='button';b.className='network-node empty';b.style.left=x/6+'%';b.style.top='50%';b.textContent='+ '+label;b.onclick=()=>onSelect('add-'+kind,0);box.append(b);}
  return box;
}
