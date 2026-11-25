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
6. **Contact shapes** overlays the actual MuJoCo collision geometry in orange.
   This shows where a robot can make physical contact, including the difference
   between detailed visible surfaces and simplified collision shapes.
7. **View quality → Photo quality** pauses physics at the current measured pose
   and progressively traces soft shadows, reflections and light bounce. Drag to
   orbit; the view responds immediately and refines again after movement stops.
   Operating an instrument returns to **Interactive** and resumes live controls.
   Switching the quality selector back releases an automatic photo pause; a
   pause you requested yourself is preserved.

Existing task recordings show earlier reconstructions. Use the live viewer and
current rendered stills to inspect the latest models.

The gallery is lightweight and remains visible without JavaScript. Only the selected
instrument is downloaded (about 6–52 MB including geometry and textures). The runtime adds about 23 MB when you open an instrument; task policies and optical
imaging load another 20 MB on first use. These files are cached by the browser. Use a current desktop
Chrome or Edge with WebAssembly and WebGL enabled. Complex optics
and contacts can run slower than real time; the displayed clock is simulation time.

The ordinary interactive view uses the Blender studio's rectangular lights,
environment orientation, bench height and display transform. Parts cast soft
shadows on each other, and recessed surfaces receive less indirect light. All seven
instruments share this lighting and the new scene-reflection system. Broad flat
surfaces, including the bench and selected instrument decks, reflect the actual
surrounding assemblies through a reflected camera. Objects outside the main view
can now appear in those reflections. Roughness and brushing direction control
their blur, while uncovered directions retain the room environment.
Shadow visibility is weighted separately for diffuse light and glossy highlights.
A filter respects surface boundaries while smoothing those visibility estimates;
it does not blur the surface textures or the rendered image.

Objective barrels on the Nikon, transfer station, Zeiss and probe station use
local scene captures around each objective. These include nearby instrument parts
and neighboring objectives, so barrel reflections are no longer limited to the
static room environment. The source Blender anisotropy is translated into the
local reflection approximation without changing the exported material settings.
The bonder, AFM and tweezers use the shared studio lighting and planar captures;
their curved parts retain room reflections.

The live renderer budgets a bench capture and up to two broad instrument planes.
Planar captures refresh after camera, pose or environment changes. Objective
captures are staggered, normally one probe per update with at least 40 ms between
captures; a full turret refresh can take several frames and lag during motion.
Camera movement samples the available objective captures immediately. These are
single-bounce approximations: planar coordinates follow the geometric plane,
brushed reflections use an approximate directional filter, and objective captures
do not reconstruct exact per-pixel parallax. Small unselected surfaces still use
room lighting. Blender Cycles retains more complete light transport and material
response, so increasing resolution alone cannot make the two views identical.
The earlier screen-space reflection pass remains a fallback when scene captures
are unavailable; it cannot reflect objects outside the main screen. Graphics
fallbacks retain compatible lighting and live instrument controls.

The browser's display transform now uses Blender 4.2.8's actual AgX Medium High
Contrast shader/tables and exposure, shared by Interactive and Photo quality.
The tables add about 2.8 MB on the first instrument load; a failed download
retains the previous display look and does not block instrument operation.

Photo quality adds multiple light bounces and traced source visibility using the actual current 3D scene.
It is not a pre-rendered photograph. It requires WebGL 2 floating-point targets
and is most useful on a desktop GPU; initial preparation and refinement can be
slow on software graphics. Early samples are noisy; a gentle edge-preserving
display filter reduces grain as sampling progresses. The last interactive frame
remains visible during preparation. Initial shader compilation can temporarily
delay input on some graphics drivers.

Photo quality is capped at 512 samples and approximately 1.5 megapixels to bound
GPU work. The image continues improving while stationary; refinement can take
minutes, especially on software graphics. You can orbit or return to Interactive
at any time. Blender stills retain higher resolution, more light bounces and
stronger offline denoising, so the two renderers will not produce identical images. Photo quality
is intended for inspecting a stationary pose; live task operation uses the
interactive renderer.
The browser path tracer retains the exported color, roughness and normal maps;
brushed-metal anisotropy uses an isotropic approximation in this mode.
The scene-reflection update changes Interactive rendering; Photo quality still
uses the unchanged path tracer and pauses physics while refining the measured pose.

[Compare the previous live view, scene reflections, and matched Blender renders](validation/reflections3/comparison.jpg).
The [earlier lighting comparison](validation/lighting2/comparison.jpg) and
[previous Photo-quality comparison](validation/photo1/comparison.jpg) remain available.

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

## Physics and robot contact

The instruments contain MuJoCo rigid bodies, masses, inertias, joints, friction
and collision shapes. Instrument bases are anchored to the bench. Most detailed
surface meshes are visual geometry; collision proxies approximate their surfaces.
Standard robot collision masks can contact the instrument proxies, while many
instrument-to-instrument contacts are suppressed. The orange **Contact shapes**
view exposes this coverage; it does not add collisions to decorative geometry.

The transfer, probe and Zeiss screw constraints use input-angle coordinates to
avoid numerical softness at very small metres-per-radian ratios. Estimated
holding friction remains passive when fixture actuators are disabled. These
properties have not been calibrated against laboratory torque/force measurements.
Some passive mechanisms still drift: with drives disabled, the transfer optical
head moved 24 µm and the goniometer tilted 0.23° over 20 seconds. These remaining
limitations are recorded in the [passive-mechanics audit](validation/passive_mechanics.json).

Transfer and probe optical focus handwheels remain visual parts: the head slides
have physics, but these wheels do not yet transmit robot contact to focus motion.
The Nikon coarse/fine wheels use a powered encoder-to-focus abstraction. Flexible
hoses follow measured joint motion visually; they do not simulate contact, strain,
tension or fluid flow. Robot manipulation must be validated for each target and
approach, rather than inferred from the appearance of its mesh.

[Run the parallel-gripper benchmark](robotics/README.md): a Panda gripper grasps
the transfer station's sample-X micrometer, turns it −15°, releases and retracts.
All instrument drives are removed. Three contact trials reached the −20.833 µm
stage target within 0.131 µm, while nine causal controls correctly failed.
This is an executable native MuJoCo task with a Cartesian wrist fixture; a full
arm and a browser-live robot controller are not included. The linked package
includes commands, licensed geometry, measured trajectories and validation.

**Cable contact is not simulated.** Flexible cable meshes in the browser and
Blender follow measured instrument motion through prescribed deformation. Native
MuJoCo contains decorative cable meshes with `contype="0"`, `conaffinity="0"`
and `density="0"`; the browser physics export removes those visual meshes.
Native cable spans retain their rest shape relative to their owning rigid body.
There are no flexible cable bodies, cable joints, independent cable mass, stiffness, damping,
tension or collision response. A gripper or hand can pass through a cable even
when nearby instrument housing proxies collide. Physical cable manipulation
requires a separate articulated or flexible-body model, attachment constraints,
and contact validation; the existing hose-clearance results below do not provide
that capability.

The transfer vacuum and heater lines now terminate in separate fittings and
follow XY plus rotation. Their declared attached-service envelope is ±90° coarse
rotation plus ±2.5° fine adjustment, with the stamp retracted. A sampled
1,539-pose sweep found no intersections; the minimum conservative gap was
0.589 mm. Larger rotations require rerouting or disconnecting services, which
is outside the current cable model. All three gripper trajectories were also
checked against the deformed visual hoses, with at least 10.13 mm clearance.
[Hose clearance evidence](validation/transfer_hose/summary.json).

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

[Delivery audit](validation/reflections3.json) records the current model, physics, texture and final-still hashes. [Browser results](validation/summary.json) link current runtime checks. Dimensions not established by readable markings or manufacturer drawings, material properties and hidden mechanics remain estimates. The image model is not a calibrated optical digital twin.

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
- `scene-reflections.js` schedules planar scene captures and the four supported
  instruments' local objective probes. Capture materials retain the source PBR
  data and share the actual scene geometry; captured radiance replaces the relevant
  environment contribution instead of adding duplicate light. Capture work is
  bounded and staggered, without a guaranteed frame rate on an arbitrary GPU.
- Optional `progressive-renderer.js` loads a locally pinned WebGL path tracer only
  when requested. A dedicated worker builds the ray-intersection acceleration
  structure. Photo geometry is copied from the measured pose; camera changes
  reset accumulated samples, and changing instruments releases the photo scene.
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
false positives; 60 mechanical/optical checks; 28 flexible-cable geometry checks;
28 compiled-contact-overlay checks; and 18 interactive-page checks covering all seven detailed models, controls and
gallery fallbacks. A complete 20-second tweezer placement was inspected at
every 1 ms step: 20,000 steps, zero unintended tool/work-surface contacts.

[Recorded results](validation/summary.json) include links by filename to the full
physics, mechanism, cable and browser reports alongside it. The native engine
also passes 54/54 episodes across seeds 0, 11 and 37, with 18 no-action controls.
These are fixture benchmark checks on estimated instrument models, not
physical-lab calibration results.

Current rendering evidence includes [browser and Photo-mode checks](validation/reflections3/rendering.json),
[all-seven-instrument checks](validation/reflections3/models.json),
[reflection updates during camera and mechanism motion](validation/reflections3/motion.json),
[planar reflection controls](validation/reflections3/planar.json),
[objective reflection controls](validation/reflections3/objectives.json), and
[source and protected-input verification](validation/reflections3/delivery.json).
Earlier evidence remains available for [pause/cancellation behavior](validation/lighting2/lifecycle.json),
[micrometre-scale ray intersections](validation/photo1/intersection.json),
[display-transform agreement](validation/lighting2/grade_gpu.json), and
[cable physics coverage](validation/lighting2/cables.json).
Physics and instrument assets are unchanged from the contact-manipulation release;
the current summary verifies their hashes before carrying forward that physics
evidence. Reflections do not add cable contact, tension or deformation physics.
Controlled rendering checks and matched instrument views do not establish
equality with Cycles or a frame-rate guarantee for other graphics devices.

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
