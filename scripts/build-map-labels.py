"""Build local label assets from an OSM API extract; never runs in the browser."""
import json,sys,xml.etree.ElementTree as ET
from pathlib import Path
root=ET.parse(sys.argv[1]).getroot()
nodes={n.get('id'):[float(n.get('lon')),float(n.get('lat'))] for n in root.findall('node')}
features=[]
for w in root.findall('way'):
    tags={t.get('k'):t.get('v') for t in w.findall('tag')}
    if tags.get('landuse')!='residential' or not tags.get('name'):continue
    ring=[nodes[n.get('ref')] for n in w.findall('nd') if n.get('ref') in nodes]
    if len(ring)<4 or ring[0]!=ring[-1]:continue
    twice_area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:]))
    if abs(twice_area)<1e-12:continue
    x=sum((a[0]+b[0])*(a[0]*b[1]-b[0]*a[1]) for a,b in zip(ring,ring[1:]))/(3*twice_area)
    y=sum((a[1]+b[1])*(a[0]*b[1]-b[0]*a[1]) for a,b in zip(ring,ring[1:]))/(3*twice_area)
    features.append({'type':'Feature','geometry':{'type':'Point','coordinates':[round(x,7),round(y,7)]},'properties':{'name':tags.get('name:ko') or tags['name'],'osmId':'way/'+w.get('id')}})
output={'type':'FeatureCollection','source':'OpenStreetMap contributors, ODbL','retrievedAt':'2026-11-01','coverage':[127.055,35.825,127.115,35.865],'features':features}
Path('data/apartment-labels.geojson').write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n')
style=json.loads(Path('map-style.json').read_text())
style['glyphs']='https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'
style['sources']['apartment-labels']={'type':'geojson','data':'./data/apartment-labels.geojson'}
style['layers']=[l for l in style['layers'] if l['id'] not in ['legal-dong-names','apartment-names']]
names=['만성동','서신동','진북동','금암동','효자동1가','효자동2가','효자동3가','팔복동1가','팔복동2가','팔복동3가','팔복동4가','덕진동1가','덕진동2가','중동','장동','여의동','여의동2가','중화산동1가','중화산동2가']
style['layers'].append({'id':'legal-dong-names','type':'symbol','source':'openmaptiles','source-layer':'place','minzoom':11,'filter':['all',['in',['coalesce',['get','name:ko'],['get','name']],['literal',names]],['within',{'type':'Polygon','coordinates':[[[127.02,35.77],[127.22,35.77],[127.22,35.92],[127.02,35.92],[127.02,35.77]]]}]],'layout':{'text-field':['coalesce',['get','name:ko'],['get','name']],'text-font':['Noto Sans Regular'],'text-size':['interpolate',['linear'],['zoom'],11,12,15,16],'text-max-width':9,'text-padding':12},'paint':{'text-color':'#747b75','text-halo-color':'#ffffff','text-halo-width':2}})
style['layers'].append({'id':'apartment-names','type':'symbol','source':'apartment-labels','minzoom':14,'layout':{'text-field':['get','name'],'text-font':['Noto Sans Regular'],'text-size':['interpolate',['linear'],['zoom'],14,10,17,12],'text-max-width':8,'text-padding':5},'paint':{'text-color':'#687361','text-halo-color':'#ffffff','text-halo-width':1.7}})
if Path('data/dong-labels.geojson').exists():
    style['sources']['dong-labels']={'type':'geojson','data':'./data/dong-labels.geojson'}
    layer=next(l for l in style['layers'] if l['id']=='legal-dong-names')
    layer['source']='dong-labels'
    layer.pop('source-layer',None)
    layer.pop('filter',None)
Path('map-style.json').write_text(json.dumps(style,ensure_ascii=False,separators=(',',':'))+'\n')
print('Local apartment/residential-complex labels:',len(features))
