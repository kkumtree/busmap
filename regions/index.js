import jeonju from './jeonju.js';

// 지역은 이 배열 순서대로 상단 탭에 놓입니다. 첫 항목이 기본 지역입니다.
export const REGIONS = Object.freeze([jeonju]);
export const DEFAULT_REGION_ID = REGIONS[0].id;

export function regionById(id) {
  return REGIONS.find(region => region.id === id) || REGIONS[0];
}

export function inRegion(region, point) {
  const {south, north, west, east} = region?.bounds ?? {};
  if (!point || ![south, north, west, east].every(Number.isFinite)) return false;
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    point.lat >= south && point.lat <= north && point.lon >= west && point.lon <= east;
}

// 지역 이름이 들어가는 자리를 한 번에 채웁니다(<span data-region-name> 등).
export function applyRegion(doc, region) {
  if (!doc || !region) return region;
  for (const el of doc.querySelectorAll('[data-region-name]')) el.textContent = region.name;
  for (const el of doc.querySelectorAll('[data-region-label]')) el.textContent = region.label;
  const map = doc.getElementById('map');
  if (map && region.mapAriaLabel) map.setAttribute('aria-label', region.mapAriaLabel);
  if (doc.title) doc.title = `${region.name} 버스맵 · 나의 환승지`;
  return region;
}
