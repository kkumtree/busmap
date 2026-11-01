import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const [directory,version]=process.argv.slice(2);
if(!directory||!/^[a-f0-9]{7,40}$/.test(version||''))throw new Error('Static directory and commit SHA are required.');
async function stamp(dir){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory()){await stamp(path);continue;}
    if(!/\.(?:html|js|mjs|css)$/.test(entry.name)&&entry.name!=='map-style.json')continue;
    const text=await readFile(path,'utf8');
    const updated=text.replace(/(['"])(\.\/[^'"\s]+\.(?:js|mjs|css|json|geojson))\1/g,(_,quote,path)=>`${quote}${path}?v=${version}${quote}`);
    if(updated!==text)await writeFile(path,updated);
  }
}
await stamp(resolve(directory));
