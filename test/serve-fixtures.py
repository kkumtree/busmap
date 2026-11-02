"""Browser QA only: python3 test/serve-fixtures.py (fictional stops; no real key)."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json
import os
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from dev_server import PublicHandler, ASSETS
os.chdir(ROOT)
POINTS = [
    {"정류장명": "테스트 출발", "정류장번호": "001", "위도": "35.815", "경도": "127.115"},
    {"정류장명": "테스트 환승", "정류장번호": "002", "위도": "35.825", "경도": "127.135"},
    {"정류장명": "테스트 도착", "정류장번호": "003", "위도": "35.835", "경도": "127.155"},
]
ROUTES = {"101": [0, 1, 2], "202": [0, 1], "303": [1, 2], "404": [2, 1, 0]}
RETAINED = json.loads((ROOT / "test/fixtures/101-section.json").read_text()) if "--recorded-101" in sys.argv else None
if RETAINED:
    POINTS = [{"정류장명":p["name"],"정류장번호":p["number"],"위도":str(p["lat"]),"경도":str(p["lon"])} for p in [RETAINED["from"],*RETAINED["localStops"],RETAINED["to"]]]
    ROUTES = {RETAINED["route"]["routeId"]:list(range(len(POINTS)))}

class Handler(PublicHandler):
    def send(self, body, kind="application/json"):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)
        if path in ["/", "/index.html"]:
            body = (ROOT / "index.html").read_text().replace('src="app.js"','src="app.js?qa=section-v1"')
            return self.send(body,"text/html")
        if path == "/api.js":
            body = (ROOT / "api.js").read_text().replace("https://infuser.odcloud.kr/oas/docs?namespace=15080859/v1", "http://127.0.0.1:8001/spec")
            body = body.replace("https://apis.data.go.kr/4641000", "http://127.0.0.1:8001/gw").replace("https://api.odcloud.kr/api", "http://127.0.0.1:8001/api")
            return self.send(body, "text/javascript")
        if path == "/spec":
            return self.send((ROOT / "docs/15080859.json").read_text())
        if path.startswith("/api/15080859/"):
            points = POINTS
            if "384ac420" in path:
                points = [{**p, "정류장ID": "JUB" + str(100000001+i)} for i, p in enumerate(POINTS)]
            number = query.get("cond[정류장번호::EQ]", [None])[0]
            if number is not None:
                points = [p for p in points if p["정류장번호"] == number]
            return self.send(json.dumps({"totalCount": 3, "data": points}, ensure_ascii=False))
        if path == "/gw/busstop/bus_location2_stopno_common":
            number = query.get("searchNm", [""])[0]
            rows = [{"stopId":p["정류장번호"],"stopKname":p["정류장명"],"stopStandardid":str(100000001+i),"stopX":p["경도"],"stopY":p["위도"]} for i,p in enumerate(POINTS) if p["정류장번호"] == number]
            if RETAINED:
                for row in rows:
                    row["stopStandardid"] = next(s["standardId"] for s in RETAINED["stops"] if s["number"] == row["stopId"])
            return self.send(json.dumps({"code":"0","routeList":{"list":rows}}, ensure_ascii=False))
        if path == "/gw/busstop/general_busstop_common":
            if RETAINED:
                return self.send(json.dumps({"code":"0","routeList":{"list":[{"brtStdId":RETAINED["route"]["routeId"],"brtId":"101","brtSname":"평화동종점","brtEname":"전북대종점"}]}},ensure_ascii=False))
            number = int(query["stopStandardid"][0]) - 100000001
            rows = [{"brtStdId":r,"brtId":r,"brtSname":"테스트 시작","brtEname":"테스트 종점"} for r,seq in ROUTES.items() if number in seq]
            return self.send(json.dumps({"code":"0","routeList":{"list":rows}}, ensure_ascii=False))
        if path == "/gw/realtime/bus_location_low_busstop_infomation_common":
            number = int(query["stopStdid"][0]) - 100000001
            rows = [{"brtStdid": r, "brtId": r, "brtDirection": "1", "brtVianame": "테스트 종점"} for r, seq in ROUTES.items() if number in seq]
            return self.send(json.dumps({"code":"0", "routeList":{"list":rows}}, ensure_ascii=False))
        if path == "/gw/transfer/fromto_bus_search_transfer_detail_common":
            return self.send(json.dumps({"code":"0", "routeList":{"list":[]}}))
        if path == "/gw/transfer/bus_stop_drawing_common":
            if RETAINED:
                if any(query.get(k,[None])[0] != v for k,v in RETAINED["request"].items()):
                    return self.send(json.dumps({"code":"10","msg":"검증 구간과 다른 요청입니다."},ensure_ascii=False))
                rows = RETAINED["rows"]
            else:
                route = query.get("sStdId1", [""])[0]
                start = int(query["sStdId2"][0])-100000001
                end = int(query["sStdId3"][0])-100000001
                seq = ROUTES.get(route,[])
                section = seq[seq.index(start):seq.index(end)+1] if start in seq and end in seq else []
                rows = [{"linkId":"fixture","vtxSeq":str(i+1),"vtxx":POINTS[n]["경도"],"vtxy":POINTS[n]["위도"]} for i,n in enumerate(section)]
            return self.send(json.dumps({"code":"0","routeList":{"list":rows}},ensure_ascii=False))
        if path == "/gw/nosun/bus_location_all_common":
            rows = [{"brtStdid": r, "brtId": r, "brtDirection": "1", "brtEname": "테스트 종점"} for r in ROUTES]
            return self.send(json.dumps({"code": "0", "routeList": {"list": rows}}, ensure_ascii=False))
        if path == "/gw/nosun/bus_location1_common":
            route = query.get("brtId", [""])[0]
            rows = [{"brtStdid":route,"brtId":route,"brtSname":"테스트 시작","brtEname":"테스트 종점"}] if route in ROUTES else []
            return self.send(json.dumps({"code":"0","routeList":{"list":rows}}, ensure_ascii=False))
        if path == "/gw/nosun/bus_nosun_drawing_common":
            route = query.get("brtStdid", [""])[0]
            rows = [{"linkId":"fixture","vtxSeq":str(i+1),"vtxx":POINTS[n]["경도"],"vtxy":POINTS[n]["위도"]} for i,n in enumerate(ROUTES.get(route,[]))]
            return self.send(json.dumps({"code":"0","routeList":{"list":rows}}, ensure_ascii=False))
        if path == "/gw/nosun/bus_location_busstop_list_common":
            route = query.get("brtStdid", [""])[0]
            rows = [{"stopKname": POINTS[n]["정류장명"], "stopId": POINTS[n]["정류장번호"], "stopStandardid": str(100000001+n), "brsSeqno": str(i+1)} for i, n in enumerate(ROUTES[route])]
            if RETAINED:
                rows = [{"stopKname":s["name"],"stopId":s["number"],"stopStandardid":s["standardId"],"brsSeqno":str(s["seq"])} for s in RETAINED["stops"]]
            return self.send(json.dumps({"code": "0", "routeList": {"list": rows}}, ensure_ascii=False))
        if path.removeprefix("/") in ASSETS and path.endswith(".js"):
            body = (ROOT / path.removeprefix("/")).read_text()
            body = re.sub(r"(from\s+['\"]\./[^'\"]+\.js)(['\"])",r"\1?qa=section-v1\2",body)
            return self.send(body,"text/javascript")
        return super().do_GET()

print("Browser QA (fictional data): http://127.0.0.1:8001", flush=True)
ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
