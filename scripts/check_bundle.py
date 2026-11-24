"""Check that the static bundle is complete and deployable under a subpath."""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / 'catalog.json').read_text())
assert len(catalog['instruments']) == 7
assert sum(len(x['tasks']) for x in catalog['instruments']) == 18
for item in catalog['instruments']:
    for key in ('glb', 'preview', 'render', 'detail_render', 'physics', 'metadata'):
        assert item[key].startswith('./'), (item['id'], key)
        assert (ROOT/item[key]).is_file(), (item['id'], key)
    xml = ET.parse(ROOT/item['physics']).getroot()
    assert xml.find('compiler').get('inertiafromgeom') == 'false'
    assert float(xml.find('option').get('timestep')) == .001
    assert not list(xml.iter('mesh'))
    assert all('mesh' not in g.attrib for g in xml.iter('geom'))
    assert (ROOT/item['glb']).read_bytes()[:4] == b'glTF'
for name in ('index.html', 'app.js', 'runtime.js', 'worker.js', 'physics.js'):
    text = (ROOT/name).read_text()
    assert '/api/' not in text, name
    assert '/sdf/' not in text, name
    assert '="/' not in text, name
lock = json.loads((ROOT/'vendor/pyodide/pyodide-lock.json').read_text())
for name in ('numpy', 'scipy', 'pillow', 'libopenblas'):
    pkg = lock['packages'][name]
    data = (ROOT/'vendor/pyodide'/pkg['file_name']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == pkg['sha256'], name
for path in ROOT.rglob('*'):
    if path.is_file() and '.git' not in path.parts:
        assert path.stat().st_size < 100*1024*1024, path
print('Complete static bundle: seven models, 18 tasks, relative URLs, verified Python libraries.')
