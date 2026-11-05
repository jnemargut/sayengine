"""Cut the small offline test fixture (packages/core/test/fixtures/world/raleigh-mini) out of a fetched
area cache: one block corner around Fayetteville St and Martin St, Raleigh. Run after
`studio world-fetch --name raleigh-city-plaza --bbox=-78.6413,35.7737,-78.6374,35.7788`:

    python3 -I bench/world-fixture.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '.studio', 'cache', 'world', 'raleigh-city-plaza')
DST = os.path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'world', 'raleigh-mini')
W, S, E, N = -78.6402, 35.7760, -78.6380, 35.7778

os.makedirs(DST, exist_ok=True)
inside = lambda lon, lat: W <= lon <= E and S <= lat <= N

b = json.load(open(os.path.join(SRC, 'buildings.geojson')))
keep = []
for f in b['features']:
    ring = (f['geometry']['coordinates'][0] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates'][0][0])
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    if inside(lon, lat):
        props = {k: f['properties'].get(k) for k in ('names', 'height', 'num_floors', 'roof_shape', 'subtype', 'class', 'is_underground')}
        props['sources'] = [{k: s.get(k) for k in ('dataset', 'license')} for s in f['properties'].get('sources', [])]
        keep.append({'type': 'Feature', 'id': f['id'], 'geometry': f['geometry'], 'properties': props})
json.dump({'type': 'FeatureCollection', 'features': keep}, open(os.path.join(DST, 'buildings.geojson'), 'w'))

o = json.load(open(os.path.join(SRC, 'osm.json')))
ways = [e for e in o['elements'] if any(inside(g['lon'], g['lat']) for g in e.get('geometry', []))]
for e in ways:
    e.pop('nodes', None)
    e['tags'] = {k: v for k, v in e['tags'].items() if not k.startswith('tiger:')}
json.dump({'elements': ways}, open(os.path.join(DST, 'osm.json'), 'w'))

d = json.load(open(os.path.join(SRC, 'dem.json')))
bb = d['bbox']
nx, nz = 17, 17
heights = []
for j in range(nz):
    lat = N - (N - S) * j / (nz - 1)
    for i in range(nx):
        lon = W + (E - W) * i / (nx - 1)
        fx = (lon - bb['west']) / (bb['east'] - bb['west']) * (d['nx'] - 1)
        fz = (bb['north'] - lat) / (bb['north'] - bb['south']) * (d['nz'] - 1)
        i0, j0 = int(fx), int(fz)
        u, v = fx - i0, fz - j0
        h = lambda a, c: d['heights'][min(c, d['nz'] - 1) * d['nx'] + min(a, d['nx'] - 1)]
        heights.append(round(h(i0, j0) * (1 - u) * (1 - v) + h(i0 + 1, j0) * u * (1 - v) + h(i0, j0 + 1) * (1 - u) * v + h(i0 + 1, j0 + 1) * u * v, 2))
json.dump({'nx': nx, 'nz': nz, 'bbox': {'west': W, 'south': S, 'east': E, 'north': N}, 'heights': heights}, open(os.path.join(DST, 'dem.json'), 'w'))
json.dump({'area': 'raleigh-mini', 'bbox': {'west': W, 'south': S, 'east': E, 'north': N}, 'fetchedAt': '2026-11-05T10:03:54.606Z', 'note': 'test fixture cut from raleigh-city-plaza (bench/world-fixture.py)', 'licences': ['Overture: ODbL-1.0', 'OpenStreetMap: ODbL-1.0', 'USGS 3DEP: public domain']}, open(os.path.join(DST, 'meta.json'), 'w'), indent=1)
print(len(keep), 'buildings', len(ways), 'ways')
