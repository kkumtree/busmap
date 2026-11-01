import {mkdir, copyFile} from 'node:fs/promises';
const root = new URL('../',import.meta.url);
await mkdir(new URL('vendor/',root), {recursive:true});
for (const name of ['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css']) {
  await copyFile(new URL('node_modules/maplibre-gl/dist/'+name,root),new URL('vendor/'+name,root));
}
await copyFile(new URL('node_modules/maplibre-gl/LICENSE.txt',root),new URL('vendor/maplibre-LICENSE.txt',root));
