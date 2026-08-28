# goal.io — the Blender pipeline

Blender is now part of the toolchain. It is used **headless and by script**,
never interactively, for the same reason `football-characters/chargen` is pure
Python: a script is re-runnable and diffable, and a hand-modelled `.blend` is a
binary that one person can change.

```bash
BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"

# the pipeline gate — run this first if anything about the rig changes
"$BL" --background --factory-startup --python tools/blender/roundtrip.py -- \
      assets/models/Forward.glb build/roundtrip/Forward.glb

# regenerate the stadium props
"$BL" --background --factory-startup --python tools/blender/stadium_props.py -- \
      assets/models/stadium_props.glb
```

`--factory-startup` is not optional: it runs with no user preferences and no
third-party addons, so the output is what a clean machine produces rather than
what this one happens to have installed.

## Why not the Blender MCP

There is a good community MCP server ([ahujasid/blender-mcp]) that lets Claude
drive Blender live, and it is the right tool for *art direction* — "make the
celebration more expansive" while watching the viewport.

It is the wrong tool for a build step. These assets need to be reproducible:
change the pylon height, re-run, get a new GLB deterministically. That is a
committed script, not a conversation.

[ahujasid/blender-mcp]: https://github.com/ahujasid/blender-mcp

## `roundtrip.py` — the gate

Imports a character GLB, reports what Blender made of it, exports it straight
back. Nothing changes in between. Run it before trusting Blender with anything
that matters.

It checks the things that would actually break the game:

- all **27 joints** survive with their **names** intact — `js/skin.gl.js` maps
  by name, and a renamed bone silently drops that joint to its parent's rotation
- the bind pose stays **translation-only**, which `js/gltf.js` asserts and the
  whole no-Euler-conversion scheme in `docs/PLAYERS.md` rests on
- both LODs, all four materials, and the embedded textures survive

**Verified on Blender 5.2.1 LTS:** source and re-exported file are structurally
identical — 2 meshes, 30 nodes, 27 joints, 7,140 triangles, 4 materials, 8
images, 0 animations. 468 KB in, 451 KB out (PNG re-encoding).

### The Icosphere

Importing a character produces a stray 42-vertex `Icosphere`. It is not in the
file and it is not a bug: Blender's glTF importer parks its own housekeeping in
a collection literally named **`glTF_not_exported`**, and it never reaches an
export. `roundtrip.py` filters that collection so the triangle count it reports
is honest. Recorded here so nobody chases it twice.

## `stadium_props.py` — corner flags, floodlights, dugouts

| Prop | Tris | Height | Why |
|---|---|---|---|
| `Prop_CornerFlag` | 40 | 1.50 m | **The game had none.** `drawCornerFlags()` was stubbed out when the WebGL path took over the world passes and nothing replaced it |
| `Prop_Floodlight` | 824 | 28.6 m | At night the only visible light source was a strip of roof lamps. A pylon is the silhouette that says *football ground* |
| `Prop_Dugout` | 156 | 2.26 m | On the halfway line, in every wide camera |

Conventions, which matter more than the geometry:

- metres, **+Y up**, facing **+Z** (glTF); the game converts on load
- every prop's origin is at its **base**, on the ground, centred
- one root node per prop, named `Prop_*`
- **no textures** — flat `baseColorFactor` only. The renderer's PBR does the
  lighting, and a texture here would be a second art direction competing with
  the one already in `js/render.gl.js`

### The bug worth recording

`primitive_cube_add(size=1)` spans −0.5…+0.5, so the scale factor for a box of
full extent `size` is `size`, **not** `size / 2`. Getting it wrong halves every
box in the file, and it does not look like a bug — it looks like a dugout
somebody modelled slightly small. It was caught because the script prints each
prop's measured height and the dugout came out 1.67 m instead of 2.26 m.

Print your dimensions.

## How they reach the game

`js/props.gl.js`, in the same shape as `js/skin.gl.js`: its own program
compiled from `GLR.glsl` so the props are lit by the same rig as everything
else, and two hooks in `render.gl.js` (one shadow pass, one shading pass). If
the GLB fails to load, nothing runs and the game is exactly what it was.
`?props=0` disables it.

**Placement is derived, never typed.** Positions come from `PITCH` and the
bowl's own footprint, so editing `config/pitch.json` moves the flags and the
dugouts with the lines. Ten instances: four flags, four pylons, two dugouts.

The pylons are skipped in the depth pass — a 28 m mast standing 90 m out is
nowhere near the shadow camera's 22 m box, so it would cost a draw and cast
nothing.

Their cost could not be measured on this machine: interleaved with-and-without
passes spread 20–33 ms across identical configurations, so ten draws of ≤824
triangles sit below the noise floor. **Measure on a phone.**

## Still to do in Blender

**The animation set**, and it is the only remaining job that genuinely needs
Blender. All three characters carry `animations: 0`; the thirteen clips in
`js/anim.js` are procedural. Retarget a mocap set onto the 27-bone Humanoid
skeleton (`mixamorig:Hips→Hips`, `LeftArm→LeftUpperArm`,
`LeftForeArm→LeftLowerArm`, `LeftUpLeg→LeftUpperLeg`), push each to an NLA
strip named exactly as the clip keys in `js/anim.js`, bake root motion out —
the sim owns position — and export **animation only, with Mesh unticked**, to
`assets/anim/player_clips.glb`. One file serves every model and kit variant.

That step needs source mocap, which has to be downloaded; everything above
needed nothing but the script.
