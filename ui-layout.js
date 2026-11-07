// The map is its own layout cell. Padding must follow that cell, never the
// viewport or the height of a neighbouring planning panel.
export function mapPadding({width=0,height=0}={}){
  const inset=(size,ratio)=>Number.isFinite(size)&&size>0?Math.min(Math.floor(size/4),Math.round(Math.max(20,Math.min(70,size*ratio)))):0;
  const horizontal=inset(width,.12),vertical=inset(height,.16);
  return {top:vertical,right:horizontal,bottom:vertical,left:horizontal};
}

export function observeMapContainer(element,resize,{Observer=globalThis.ResizeObserver,requestFrame=globalThis.requestAnimationFrame,cancelFrame=globalThis.cancelAnimationFrame,windowTarget=globalThis.window}={}){
  let frame=null,lastWidth=-1,lastHeight=-1,disposed=false;
  const measure=()=>{
    if(disposed)return;
    const {width,height}=element.getBoundingClientRect();
    if(width<=0||height<=0||width===lastWidth&&height===lastHeight)return;
    lastWidth=width;lastHeight=height;resize();
  };
  const schedule=()=>{if(disposed||frame!==null)return;frame=requestFrame(()=>{frame=null;measure();});};
  const observer=Observer?new Observer(schedule):null;
  if(observer)observer.observe(element);else windowTarget?.addEventListener('resize',schedule);
  schedule();
  return ()=>{disposed=true;observer?.disconnect();windowTarget?.removeEventListener('resize',schedule);if(frame!==null)cancelFrame(frame);};
}
