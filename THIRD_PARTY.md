# Third-party components

| Component | Version / source | License in this repository |
| --- | --- | --- |
| MuJoCo | Official `@mujoco/mujoco` 4.0.1, single-thread WebAssembly; https://github.com/google-deepmind/mujoco | [Apache 2.0](vendor/mujoco/LICENSE) |
| Three.js and addons | r160 (0.160.0) | [MIT](vendor/three/THREE-LICENSE.txt) |
| Pyodide | 0.28.3; https://github.com/pyodide/pyodide | [MPL 2.0](vendor/pyodide/LICENSE) |
| NumPy | 2.2.5, official Pyodide wheel | BSD license and bundled notices inside the distributed wheel |
| SciPy | 1.14.1, official Pyodide wheel | BSD license and bundled notices inside the distributed wheel |
| Pillow | 11.3.0, official Pyodide wheel | HPND license and bundled notices inside the distributed wheel |
| OpenBLAS | 0.3.26, official Pyodide archive | BSD license and bundled notices inside the distributed archive |
| CPython | Distributed by Pyodide 0.28.3 | Python Software Foundation license; see `vendor/pyodide/PYTHON-LICENSE.txt` |
| Studio Small 09 environment | Poly Haven, Greg Zaal; https://polyhaven.com/a/studio_small_09 | [CC0 and source](assets/lighting/LICENSE.txt) |
| Panda gripper geometry and inertials | MuJoCo Menagerie, pinned commit `eea4c7431b63da8278b0ff31638e0b0e941cec0e`; https://github.com/google-deepmind/mujoco_menagerie | [Apache 2.0](robotics/PANDA_LICENSE); [source fingerprints](robotics/PANDA_SOURCE.json) |

The package hashes for Pyodide's libraries are recorded in
`vendor/pyodide/pyodide-lock.json`. Dependencies are unmodified upstream distributions.
Third-party licenses apply to those components independently of the instrument
reconstructions. Product names identify the reference instruments; this project is
not an OEM CAD release or manufacturer-endorsed simulator.

MuJoCo dependency notices for libccd, Qhull, TinyXML-2 and LodePNG are also included
in `vendor/mujoco/*-LICENSE`.
