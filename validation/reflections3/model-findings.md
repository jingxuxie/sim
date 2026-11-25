# Separate model finding: transfer lift lid intersects its carrier

This observation is not an illumination difference. Geometry is intentionally unchanged in the lighting2 renderer comparison.

In `001_transfer_stage/geometry_revision4.py`, `precision_stage()` constructs a vertical lift as follows:

- Line 118: `a.board(name+' drilled lift table',(0,0,12),(w,d,8),25.4,color)` sets the drilled lid's top to local Z = 16 mm and underside to 8 mm.
- Line 119: `a.box(name+' internal lift carrier',(0,0,1),(w-31,d-32,30),'brushed',.6,True)` sets the internal carrier's top to local Z = 16 mm and bottom to -14 mm. The box bevel is 0.6 mm; its broad planar top is still Z = 16 mm.
- `001_transfer_stage/build.py:91` uses `w=105 mm`, `d=89 mm` for `stamp_z`, so the carrier is 74 × 57 × 30 mm. Its top spans local X = ±37 mm and Y = ±28.5 mm, overlapping the central area of the 105 × 89 mm drilled lid.
- `tools/assetkit.py:140–158` creates a genuine 25.4 mm grid of counterbores. In this lid the centers are X = {-25.4, 0, 25.4} mm, Y = {-12.7, 12.7} mm. All six bore centers are within the carrier footprint. Their nominal recess extends from Z = 16 mm down to 10.2 mm, but the carrier fills that entire depth.

Consequences: the nominal bores are occupied by the carrier, and overlapping top triangles have effectively zero separation. The source Cycles render shows a different pattern from the browser's raster/path-traced export on this patch; this is unsuitable as a target for reflection matching. It is not evidence that the interactive renderer removed real holes.

For the renderer comparison, inspect objective-barrel highlights, the large optical breadboard, and the stage sidewalls without overlapping geometry. A separate geometry revision should put the carrier top below the drilled lid's underside, then verify guide-column clearance, lift travel, lid bores, and collision proxies before regenerating Blender, GLB, and MuJoCo assets together.
