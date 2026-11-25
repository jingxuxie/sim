# Gripper contact benchmark

![Panda gripper on the corrected sample-X micrometer](preview.png)

[Watch the measured 12-second task](contact_task.mp4) ([provenance](video_report.json)).

A Panda parallel gripper closes, turns the sample-X micrometer by −15°, releases
and retracts. Contact and friction transmit its motion; all instrument actuators
are removed. The wrist is a force-limited Cartesian fixture, not a full robot arm.
This benchmark runs in native MuJoCo and has no browser-live robot controller.

The current task uses the raised handwheel mount and full thimble, collar and
wheel collision coverage. All three contact trials passed: maximum stage error
0.1299 µm for a −20.833 µm target, maximum native penetration
20.72 µm, peak individual normal force 3.2664 N,
and zero unintended robot/instrument contacts. Instrument actuator force and
applied wrench were zero. Nine paired controls (disabled contact, missed grasp,
no turn) failed the task as expected; maximum stage drift was 0.0396 µm.
The portable package reproduced all seed-0 physical metrics exactly.

```sh
tar -xzf portable.tar.gz
cd transfer-gripper-benchmark
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python robotics/validate_gripper.py --out validation/robotics
python robotics/view_gripper.py --autoplay
```

Download [the portable benchmark](portable.tar.gz). The desktop viewer shows
physical contact proxies and Panda meshes; A/D, S/W, F/R move the wrist, Q/E
roll, O/C open/close, Space toggles playback and Backspace resets.
[The detailed GLB](model.glb) is separate articulated visual geometry. A player
must apply [measured poses](trajectory.json) and prescribed service-line bending.

Evidence: [12 trial results](validation/summary.json),
[portable comparisons](validation/portable_verification.json),
[visual alignment](validation/glb_alignment.json), [visual gripper/table clearance](validation/visual_table_clearance.json),
[render provenance](render_report.json),
and swept hose/gripper checks for [seed 0](validation/hose_seed_0.json),
[seed 11](validation/hose_seed_11.json), [seed 37](validation/hose_seed_37.json).

Instrument inertia/friction are engineering estimates. Hoses have visual bending
without contact, tension or load dynamics. The initial robot pose is above the
knob; larger rotations require regrasp planning. This validates one precision
contact task, not arbitrary robot approaches.

Panda geometry and inertials are from MuJoCo Menagerie commit
`eea4c7431b63da8278b0ff31638e0b0e941cec0e`, under [Apache 2.0](PANDA_LICENSE),
with [source fingerprints](PANDA_SOURCE.json). Wrist servos are benchmark estimates.
