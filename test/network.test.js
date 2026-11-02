import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMImplementation} from '@xmldom/xmldom';
import {networkView} from '../network-view.js';
test('one origin and eight destinations remain independent rows around one transfer',()=>{
  const doc=new DOMImplementation().createDocument(null,'html',null),previous=globalThis.document;
  const create=doc.createElement.bind(doc);doc.createElement=name=>{const element=create(name);element.append=child=>element.appendChild(child);return element;};
  globalThis.document=doc;
  try{
    const entry=n=>({stop:{name:'정류장 '+n,number:String(n)},routes:[{number:'61',selected:true}]});
    const selected=[];const view=networkView({origins:[entry(1)],transfer:{name:'환승',number:'10'},destinations:Array.from({length:8},(_,i)=>entry(i+20))},{selected:'destination:7',onSelect:(...args)=>selected.push(args)});
    const buttons=Array.from(view.getElementsByTagName('button'));
    const destinations=buttons.filter(b=>b.getAttribute('aria-label')?.startsWith('도착 '));
    assert.equal(destinations.length,8);assert.equal(buttons.filter(b=>b.getAttribute('aria-label')==='환승지 환승 10').length,1);
    assert.equal(destinations[7].getAttribute('aria-pressed'),'true');destinations[7].onclick();assert.deepEqual(selected,[['destination',7]]);
    assert.equal(view.getAttribute('style'),null);assert.match(view.className,/itinerary/);
  }finally{globalThis.document=previous;}
});
