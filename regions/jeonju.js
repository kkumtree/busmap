// 전주 지역 설정. 다른 지역을 추가할 때는 이 파일을 복제해 값만 바꾸고
// regions/index.js 목록에 넣으면 상단 지역 탭에서 그대로 쓸 수 있습니다.
export default Object.freeze({
  id: 'jeonju',
  name: '전주',
  label: 'Jeonju',
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
