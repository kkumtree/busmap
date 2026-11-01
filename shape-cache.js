export function shapeStore(indexedDB=globalThis.indexedDB) {
  const memory=new Map();let connection;
  const open=()=>connection??=new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('지도 선형의 로컬 저장을 사용할 수 없습니다.'));return;}
    const request=indexedDB.open('busmap-shapes',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('routes');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('지도 선형 저장소를 열지 못했습니다.'));
  });
  return {
    async get(id){if(memory.has(id))return memory.get(id);try{const db=await open();return await new Promise((resolve,reject)=>{const r=db.transaction('routes').objectStore('routes').get(id);r.onsuccess=()=>{if(r.result)memory.set(id,r.result);resolve(r.result);};r.onerror=()=>reject(r.error);});}catch{return undefined;}},
    async put(id,value){memory.set(id,value);const db=await open();await new Promise((resolve,reject)=>{const tx=db.transaction('routes','readwrite');tx.objectStore('routes').put(value,id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('지도 선형을 로컬에 저장하지 못했습니다.'));});},
  };
}
