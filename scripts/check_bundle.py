"""Check that the static bundle is complete and deployable under a subpath."""
import hashlib
import json
import struct
from pathlib import Path
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / 'catalog.json').read_text())
assert len(catalog['instruments']) == 7
assert sum(len(x['tasks']) for x in catalog['instruments']) == 18
for item in catalog['instruments']:
    for key in ('glb', 'preview', 'render', 'detail_render', 'physics', 'metadata'):
        assert item[key].startswith('./'), (item['id'], key)
        assert (ROOT/urlsplit(item[key]).path).is_file(), (item['id'], key)
    xml = ET.parse(ROOT/urlsplit(item['physics']).path).getroot()
    assert xml.find('compiler').get('inertiafromgeom') == 'false'
    assert float(xml.find('option').get('timestep')) == .001
    assert not list(xml.iter('mesh'))
    assert all('mesh' not in g.attrib for g in xml.iter('geom'))
    data = (ROOT/urlsplit(item['glb']).path).read_bytes()
    assert data[:4] == b'glTF'
    gltf = json.loads(data[20:20 + struct.unpack_from('<I', data, 12)[0]])
    finished = {i for i, material in enumerate(gltf['materials'])
                if material.get('extras', {}).get('realism3_version')}
    assert finished, (item['id'], 'portable surface finishes missing')
    for mesh in gltf['meshes']:
        for primitive in mesh['primitives']:
            if primitive.get('material') not in finished:
                continue
            material = gltf['materials'][primitive['material']]
            pbr = material['pbrMetallicRoughness']
            # Check the actual exported maps and the UV set used by each draw.
            for texture in (pbr['baseColorTexture'], pbr['metallicRoughnessTexture'], material['normalTexture']):
                uv = texture.get('extensions', {}).get('KHR_texture_transform', {}).get('texCoord', texture.get('texCoord', 0))
                assert 'TEXCOORD_' + str(uv) in primitive['attributes'], (item['id'], material['name'], uv)
                image = gltf['images'][gltf['textures'][texture['index']]['source']]
                assert 'bufferView' in image and 'uri' not in image, (item['id'], 'external texture')
            assert not material['extras'].get('realism3_map_metadata', '').startswith('/'), item['id']
for name in ('index.html', 'app.js', 'runtime.js', 'worker.js', 'physics.js', 'flexible-details.js'):
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
