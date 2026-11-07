// 전주 지역 설정. 다른 지역을 추가할 때는 이 파일을 복제해 값만 바꾸고
// regions/index.js 목록에 넣으면 상단 지역 탭에서 그대로 쓸 수 있습니다.
export default Object.freeze({
  id: 'jeonju',
  name: '전주',
  label: 'Jeonju',
  // Public route IDs previously observed for these legs. Never offer a route
  // based on a hint alone: the current stop sequence must confirm it.
  routeHints: {
    '30887:30920': [['305001119','61']],
    '30927:30920': [['305001423','200']],
    '30920:36347': [['305001089','101']],
    '30920:36351': [['305001609','74'],['305001493','75']],
  },
  // Official stop list coordinates paired with IDs observed in both 74 and 75 sequences.
  platforms: [
    {number:'30920', standardId:'305100920', lat:35.834017, lon:127.111001},
    {number:'36351', standardId:'305032417', lat:35.844878, lon:127.077473},
  ],
  // 지도 초기 시점
  center: Object.freeze([127.135, 35.825]),
  zoom: 12.3,
  // 이 지역으로 취급할 좌표 범위(경계 상자). 정류장 좌표 검증에 씁니다.
  bounds: Object.freeze({south: 35.70, north: 35.95, west: 126.95, east: 127.25}),
  // 배경지도 스타일과 이름 라벨 데이터
  mapStyle: './map-style.json',
  labels: Object.freeze({
    dong: './data/dong-labels.geojson',
  }),
  // 데이터 출처 표기
  source: '전주시',
  mapAriaLabel: '전주시 정류장 지도',
});
