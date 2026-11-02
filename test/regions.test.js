import test from 'node:test';
import assert from 'node:assert/strict';
import {REGIONS, DEFAULT_REGION_ID, regionById, inRegion, applyRegion} from '../regions/index.js';

test('regions have unique ids, a default, and a usable map view', () => {
  assert.ok(REGIONS.length >= 1);
  assert.equal(new Set(REGIONS.map(r => r.id)).size, REGIONS.length);
  const region = regionById(DEFAULT_REGION_ID);
  assert.equal(region.id, DEFAULT_REGION_ID);
  assert.equal(region.name, '전주');
  assert.equal(region.center.length, 2);
  for (const value of region.center) assert.ok(Number.isFinite(value));
  assert.ok(region.zoom > 8 && region.zoom < 18);
  assert.match(region.mapStyle, /^\.\//);
});

test('an unknown region id falls back to the default region', () => {
  assert.equal(regionById('nowhere').id, DEFAULT_REGION_ID);
  assert.equal(regionById(undefined).id, DEFAULT_REGION_ID);
});

test('bounds accept in-region stops and reject points outside them', () => {
  const region = regionById('jeonju');
  const {south, north, west, east} = region.bounds;
  assert.ok(south < north && west < east);
  assert.equal(inRegion(region, {lat: 35.834, lon: 127.111}), true);
  assert.equal(inRegion(region, {lat: south, lon: west}), true);
  assert.equal(inRegion(region, {lat: 35.834, lon: 128.111}), false);
  assert.equal(inRegion(region, {lat: 37.5665, lon: 126.978}), false);
  assert.equal(inRegion(region, {lat: null, lon: null}), false);
  assert.equal(inRegion(null, {lat: 35.834, lon: 127.111}), false);
});

test('applyRegion fills region marked elements without touching anything else', () => {
  const region = regionById('jeonju');
  const writes = [];
  const fake = (name) => ({textContent: '', setAttribute: () => writes.push(name)});
  const named = [fake('name1'), fake('name2')];
  const doc = {
    title: '전주 버스맵 · 나의 환승지',
    querySelectorAll(selector) {
      if (selector === '[data-region-name]') return named;
      if (selector === '[data-region-label]') return [fake('label')];
      return [];
    },
    getElementById: () => ({setAttribute: (key, value) => writes.push(`${key}=${value}`)}),
  };
  applyRegion(doc, region);
  assert.deepEqual(named.map(el => el.textContent), ['전주', '전주']);
  assert.equal(doc.title, '전주 버스맵 · 나의 환승지');
  assert.deepEqual(writes, ['aria-label=전주시 정류장 지도']);
});
