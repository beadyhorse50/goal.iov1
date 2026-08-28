# goal.io — skinned players

Players are a skinned, textured glTF mesh driven by the rig `js/anim.js`
already animates. Before this they were ~35 analytic primitives each, which
`docs/GRAPHICS-AUDIT.md` named as the hard ceiling on the game's look.

**Turn it off:** `?skin=0`, or `SKIN.off()`. The primitive players are still
there, still correct, and are the automatic fallback if WebGL2, the shader or
any of the three models fails to load.

## Where the models came from

`football-characters/` — four rigged, textured, LOD'd footballers plus the pure
Python generator that made them. The graphics audit listed character models,
textures and skinned meshes as things that "cannot be produced from inside the
project"; they had been sitting one folder up, classified as an unrelated Unity
deliverable. Three are now in `assets/models/`:

| Model | Used for | Kit |
|---|---|---|
| `Defender.glb` | `team === "us"` | red, plain, №5 |
| `Forward.glb` | `team === "them"` | blue halves, №9 |
| `Goalkeeper.glb` | `role === "gk"` | teal with a sash, №1 |

Each is glTF 2.0 binary, ~470 KB, 27 Unity-Humanoid bones, LOD0 5,688 tris and
LOD1 1,452, four materials and **eight embedded 512² PNGs** — the first
textures of any kind in this project.

## The two files

**`js/gltf.js`** parses the container into typed arrays and ImageBitmaps.
It is deliberately *not* a general glTF implementation: it supports exactly
what these files use, determined by reading them rather than the spec, and
throws with a message naming what it found for anything else. Half-loading a
model produces geometry that is subtly wrong, which is far more expensive to
diagnose than a refusal.

**`js/skin.gl.js`** owns the GPU side: programs, buffers, textures, the skin
matrices and the draw. It compiles its own shaders from `GLR.glsl` — the same
`COMMON`, `PBR` and `SHADOW` chunks every other surface uses — because a second
copy would drift, and a player lit differently from the pitch he stands on is
the most obvious wrongness a renderer can produce.

## How the animation maps, and why it converts no angles

The obvious approach is to turn `anim.js`'s per-joint `[pitch, yaw, roll]` into
glTF-local rotations. That is a trap: the two rigs put bones on different local
axes. goal.io bones all extend along their own **−U**; glTF bones extend along
**+Y** for the spine, **+X** for the arms and **−Y** for the legs, because glTF
joints are axis-aligned with the model at bind. "Pitch about the joint's own
right axis" is a different rotation in each rig, per bone.

The way through is that `solveRig()` does not return angles. It returns a
world-space orthonormal basis `(R, F, U)` per joint. And both rigs are identity
at bind — `solveRig` with a neutral pose gives every joint the player's base
basis, and the loader asserts no glTF joint has a bind rotation. So one fixed
correspondence holds everywhere:

```
glTF local +X  ->  -R        glTF faces +Z with +Y up, so its right is -X;
glTF local +Y  ->   U        goal.io faces +F with +U up and right +R
glTF local +Z  ->   F
```

A joint's world matrix is `[-R | U | F | position]`, straight from the solver.

Positions walk the glTF hierarchy using the **glTF** bind translations, not
goal.io's rig offsets. The skeletons have near-identical proportions (0.422 vs
0.42 thigh, 0.282 vs 0.26 upper arm) but "near" is not "equal", and the skin
has to match the mesh it deforms.

**Sanity check on the whole scheme:** with a neutral pose every orientation
collapses to the base basis and `skin = translate(root) · B · translate(bind) ·
translate(−bind) = translate(root) · B`. Every vertex lands at the player's
position with the player's facing.

## The bind fixup — the bug this cost

The first working version rendered every player standing in a **T-pose**, arms
straight out sideways, legs and torso perfectly correct.

The mapping was right. The assumption underneath it was not: that a joint's
bone points the same way in both rigs at bind. It does for the legs and spine —
glTF `LeftUpperLeg` runs to its child along −Y, goal.io `hipL` runs to `knL`
along −U, which the axis map sends to −Y. Identical. But glTF is authored in a
T-pose, so `LeftUpperArm` runs along **+X**, while goal.io's neutral arm
**hangs**, running along −U. The idle clip's small shoulder angles are
adjustments to a hanging arm; applied to a T-pose arm they leave it out
sideways.

So each mapped joint carries the rotation taking its glTF bind bone direction
to its goal.io one. It is **derived from the two skeletons at load**, not
hardcoded — ±90° per arm would be four more numbers to get backwards and would
break silently if either rig were re-authored. A goal.io leaf (hands, head,
feet) has no bone to align and inherits its parent's fixup; without that the
hand keeps the T-pose twist while the forearm swings down, and the wrist
shears.

## Verifying it

```js
SKIN.stats()          // {ready, failed, queued, models, joints}
SKIN.debugJoints()    // world position of every joint, last player solved
SKIN.setEnabled(false)// swap back to primitives inside one page load
```

`debugJoints()` exists because "the arm looks wrong" is not a measurement. A
symmetric pose must give mirror-symmetric joints — that check is what proved
the arms were correct after the fixup and that an apparent asymmetry in a
close-up was foreshortening from a camera behind and above.

Measured on the keeper's symmetric brace pose: every left/right pair matched to
4 decimal places on all three axes.

## Cost

Interleaved with the primitive path in a single page load, four passes of
thirty frames, GPU-synced with a `readPixels` per frame:

| Level | Players | Primitive | Skinned |
|---|---|---|---|
| 1 | 2 | 16.6 ms (16.3–16.8) | 16.6 ms (15.9–16.7) |
| 8 | 7 | 17.1 ms (15.9–17.3) | 17.8 ms (16.7–18.1) |
| 10 | 10 | 16.7 ms (15.4–17.0) | 17.8 ms (17.1–17.9) |

**About 0.1 ms per skinned player**; at level 1 the ranges overlap and the two
are indistinguishable. Note the absolute figures are much higher than the
6–9 ms in `docs/WEBGL.md` because `js/res.js` now targets a 4K pixel budget —
5.3 MP at a 390×844 play area. Different baseline, not a regression. **Measure
on a phone.**

The shadow pass always draws LOD1, and the shading pass switches to LOD1 past
18 m. Nothing in a 1024² shadow map resolves the difference.

## What is still wrong

1. **Kit colour is baked into the texture.** The models cannot follow `COL.us`,
   `COL.them` or the per-season club kit — Hackney Marsh white, Redbridge City
   cyan, Atlético Lisboa gold. The colours happen to be close (red / blue /
   teal) so it reads correctly today, but the season kit change does nothing.
   The fix is a greyscale kit texture plus a tint mask, generated by the
   existing `chargen/` — pure Python, no Blender.
2. **Three body types for eleven players.** Everyone on a team is the same
   mesh, same face, same build. `chargen/` can generate variants.
3. **No per-player squad numbers.** The number is painted into the kit atlas,
   so every `us` player wears №5.
4. **Still no imported animation.** The 13 procedural clips drive the mesh
   well, but `animations: 0` in every model. See `docs/PHASE-1-AUDIT` Asset 1
   for the Blender retargeting brief.
5. **1.4 MB of models** are in the service worker's `ASSETS`, so a first
   install pays for them up front. Worth revisiting with KTX2 texture
   compression and Draco geometry compression.
