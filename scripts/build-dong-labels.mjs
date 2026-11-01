import fs from 'node:fs/promises';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
const style=JSON.parse(await fs.readFile('map-style.json','utf8'));
const names=new Set(['만성동','서신동','진북동','금암동','효자동1가','효자동2가','효자동3가','팔복동1가','팔복동2가','팔복동3가','팔복동4가','덕진동1가','덕진동2가','중동','장동','여의동','여의동2가','중화산동1가','중화산동2가']);
const features=new Map();
// Two small, already relevant map tiles; this script never calls bus APIs.
const tileJSON=process.argv[2]?JSON.parse(await fs.readFile(process.argv[2],'utf8')):await (await fetch('https://tiles.openfreemap.org/planet')).json();
for(const [lon,lat]of [[127.085,35.855],[127.13,35.832]]){
 const z=14,x=Math.floor((lon+180)/360*2**z),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**z);
 const response=await fetch(tileJSON.tiles[0].replace('{z}',z).replace('{x}',x).replace('{y}',y));if(!response.ok)throw new Error('Map tile download failed');
 const tile=new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer()))),layer=tile.layers.place;
 for(let i=0;i<(layer?.length||0);i++){
  const point=layer.feature(i),name=point.properties['name:ko']||point.properties.name;if(!names.has(name))continue;
  const geo=point.toGeoJSON(x,y,z),[a,b]=geo.geometry.coordinates;
  if(a<127.02||a>127.22||b<35.77||b>35.92)continue;
  features.set(name,{type:'Feature',properties:{name},geometry:geo.geometry});
 }
}
await fs.writeFile('data/dong-labels.geojson',JSON.stringify({type:'FeatureCollection',source:'OpenStreetMap contributors / OpenMapTiles via OpenFreeMap',license:'https://opendatacommons.org/licenses/odbl/1-0/',nameReference:'https://edu.jeonju.go.kr/index.9is?contentUid=9be517a74f8dee91014f9211968310c9',note:'Legal-dong name labels only; not administrative boundaries.',features:[...features.values()]})+'\n');
style.sources['dong-labels']={type:'geojson',data:'./data/dong-labels.geojson'};
const layer=style.layers.find(l=>l.id==='legal-dong-names');layer.source='dong-labels';delete layer['source-layer'];delete layer.filter;
await fs.writeFile('map-style.json',JSON.stringify(style)+'\n');console.log('Local legal-dong names:',[...features.keys()]);
