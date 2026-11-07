import test from 'node:test';
import assert from 'node:assert/strict';
import {mapPadding,observeMapContainer} from '../ui-layout.js';

test('camera padding keeps a usable centre in narrow and short map cells',()=>{
  for(const [width,height]of [[1200,800],[390,260],[320,160],[80,50]]){
    const p=mapPadding({width,height});
    assert.ok(p.left+p.right<=width/2);
    assert.ok(p.top+p.bottom<=height/2+1);
    assert.equal(p.left,p.right);assert.equal(p.top,p.bottom);
  }
  assert.deepEqual(mapPadding({width:390,height:260}),{top:42,right:47,bottom:42,left:47});
  assert.deepEqual(mapPadding({width:NaN,height:0}),{top:0,right:0,bottom:0,left:0});
});

test('map resizing follows container changes, coalesces events, and disposes cleanly',()=>{
  let notify,disconnected=false,size={width:390,height:260},resizes=0,next=0;
  const frames=new Map();
  class Observer{constructor(callback){notify=callback;}observe(){}disconnect(){disconnected=true;}}
  const dispose=observeMapContainer({getBoundingClientRect:()=>size},()=>resizes++,{
    Observer,requestFrame:callback=>{frames.set(++next,callback);return next;},cancelFrame:id=>frames.delete(id),windowTarget:null,
  });
  const flush=()=>{for(const [id,callback]of [...frames]){frames.delete(id);callback();}};
  notify();notify();assert.equal(frames.size,1);flush();assert.equal(resizes,1);
  notify();flush();assert.equal(resizes,1);
  size={width:390,height:540};notify();flush();assert.equal(resizes,2);
  size={width:0,height:0};notify();flush();assert.equal(resizes,2);
  size={width:850,height:540};notify();dispose();flush();assert.equal(resizes,2);assert.equal(disconnected,true);
});
