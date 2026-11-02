import {field as f} from './api.js';

const numberKey = value => String(value ?? '').trim().replace(/^0+(?=\d)/, '');
const nameKey = value => String(value ?? '').trim().replace(/\s+/g, ' ');
export const stopKey = stop => `${stop.number}:${stop.name}`;

export function routeStop(row) {
  return {name:f(row,'stopKname'), number:f(row,'stopId'), standardId:f(row,'stopStandardid'), nodeId:f(row,'bnodeId'), seq:f(row,'brsSeqno') === '' ? NaN : Number(f(row,'brsSeqno'))};
}
// Use already loaded positions only; never fan out into per-stop requests.
export function sectionAnchors(routeStops,localStops,route) {
  return (routeStops||[]).filter(s=>s.seq>route.fromSeq&&s.seq<route.toSeq).sort((a,b)=>a.seq-b.seq).flatMap(s=>{
    const matches=localStops.filter(p=>matchesStop(p,s)&&Number.isFinite(p.lon)&&Number.isFinite(p.lat)&&p.lon>120&&p.lon<135&&p.lat>30&&p.lat<40&&(!p.standardId||!s.standardId||p.standardId===s.standardId));
    const positions=new Map(matches.map(p=>[`${p.lon}:${p.lat}`,p]));
    return positions.size===1?[{...positions.values().next().value,seq:s.seq}]:[];
  });
}
export function matchesStop(point, stop) {
  // File stop numbers are never used as standard IDs. Match both the public
  // number and name against the route's stop service ID; no fuzzy name joins.
  return Boolean(point?.number && point?.name && stop?.number && stop?.name)
    && numberKey(point.number) === numberKey(stop.number) && nameKey(point.name) === nameKey(stop.name);
}
export function findDirectRoutes(routes, from, to) {
  if (!from || !to || stopKey(from) === stopKey(to)) return [];
  return routes.flatMap(route => {
    const stops = [...route.stops].filter(s => Number.isFinite(s.seq)).sort((a,b) => a.seq-b.seq);
    let best;
    for (const start of stops.filter(s => matchesStop(from,s))) {
      const end = stops.find(s => s.seq > start.seq && matchesStop(to,s));
      if (end && (!best || end.seq-start.seq < best.stopCount)) {
        best = {routeId:route.id, number:route.number, direction:route.direction, destination:route.destination,
          fromStandardId:start.standardId, toStandardId:end.standardId, fromSeq:start.seq, toSeq:end.seq,
          stopCount:end.seq-start.seq};
      }
    }
    return best ? [best] : [];
  }).sort((a,b) => a.stopCount-b.stopCount || a.number.localeCompare(b.number,'ko',{numeric:true}));
}
export function journeyLegs(points) {
  if (!points.from || !points.to) throw new Error('출발과 도착 정류장을 골라 주세요.');
  const selected = [points.from, points.via, points.to].filter(Boolean);
  if (new Set(selected.map(stopKey)).size !== selected.length) throw new Error('출발·환승·도착은 서로 다른 정류장으로 골라 주세요.');
  return selected.slice(0,-1).map((from,i) => ({from,to:selected[i+1]}));
}

export const SAVED_KEY = 'busmap.journeys.v1';
function validPoint(p) {
  return p && typeof p.name === 'string' && typeof p.number === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > 30 && p.lat < 40 && p.lon > 120 && p.lon < 135;
}
export function validJourney(j) {
  const count = j?.points?.via ? 2 : 1;
  return j && typeof j.id === 'string' && typeof j.name === 'string' && validPoint(j.points?.from) && validPoint(j.points?.to)
    && (!j.points.via || validPoint(j.points.via)) && Array.isArray(j.routes) && j.routes.length === count
    && j.routes.every(r => r && typeof r.routeId === 'string' && typeof r.number === 'string' && Number.isFinite(r.fromSeq) && Number.isFinite(r.toSeq) && r.fromSeq < r.toSeq);
}
export function readJourneys(storage) {
  try {
    const value = JSON.parse(storage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(value) ? value.filter(validJourney).slice(0,100) : [];
  } catch { return []; }
}
export function saveJourney(storage, journey) {
  if (!validJourney(journey)) throw new Error('선택한 정류장과 각 구간의 노선을 확인해 주세요.');
  const saved = readJourneys(storage);
  if (saved.length >= 100) throw new Error('경로는 100개까지 저장할 수 있습니다. 사용하지 않는 경로를 지워 주세요.');
  // Copy only public journey data. API credentials cannot enter saved records.
  const point = p => p ? {name:p.name,number:p.number,lat:p.lat,lon:p.lon} : null;
  const record = {id:journey.id,name:journey.name,points:{from:point(journey.points.from),via:point(journey.points.via),to:point(journey.points.to)},routes:journey.routes.map(r => ({routeId:r.routeId,number:r.number,direction:r.direction || '',destination:r.destination || '',fromSeq:r.fromSeq,toSeq:r.toSeq,stopCount:r.stopCount,fromStandardId:r.fromStandardId || '',toStandardId:r.toStandardId || ''}))};
  storage.setItem(SAVED_KEY, JSON.stringify([record,...saved]));
  return record;
}
