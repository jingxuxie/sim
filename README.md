# Quantum Lab instruments

**Open the lab: https://jingxuxie.com/sim/**

Hosted by GitHub Pages from [jingxuxie/sim](https://github.com/jingxuxie/sim).
The GitHub account’s existing custom domain supplies the public address.

Seven detailed laboratory instruments with **live MuJoCo physics in your browser**.
No Python server, account, or VS Code port forwarding is needed. Each visitor has
their own simulation; this is not a shared remote desktop or a recorded animation.

## Use it

1. Choose an instrument. Its preview appears immediately while the 3D model and
   physics engine load. Drag to orbit, scroll to zoom, and Shift-drag to pan.
2. Move the manual controls, or choose a task and select **Run baseline**.
   **Start manual** initializes the same seeded challenge for you to operate.
3. **Pause / Resume** controls simulation time. **Reset** returns to free exploration.
4. For microscopes, select **Enable microscope image** and choose the camera or
   eyepiece port. Focus, objective seating and light routing affect the image.
5. **Rendered still / Rendered detail** shows the high-resolution Blender artwork.
   **Full instrument / Working area** returns to the live 3D view.

The gallery is lightweight and remains visible without JavaScript. Only the selected
instrument is downloaded (about 5–44 MB including geometry and textures). The runtime adds about 23 MB when you open an instrument; task policies and optical
imaging load another 20 MB on first use. These files are cached by the browser. Use a current desktop
Chrome or Edge with WebAssembly and WebGL enabled. Complex optics
and contacts can run slower than real time; the displayed clock is simulation time.

## Instruments and tasks

| Instrument | Live mechanisms and tasks |
| --- | --- |
| Nikon Eclipse E1000 | Geared XY knobs, coarse/fine focus, seven objective stations, camera/eye selector; centering, focusing, indexing and image-feedback tasks |
| Dry-transfer station | Sample and stamp positioning, upright working objective, focus and optical selector; alignment and contact/retraction |
| Manual probe station | Chuck, two probe manipulators and microscope; pad alignment and measured two-tip contact/retraction |
| Zeiss upright | XY stage and connected controls, focus, objective turret and light routing; centering and focusing |
| West·Bond wire bonder | Separate hand lever and wedge head with 8:1 motion coupling; alignment and two-pad contact sequence |
| Asylum Cypher S | Enclosure release, door, scanner release and drawer with interlocks; access and complete open/close cycle |
| Spring tweezers | Two compliant jaws and a moving fixture; contact-based chip grasp, lift and tray placement |

The 18 baselines are instrument-level fixture controllers, not learned robot policies.
Success uses measured joint state, sites, contacts, force limits and held tolerances.
The chip is a free body: contact and friction carry it, not a scripted position update.

## Visual revision 3

The Nikon now has a rounded, photo-referenced head, lavender fascia, separate
binocular prisms, central Nikon bridge, hollow eyepieces with recessed glass,
filter/shutter panel, detailed stage connectors, objective markings and revised
cable/tape geometry. The filter/shutter buttons are visual details; the existing
XY, focus, turret and camera/eye controls remain the active simulated mechanisms.

All seven instruments now carry embedded color, roughness and normal textures,
with directional metal finishes. The same maps drive Blender and the live view.
The browser also has revised room reflections, contact shadows and tone mapping;
the gallery links to new 3840 × 3200 overview renders and detailed close-ups.
These changes improve the reconstruction's appearance; they do not establish
photographic identity or calibrated material properties.

Additional renders: [Nikon optical head](assets/nikon/optical_head.png),
[operator view](assets/nikon/operator_view.png), [AFM door release](assets/afm/door_release.png),
[open enclosure](assets/afm/open_scanner.png), and [scanner release](assets/afm/scanner_release.png).

[Visual revision checks](validation/realism3.json) record the delivered asset
hashes, texture checks, unchanged physics and final browser regression results.

## Implementation

- `physics.js` runs **MuJoCo 4.0.1 WebAssembly**, single-thread build, at a 1 ms step.
  Torque controllers, actuator limits, mocap weld slew and AFM guards implement the
  same mechanisms as the original native runtime (MuJoCo 3.3.7).
- `worker.js` keeps physics and Python computation off the page's rendering thread.
  Closing an instrument terminates its worker and releases its runtime memory.
- `python/tasks.py`, `imaging.py` and `optics.py` retain the original task and image
  implementations. Pyodide 0.28.3 supplies NumPy, SciPy and Pillow locally.
  `python/sim.py` bridges snapshots and actions to the real MuJoCo runtime.
- `assets/*/physics.xml` retains joints, equalities, inertias, sites and analytic
  contact shapes. Noncolliding visual meshes are omitted from this XML only;
  the detailed hierarchy and materials are in `model.glb`.
- Three.js renders measured body poses with PBR materials, room lighting and shadows.
  Full-resolution Blender renders are separate static views, labeled in the UI.
- All runtime dependencies are served from this repository. No CDN, custom response
  headers, cross-origin isolation, or running service is required.

Models are photo-referenced reconstructions. Unmeasured dimensions, material
properties, optical parameters and provisional instrument identities are estimates.
The image model convolves a thin intensity specimen with a scalar circular-pupil
PSF. It cannot infer a specimen's unknown phase or 3D structure from one photograph.
Probe images include measured needle projections with approximate depth blur;
transfer images currently omit stamp occlusion. Bonding tasks test contact mechanics,
not ultrasonic welding or metallurgical bond formation.

## Browser validation

The browser port was revalidated independently of the native 3.3.7 engine:
54/54 positive episodes across seeds 0, 1 and 2; 18 no-action controls with zero
false positives; 48 mechanical/optical checks; and all seven detailed models loaded
in the interactive page. A complete 20-second tweezer placement was inspected at
every 1 ms step: 20,000 steps, zero unintended tool/work-surface contacts.

[Recorded results](validation/summary.json) include links by filename to the full
physics, mechanism and browser reports alongside it. These are fixture benchmark
checks on estimated instrument models, not physical-lab calibration results.

## Develop and publish

Serve the checkout over HTTP (opening `index.html` as `file://` cannot load workers):

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. There is no build or dependency installation for the
site itself. Files use relative URLs so both a repository subpath and a root work.

Run `python3 scripts/check_bundle.py` to validate the deployable bundle. Browser
validation and its recorded results are in `tests/` and `validation/`.
Pushing to `main` runs `.github/workflows/pages.yml` and updates GitHub Pages.

See [THIRD_PARTY.md](THIRD_PARTY.md) for dependency versions and licenses.
