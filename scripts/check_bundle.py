"""Check that the static bundle is complete and deployable under a subpath."""
import hashlib
import json
import math
import re
import struct
import tarfile
from pathlib import Path
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def bundled_file(folder, name):
    """Resolve a manifest/import reference without allowing host paths."""
    parsed = urlsplit(name)
    path = Path(parsed.path)
    assert not parsed.scheme and not parsed.netloc, name
    assert not path.is_absolute() and '..' not in path.parts and '\\' not in name, name
    target = (folder/path).resolve()
    assert target.is_relative_to(ROOT.resolve()) and target.is_file(), name
    return target


catalog = json.loads((ROOT / 'catalog.json').read_text())
assert len(catalog['instruments']) == 7
assert sum(len(x['tasks']) for x in catalog['instruments']) == 18
for item in catalog['instruments']:
    for key in ('glb', 'preview', 'render', 'detail_render', 'physics', 'metadata', 'collision'):
        assert item[key].startswith('./'), (item['id'], key)
        assert (ROOT/urlsplit(item[key]).path).is_file(), (item['id'], key)
    xml = ET.parse(ROOT/urlsplit(item['physics']).path).getroot()
    assert xml.find('compiler').get('inertiafromgeom') == 'false'
    assert float(xml.find('option').get('timestep')) == .001
    assert not list(xml.iter('mesh'))
    assert all('mesh' not in g.attrib for g in xml.iter('geom'))
    contact = json.loads((ROOT/urlsplit(item['collision']).path).read_text())
    assert contact['physics_sha256'] == hashlib.sha256((ROOT/urlsplit(item['physics']).path).read_bytes()).hexdigest()
    assert contact['shapes'] and contact['bodies'], item['id']
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
runtime_files = ('index.html', 'app.js', 'runtime.js', 'worker.js', 'physics.js',
                 'flexible-details.js', 'contact-overlay.js', 'studio-renderer.js',
                 'progressive-renderer.js', 'area-shadows.js', 'cavity-lighting.js',
                 'screen-reflections.js', 'color-grade.js', 'scene-reflections.js',
                 'planar-reflections.js', 'objective-reflections.js', 'env-axis.js')
for name in runtime_files:
    text = (ROOT/name).read_text()
    assert '/api/' not in text, name
    assert '/sdf/' not in text, name
    assert '/cvmfs/' not in text, name
    assert '="/' not in text, name
    if name.endswith('.js'):
        imports = re.findall(r'\bfrom\s*[\'\"]([^\'\"]+)[\'\"]', text)
        imports += re.findall(r'\bimport\s*(?:\(\s*)?[\'\"]([^\'\"]+)[\'\"]', text)
        for specifier in imports:
            if specifier == 'three':
                assert './vendor/three/three.module.min.js' in (ROOT/'index.html').read_text()
            else:
                assert specifier.startswith('./'), (name, specifier)
                bundled_file((ROOT/name).parent, specifier)

grade_dir = ROOT/'assets/color-grade'
grade = json.loads((grade_dir/'manifest.json').read_text())
assert grade['version'] == 1 and grade['blender'] == '4.2.8' and grade['ocio'] == '2.3.2'
assert grade['input'] == 'scene-linear Rec.709' and grade['output'] == 'display-encoded sRGB'
assert grade['display'] == 'sRGB' and grade['view'] == 'AgX'
assert grade['look'] == 'AgX - Medium High Contrast' and grade['exposureEV'] == -.15
assert re.fullmatch(r'[a-f0-9]{64}', grade['configSHA256'])
assert grade['source'].startswith('https://github.com/blender/blender/')
assert len(grade['textures']) == 2
for record in [grade['shader'], *grade['textures']]:
    data = bundled_file(grade_dir, record['file']).read_bytes()
    assert len(data) == record['bytes'], record['file']
    assert hashlib.sha256(data).hexdigest() == record['sha256'], record['file']
shader = (grade_dir/grade['shader']['file']).read_text()
assert 'labBlenderAgX' in shader
for record in grade['textures']:
    assert record['dtype'] == 'float32-le' and record['channels'] == 3
    assert record['interpolation'] == 'nearest'
    assert isinstance(record['edge'], int) and record['edge'] > 1
    assert record['bytes'] == record['edge']**3 * record['channels'] * 4
    assert record['sampler'] in shader, record['sampler']
    assert all(math.isfinite(value[0]) for value in struct.iter_unpack('<f',
               (grade_dir/record['file']).read_bytes())), record['file']
for notice in ('NOTICE.txt', 'OpenColorIO-LICENSE.txt', 'Blender-OpenColorIO-LICENSE.txt'):
    assert bundled_file(grade_dir, notice).stat().st_size > 300
assert 'Redistribution and use in source and binary forms' in (grade_dir/'OpenColorIO-LICENSE.txt').read_text()
assert 'color-grade' in (ROOT/'THIRD_PARTY.md').read_text()
photo_vendor = ROOT/'vendor/pathtracer'
photo_manifest = json.loads((photo_vendor/'manifest.json').read_text())
assert photo_manifest['packages'] == {'three-gpu-pathtracer': '0.0.23', 'three-mesh-bvh': '0.7.4'}
for item in photo_manifest['files']:
    assert '..' not in Path(item['file']).parts and not Path(item['file']).is_absolute()
    assert hashlib.sha256((photo_vendor/item['file']).read_bytes()).hexdigest() == item['sha256'], item['file']
for license_name in ('three-gpu-pathtracer-LICENSE.txt', 'three-mesh-bvh-LICENSE.txt'):
    assert 'MIT' in (photo_vendor/license_name).read_text()
assert (ROOT/'vendor/three/RectAreaLightUniformsLib.js').is_file()
lock = json.loads((ROOT/'vendor/pyodide/pyodide-lock.json').read_text())
for name in ('numpy', 'scipy', 'pillow', 'libopenblas'):
    pkg = lock['packages'][name]
    data = (ROOT/'vendor/pyodide'/pkg['file_name']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == pkg['sha256'], name
robot = ROOT/'robotics'
manifest = json.loads((robot/'manifest.json').read_text())
for name, record in manifest['files'].items():
    assert not Path(name).is_absolute() and '..' not in Path(name).parts, name
    data = (robot/name).read_bytes()
    assert len(data) == record['bytes'] and hashlib.sha256(data).hexdigest() == record['sha256'], name
with tarfile.open(robot/'portable.tar.gz') as archive:
    for name in ('physics.xml', 'metadata.json'):
        data = archive.extractfile('transfer-gripper-benchmark/assets/transfer/'+name).read()
        assert data == (ROOT/'assets/transfer'/name).read_bytes(), 'Stale robot instrument: '+name
assert json.loads((robot/'validation/summary.json').read_text())['passed']
assert json.loads((robot/'validation/portable_verification.json').read_text())['all_metrics_identical']
for path in ROOT.rglob('*'):
    if path.is_file() and '.git' not in path.parts:
        assert path.stat().st_size < 100*1024*1024, path
print('Complete static bundle: seven models, 18 fixture tasks, native contact-gripper package, portable scene-reflection imports, verified display LUTs and dependency notices.')
