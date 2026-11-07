export const SOURCES = Object.freeze({
  routes: 'https://apis.data.go.kr/4641000/nosun',
  busstop: 'https://apis.data.go.kr/4641000/busstop',
  realtime: 'https://apis.data.go.kr/4641000/realtime',
  transfer: 'https://apis.data.go.kr/4641000/transfer',
  stops: 'https://api.odcloud.kr/api',
});

export function decodeKey(value) {
  const key = String(value ?? '').trim();
  try { return decodeURIComponent(key); } catch { return key; }
}

export const STOP_SPEC_URL = 'https://infuser.odcloud.kr/oas/docs?namespace=15080859/v1';

export function latestStopDataset(spec) {
  const versions = Object.entries(spec.paths ?? {}).flatMap(([path, value]) => {
    if (!/^\/15080859\/v1\/uddi:[a-f0-9-]+$/i.test(path) || !value.get) return [];
    const title = value.get.summary || value.get.description || '';
    const date = title.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})(?!\d)/);
    return date ? [{path, title, date: `${date[1]}-${date[2]}-${date[3]}`} ] : [];
  });
  versions.sort((a,b) => b.date.localeCompare(a.date));
  if (!versions.length) throw new Error('정류장 명세에서 날짜가 있는 최신 데이터를 찾지 못했습니다.');
  return versions[0];
}

export function buildURL(source, operation, params, key) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error('지원하지 않는 데이터입니다.');
  if (!key) throw new Error('API 연결 설정에서 인증키를 입력하세요.');
  if (source === 'stops' && !/^\/15080859\/v1\/uddi:[a-f0-9-]+$/i.test(operation)) throw new Error('정류장 데이터 경로가 올바르지 않습니다.');
  const url = new URL(SOURCES[source] + (source === 'stops' ? operation : '/' + operation));
  for (const [name, value] of Object.entries(params)) {
    if (value !== '' && value != null) url.searchParams.set(name, value);
  }
  url.searchParams.set('serviceKey', decodeKey(key));
  return url;
}

export const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
export function field(record, name) {
  const key = Object.keys(record ?? {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key == null ? '' : String(record[key] ?? '').trim();
}

// Both the gateway and provider can report errors inside an HTTP 200 response.
export function parsePayload(text, Parser = globalThis.DOMParser) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const doc = new Parser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('API의 XML 응답을 해석하지 못했습니다.');
  function object(node) {
    const children = Array.from(node.childNodes).filter(n => n.nodeType === 1);
    if (!children.length) return node.textContent.trim();
    const result = {};
    for (const child of children) {
      const name = child.localName || child.nodeName;
      const value = object(child);
      if (Object.hasOwn(result, name)) result[name] = [...asArray(result[name]), value];
      else result[name] = value;
    }
    return result;
  }
  return object(doc.documentElement);
}

export function unpack(payload) {
  const root = payload.response ?? payload;
  const header = root.cmmMsgHeader ?? root.header ?? root;
  const code = field(header, 'returnReasonCode') || field(header, 'resultCode') || field(header, 'code');
  if (code && !/^(0+|200|INFO-000)$/.test(code)) {
    throw new Error(field(header, 'returnAuthMsg') || field(header, 'resultMsg') || field(header, 'msg') || field(header, 'errMsg') || `API 오류 ${code}`);
  }
  if (root.data != null) return asArray(root.data);
  const body = root.body ?? root;
  const list = body.routeList?.list ?? body.items?.item;
  if (list == null || list === '') {
    if (code || Object.hasOwn(body, 'routeList') || Object.hasOwn(body, 'items')) return [];
    throw new Error('API 응답에서 결과 코드나 목록을 찾지 못했습니다.');
  }
  return asArray(list).filter(row => row && typeof row === 'object');
}

export function normalizeStop(row) {
  const stop={name: field(row, '정류장명'), number: field(row, '정류장번호'), lat: Number(field(row, '위도')), lon: Number(field(row, '경도'))};
  const direction=field(row,'방면')||field(row,'방향');
  const address=field(row,'도로명주소')||field(row,'주소');
  if(direction)stop.direction=direction;
  if(address)stop.address=address;
  return stop;
}

export function arrivalTime(value) {
  if (value === '' || value == null) return '시간 미제공';
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '시간 미제공';
  if (seconds <= 60) return '곧 도착';
  return `약 ${Math.ceil(seconds / 60)}분`;
}

export function arrivalEstimate(row) {
  const stops = field(row, 'RStop');
  const time = arrivalTime(field(row, 'RTime'));
  return /^\d+$/.test(stops) ? `${time} · ${Number(stops)}정류장 남음` : time;
}

export class ApiRequestError extends Error {
  constructor(message,source=null,unavailable=false){
    super(message);this.source=source;this.unavailable=unavailable;
  }
}

export function createClient(getKey, {onRequest=()=>{}}={}) {
  let controller = new AbortController();
  const outages=new Map();
  function failure(message,source,operation,unavailable){
    const error=new ApiRequestError(message,source,unavailable);
    if(unavailable)outages.set(source+':'+operation,{until:Date.now()+60000,error});
    return error;
  }
  return {
    reset({keysChanged=false}={}) { controller.abort(); controller = new AbortController(); if(keysChanged)outages.clear(); },
    async get(source, operation = '', params = {}) {
      const key = getKey(source);
      const url = buildURL(source, operation, params, key);
      const recent=outages.get(source+':'+operation);
      if(recent?.until>Date.now())throw new ApiRequestError(recent.error.message+' (최근 장애로 1분간 이 기능의 재호출을 생략합니다.)',source,true);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      let response;
      try {
        onRequest(source);
        response = await fetch(url, {signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'});
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ApiRequestError(e.name === 'TimeoutError' ? '응답이 늦어지고 있습니다. 잠시 뒤 다시 조회하세요.' : 'API에 연결하지 못했습니다. 네트워크나 제공기관의 CORS 허용 상태를 확인하세요.',source,false);
      }
      let payload, rows;
      try {
        payload = parsePayload(await response.text());
        rows = unpack(payload);
      } catch (e) {
        // Never surface the request URL or credentials, including provider echoes.
        let message = e.message;
        for (const value of [key, decodeKey(key), encodeURIComponent(decodeKey(key))]) {
          if (value) message = message.split(value).join('[인증키]');
        }
        throw failure((response.ok ? '' : `HTTP ${response.status} · `) + message.slice(0, 240),source,operation,response.status===503||field((payload?.response??payload)?.cmmMsgHeader,"returnReasonCode")==="05");
      }
      if (!response.ok) throw failure(`조회에 실패했습니다 (HTTP ${response.status}).`,source,operation,response.status===503);
      return {rows, total: Number(payload.totalCount ?? rows.length)};
    },
  };
}
