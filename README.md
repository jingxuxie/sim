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
   **More rendered views** opens additional mechanism close-ups.
   **Full instrument / Working area** returns to the live 3D view.

Existing task recordings show earlier reconstructions. Use the live viewer and
current rendered stills to inspect revision 4.

The gallery is lightweight and remains visible without JavaScript. Only the selected
instrument is downloaded (about 6–52 MB including geometry and textures). The runtime adds about 23 MB when you open an instrument; task policies and optical
imaging load another 20 MB on first use. These files are cached by the browser. Use a current desktop
Chrome or Edge with WebAssembly and WebGL enabled. Complex optics
and contacts can run slower than real time; the displayed clock is simulation time.

## Instruments and tasks

| Instrument | Live mechanisms and tasks |
| --- | --- |
| Nikon Eclipse E1000 | Geared XY knobs, coarse/fine focus, seven objective stations, camera/eye selector; centering, focusing, indexing and image-feedback tasks |
| Dry-transfer station | Screw-driven sample/stamp stages, coarse clamp and fine rotation micrometer, goniometer, external illuminator and light routing; alignment and contact/retraction |
| Manual probe station | Chuck, two probe manipulators and microscope; pad alignment and measured two-tip contact/retraction |
| Zeiss Axioskop | XY stage and connected controls, focus, objective turret and light routing; centering and focusing |
| West·Bond 7700 | Separate hand lever and wedge head with 8:1 motion coupling; alignment and two-pad contact sequence |
| Asylum Cypher S | Enclosure release, door, scanner release and drawer with interlocks; access and complete open/close cycle |
| Spring tweezers | Two compliant jaws and a moving fixture; contact-based chip grasp, lift and tray placement |

The 18 baselines are instrument-level fixture controllers, not learned robot policies.
Success uses measured joint state, sites, contacts, force limits and held tolerances.
The chip is a free body: contact and friction carry it, not a scripted position update.

## Visual revision 4

[Compare previous and rebuilt instruments](assets/revision4-comparison.jpg).

This revision rebuilds all six non-Nikon instruments. Their moving geometry, housings, fasteners, graduated controls and service connections are reconstructed from the supplied lab references. Nikon retains its revision-3 reconstruction.

| Instrument | Main corrections |
| --- | --- |
| Transfer station | Separate Fiber-Lite MI-150 source; ferrules and continuous guide into the microscope; physically separated XY races and hollow Z lift; 73.2 mm Newport 481-A with separate coarse lock/fine micrometer; GON40-L remote pivot and adjustment knob; distinct Mitutoyo barrel; complete camera cable |
| Probe station | Different left/right manipulator assemblies, carrier clamps, rear optical mounting enclosure, slot hardware and flexible triax leads; photographed 5×/0.14 objective used by the camera model |
| Zeiss Axioskop | Cast stand profile, prism lobes, objective carrier, reflected-light housing, specimen holder and condenser support; connected XY knob assembly with checked focus-wheel clearance |
| West·Bond 7700 | Separate head and hand lever, asymmetric tool pivots/clamp, spool support, Olympus-style microscope yoke, heated workholder and service panels |
| Cypher S AFM | Formed enclosure cheeks and console, upper opening, scanner deck and guides, recessed handle, separate releases, gasket and docking connections; corrected opening clearances |
| Tweezers | Continuous beveled spring blades, rounded laminated heel and fitted label; contact-based chip delivery into the tray |

Overview images are 3840×3200; new details are 2560×2160. The live GLBs use the same surface maps. From an instrument, choose **More rendered views** to inspect the source/fiber, rotation stage, manipulators, optics, releases or measured chip placement.

The transfer source power and dimmer affect microscope images. The dimmer represents a 10–100% relative illumination range; its zero setting is the powered minimum. The coarse ring turns with the clamp released; locking it engages the fine micrometer. Fiber and probe cables follow measured joint motion through visual deformation, without cable contact or strain simulation.

[Delivery audit](validation/realism4.json) records the current model, physics, texture and final-still hashes. [Browser results](validation/summary.json) link current runtime checks. Dimensions not established by readable markings or manufacturer drawings, material properties and hidden mechanics remain estimates. The image model is not a calibrated optical digital twin.

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
  GPU frame submission is bounded, and the preview remains visible until the first
  rendered frame completes. Static still views stop background 3D rendering.
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
false positives; 58 mechanical/optical checks; 12 flexible-cable geometry checks;
and 16 interactive-page checks covering all seven detailed models, controls and
gallery fallbacks. A complete 20-second tweezer placement was inspected at
every 1 ms step: 20,000 steps, zero unintended tool/work-surface contacts.

[Recorded results](validation/summary.json) include links by filename to the full
physics, mechanism, cable and browser reports alongside it. The native engine
also passes 54/54 episodes across seeds 0, 11 and 37, with 18 no-action controls.
These are fixture benchmark checks on estimated instrument models, not
physical-lab calibration results.

## Develop and publish

Serve the checkout over HTTP (opening `index.html` as `file://` cannot load workers):

```sh
python3 scripts/serve.py --port 8000
```

Open `http://localhost:8000/`. There is no build or dependency installation for the
site itself. Files use relative URLs so both a repository subpath and a root work.

Run `python3 scripts/check_bundle.py` to validate the deployable bundle. Browser
validation and its recorded results are in `tests/` and `validation/`.
Pushing to `main` runs `.github/workflows/pages.yml` and updates GitHub Pages.

See [THIRD_PARTY.md](THIRD_PARTY.md) for dependency versions and licenses.
