# goal.io — graphics architecture audit

Written 2026-08-26. Every claim below was measured in the running game with
`js/shot.js` (GL readback in a hidden tab), not judged by eye. Where a number is
quoted it came off the framebuffer.

---

## 0. Verdict

**The architecture does support real-time PBR, and as of this session it is
actually running.** It does not support — and cannot be made to support without
adding an asset pipeline — skinned characters, textured surfaces, or real
reflections.

The renderer is a hand-written WebGL2 deferred-less forward renderer
(`js/gl.js`, `js/render.gl.js`, `js/post.gl.js`) with a complete 2D-canvas
renderer as a fallback (`js/render.js`). No engine, no build step, no
dependencies, no image files of any kind.

The ceiling is not the shading model. The shading model is fine. The ceiling is
**geometry and texture**: a player is 35 analytic primitives and every surface
in the game is a solid colour.

---

## 1. Every limitation preventing AAA graphics

Ordered by how much each one costs, worst first.

### 1.1 No skinned meshes — this is the hard ceiling

A player is built at runtime from ~35 instanced primitives: tapered cylinders
for bones and spheres for joint caps (`limbIns` / `sphereIns` in
`js/render.gl.js`). There is no mesh, no skeleton binding, no vertex weights, no
deformation.

Consequences that cannot be worked around in this design:
- No cloth. A shirt cannot flutter, crease, or lag behind the torso.
- No muscle or volume change. A limb is a cylinder at every pose.
- No facial animation. The head is an analytic shader (`HEAD_FS`) that draws
  hair, brow and jaw as signed-distance regions on a sphere; it is genuinely
  good at that, and it can never blink or open a mouth.
- Joints are visibly ball-and-socket. A sphere between two cylinders is the
  best available answer and it is not a shoulder.
- No hands or fingers. Forearms end in a cap.

### 1.2 No textures at all — zero image assets in the project

There is not one `.png`, `.jpg`, `.ktx` or `.basis` in the repository. Every
surface is a solid colour plus, in a few places, an analytic pattern (turf mow
stripes and wear, hoarding text, the head shader). Missing as a direct result:

- No albedo maps. No kit numbers, names, badges, sponsor blocks or collar detail
  on the GL players. (The **canvas** renderer does draw shirt numbers — so the
  GL path is behind the fallback here.)
- No normal maps. Fabric weave, turf blades, ball panel stitching and leather
  grain are all perfectly smooth.
- No roughness or AO maps. Roughness is one constant per material
  (`ROUGH = { kit: 0.74, skin: 0.52, sock: 0.80, boot: 0.22, sole: 0.46,
  short: 0.70, glove: 0.62 }`), so a whole shirt is uniformly matte.
- No detail at close range. The goal camera pushes in and there is nothing
  there to resolve.

### 1.3 Lighting is computed in gamma space, not linear

`GLX.col3()` (`js/gl.js`) converts a hex colour by dividing by 255 with **no
sRGB→linear decode**, and the composite writes straight to an 8-bit target with
no encode. So the GGX BRDF, the energy-conservation term `kd = (1-F)(1-metal)`
and the ambient integral all run on gamma-encoded values.

This is a real correctness limitation, not a cosmetic one: it is why mid-tones
wash out under a broad ambient probe and why every tuned constant in the file is
tuned to compensate. Fixing it is a one-line decode plus a one-line encode and a
complete re-tune of every colour and intensity in the renderer.

### 1.4 No environment map, so no reflections

The IBL is analytic: `envSweep()` evaluates the sky's own three-colour gradient
in closed form. That is exact for this sky and costs almost nothing, and it means
there is no cubemap, so:
- Nothing reflects anything else. A wet pitch cannot reflect the stands or the
  floodlights; it can only get smoother (`rough = mix(0.86, 0.30, uWet)`).
- No screen-space reflections either — there is no full G-buffer, only depth.

### 1.5 One shadow cascade, sized to the play area

A single 2048² ortho depth map centred on the ball, half-extent 22 m widening to
46 m when the sun is low (`lightCamera`). Only players cast into it. The goal
frame, the net, the stands and the roof cast nothing. Outside the map
`shadowAt()` returns fully lit, so shadows do not fade at the boundary, they
stop.

### 1.6 No screen-space ambient occlusion

There is a linear depth texture already bound in the post chain (DoF and
reprojected motion blur both read it), so SSAO is genuinely available and simply
is not written. Contact darkening is currently faked from height alone:
`ao = mix(0.74, 1.0, clamp(vW.z / 1.4, 0.0, 1.0))` — a boot is darker than a
head because it is lower, which is a decent trick and is not occlusion.

### 1.7 No geometric anti-aliasing

The context is created with `antialias: true`, but the scene renders to a
manually created RGBA16F framebuffer, and MSAA does not apply to a user FBO. The
AA flag therefore does nothing except on the final fullscreen blit, which has no
edges. There is no FXAA, SMAA or TAA pass.

What saves it is `js/res.js`, which targets a 3840×2160 pixel budget — on a
390×844 frame that is a ratio of 4, so the frame is supersampled about 4× and
downsampled by the display. That is expensive AA, and it is the only AA.

### 1.8 The crowd is billboards

18,000+ instanced camera-facing quads with a two-shape silhouette (shoulders and
a head) drawn in the fragment shader, dissolving to a flat block below 7 px tall.
Nobody has arms, nobody has depth, and a spectator's silhouette is the same
silhouette 18,000 times.

### 1.9 Particles are CPU-side

No GPU particle system, no compute, no transform feedback. Effect counts are
bounded by JS loop cost.

### 1.10 UI cannot enter the 3D scene

The interface is DOM and CSS over the canvas (`index.html`). That is the right
call for crisp text on a phone, and it means no diegetic UI, no 3D-projected
name plates, no world-space markers except what the renderers draw themselves.

---

## 2. Assets that do not exist and would have to be created or imported

Nothing in this list can be produced from inside the project. There is no npm,
no Node, no Blender, no Pillow, no numpy — Python 3 stdlib and a browser.

**Character models** — none exist. Needed: one rigged outfield player and one
goalkeeper, glTF 2.0, ~8–14k triangles, single skeleton, LOD0/1/2. Plus separate
head meshes if faces are ever to be distinct.

**Environment models** — none exist. Everything is generated at runtime from
`BOWL` and `perimeterPath`. Needed for a real upgrade: goal frame with net
geometry, corner flags, dugouts, tunnel mouth, seat rows as instanced geometry,
roof trusses, floodlight rigs, camera gantries.

**Animations** — none imported. There are 13 hand-authored procedural clips in
`js/anim.js` driving a solved rig. Needed: a mocap or hand-keyed set — idle,
jog, sprint, plant, strike (inside/laces/outside), header, slide, dive
(keeper, 4 directions), celebration set, dejection set. As glTF animation tracks
against the model above.

**Textures** — none exist, in any form. Minimum set: kit albedo atlas with
number/name/badge layers, fabric normal + roughness, skin albedo/normal/
roughness, boot leather, turf albedo/normal/roughness at two mow phases, ball
panel albedo + normal, seat/concrete/steel for the bowl, hoarding artwork,
crowd sprite atlas.

**VFX** — no sprite sheets. Existing effects are procedural (`js/fx.js`).
Needed for a step up: turf-divot decals, ball trail ribbon, water spray sheet,
rain streak sheet, smoke/flare sheet, net ripple.

**Audio** — no audio files at all; everything is synthesised at runtime in
`js/audio.js` (oscillators and noise through a WebAudio graph). Needed: crowd
beds (ambient / surge / roar / groan / whistle), ball impacts by surface, net
hit, post hit, boot-on-turf footsteps, referee whistle, stadium PA, commentary.

**Fonts** — no font files; the UI uses a condensed system stack with a
`font-stretch` fallback. A licensed display face would be needed for a
distinctive wordmark.

---

## 3. Does the engine support…?

| Feature | Supported | Detail |
|---|---|---|
| Real-time lighting | **Yes** | 1 directional key with a shadow map, 4 floodlight point lights evaluated per pixel, analytic sky/ground irradiance probe. Sun elevation and azimuth now come from the condition. |
| PBR materials | **Yes** | GGX distribution, Smith height-correlated visibility, Schlick Fresnel, `kd = (1-F)(1-metal)`, Karis analytic env-BRDF for the ambient specular. Driven by roughness + metalness per instance. Runs in gamma space (see 1.3). |
| Post-processing | **Yes** | RGBA16F HDR target (`EXT_color_buffer_float`), soft-knee bright pass, two-level separable Gaussian bloom, depth of field focused on the ball, reprojected motion blur with geometric cut rejection, highlight shoulder, tint, contrast, saturation, vignette, grain. |
| 3D animation system | **Partly** | A real rig solver and a 13-clip animator with blending, power scaling and a replay tape. No skinning, no imported animation, no IK beyond the rig solve, no blend trees. |
| Modern UI system | **Yes** | DOM/CSS with an 8 px spacing scale, fixed type ramp, card panels, transitions. Not in-scene (see 1.10). |

**Where it falls short and the minimum change required:**

- *Textured, skinned characters* — needs a glTF loader (~400 lines: parse
  buffers, accessors, skins, animation samplers), a skinning vertex shader
  (joint matrices via UBO or a bone texture), a texture loader, and the assets
  in §2. This is the largest single change and it is the one that moves the
  needle most.
- *Reflections* — needs a cubemap render target, 6 faces, an irradiance
  convolution and a roughness-prefiltered mip chain. ~250 lines. Or, much
  cheaper for a pitch: a single planar reflection pass rendering the stands
  mirrored into a half-res target.
- *SSAO* — needs one half-res pass reading the existing depth texture, a
  hemisphere kernel and a bilateral blur. ~120 lines, no new assets. **The
  cheapest remaining real gain in the project.**
- *Linear colour* — decode in `col3` and every shader literal, encode in the
  composite. ~20 lines, then re-tune everything.
- *Anti-aliasing* — an FXAA pass on the HDR target, ~60 lines, would let the
  resolution budget drop and buy back frame time.

---

## 4. What changed this session

### 4.1 PBR was running but rendering wrong — two bugs, both found by measurement

**`vRough` was declared but never written.** `PLAYER_VS` had
`out float vRough;` and no assignment; the sphere vertex shader had the
assignment. An unwritten varying arrives as 0, which makes the GGX alpha
`max(rough², 0.0015)` = 0.0015 and the distribution term ≈ 141,000 at normal
incidence — a mirror lobe. Every player rendered as polished chrome. Measured
before: roughness at the torso 0.000 against an expected 0.74.

**The limb mesh was wound inside-out.** `unitCyl` wound every triangle the wrong
way — sides and both caps. With `cullFace(BACK)` / `frontFace(CCW)` set globally,
the outer wall was the back face and was culled, so what actually rasterised was
the *inside of the far wall*. A cylinder's silhouette is identical either way, so
the shape looked perfectly correct while every shaded pixel carried a normal
pointing away from the camera.

Under the old hand-tuned shader that was invisible: it wrapped its diffuse and
added a flat 0.34 ambient, so a back-facing normal read as slightly flat. Under a
real BRDF it was fatal. `dot(N,V)` was negative across the whole limb, clamped to
1e-4, driving Schlick's Fresnel to 0.9995, so `kd = 1-F` went to ~0 and the
diffuse term vanished entirely. Each limb rendered from ambient specular alone.

Measured before the fix: torso ambient **5/255**, joint-cap spheres **184/255**,
from the same fragment shader with byte-identical uniforms. Predicted from the
maths: 4.6/255. That match is what identified the cause.

### 4.2 The crowd was unlit

`c *= 0.72 + 0.42 * shade` lands between 0.97 and 1.14, so 18,000 spectators
were drawn at full albedo in every condition. In daylight that looked flat. At
night it was ruinous — the stands rendered **brighter than the floodlit pitch**,
which is the one thing that never happens in a real stadium and was the single
strongest tell that these were not broadcast frames.

The bowl is now lit by the same rig as everything else. The row index is
recovered from the seat's height, which gives how far back into the rake and
therefore how far under the roof a spectator sits; skylight falls off with that,
direct sun reaches the open front rows only, and the floodlights carry the bowl
at night. The pitch is also treated as what it is — a large bright reflector
filling the lower half of every spectator's view — which is why a covered stand
still reads as people rather than as a black band.

Measured after: night crowd front rows **91**, back rows **39**, floodlit pitch
**120**. Afternoon: front **128**, mid **58**, pitch **157**. The crowd now sits
under the pitch in both.

### 4.3 Ambient irradiance was flattening every figure

Diffuse ambient called `envAt(N, 1.0)`, and roughness 1.0 narrows that lookup's
sweep to 0.30 — so the sky gradient was evaluated across only `t = 0.35..0.65`
regardless of which way the surface faced. The ambient term was very nearly
*constant* over a whole figure. Since the camera sits behind the players and the
sun in front of them, that constant was most of what lit them, and they came out
as cut-outs: a red shirt with no top-to-bottom falloff.

Split into `envIrradiance(N)` (sweep 0.70 — the effective sweep of a
cosine-weighted hemisphere integral over a linear gradient) for diffuse, and
`envAt(dir, rough)` for specular where the narrowing is correct.

### 4.4 The sun now moves with the time of day

There was one hard-coded light vector for every match in the game, so a golden
hour kick-off and a midweek afternoon threw identical shadows in identical
directions. `sunEl` / `sunAz` are now per-condition (`js/core.js`), `LIGHT` is
mutated in place by `setSun()` so both renderers and the canvas shadow
projection pick it up, and the shadow ortho widens with the sun's cotangent
because a fixed 22 m box clips every shadow at a 10° sun.

Afternoon is unchanged at 40°. Golden hour is at 9°, which gives the long angled
player shadows visible in `shots/gh-band3.png`.

### 4.5 A stand shadow, and an honest note about it

`standShadow()` inside `shadowAt()` intersects the ray to the sun against the
roof's inner lip — a ray-box exit against a rounded rectangle at known height,
derived from `BOWL` rather than dialled in. It lives inside `shadowAt()` so the
ground, players, ball and goal frame all pick it up from call sites they already
have.

It is correct and it is running. **It is also barely visible, and that is
geometry, not a bug.** The lip sits 15.2 m outside the touchline and 16.8 m up,
so at 40° the shadow lands 3 m short of the pitch entirely. It only reaches the
grass below about 11°, and at 11° the sun's contribution to *horizontal* turf is
`dot(up, L) ≈ 0.19`, so removing it changes the turf very little. It shows as a
soft tonal fall in the foreground at golden hour and it will matter in wide and
celebration cameras. It is not the televised shadow band across the pitch, and
with this bowl and this camera it cannot be — the shooting camera sees only about
±7 m of pitch width.

One real bug was found and fixed here: the penumbra was scaled by ray length with
a coefficient of 0.055 and then again by 1.6, giving a 9.4 m half-penumbra in
height at a 9° sun — a 112 m-wide gradient that dissolved the edge and quietly
dimmed the whole pitch by ~50% of its sun term. The sun is 0.53° across, so the
coefficient is 0.0092 and it is not a free parameter.

### 4.6 The frame had no grade

`sat` and `contrast` were both 1.00 in daylight — the picture came straight out
of the highlight shoulder with no shaping. Measured: turf 157, white shorts 245,
and a kit red whose saturation had fallen from 0.769 at source to **0.50** on
screen. Bright, pastel and low contrast.

An ambient probe that reaches everywhere is what causes it: every surface gets
lifted toward the sky colour, so shadows are never dark and nothing is ever fully
saturated. That is correct lighting and the wrong picture, and the place to fix
it is the curve.

Contrast also ran *after* the shoulder, which undoes the shoulder's whole job —
a highlight rescued to 0.90 gets pushed back over 1.0 and clips again. Reordered
to run before it, so the curve is free to push highlights over 1.0 with the
shoulder downstream to catch them.

Measured after: kit red saturation **0.729** against 0.769 at source.

### 4.7 Turf and silhouette

`grass1`/`grass2` were `#4fbf68` / `#3b9751` — mint greens that, lifted by the
ambient probe, came out as traffic-light green. Deepened and cooled to `#43a259`
/ `#2f7f45`, which also gives the mow stripes somewhere to go: a stripe on a
nearly-clipped green has no headroom to be lighter in.

The shorts were 0.345 m long with the taper *widening* downward (1.02 at the
waist to 1.13 at the hem). A 35 cm garment that gets wider as it descends is a
skirt, and that is what it read as — the hem reached mid-thigh and the legs never
separated. Now 0.275 m, tapering in to the hem.

### 4.8 Two self-inflicted parse bugs

Twice I put a backtick inside a comment *inside a shader template literal*,
which terminated the literal early and shifted every literal boundary after it —
presenting as `SyntaxError: Unexpected identifier` plus an unrelated-looking
`'vRough' : undeclared identifier` from a shader hundreds of lines away. There
are now no backticks anywhere in `js/render.gl.js` outside the template
delimiters themselves.

---

## 5. Verification

- `T.balance(300)` after touching `js/core.js`: every level winnable, win rates
  7.7 / 3.0 / 4.3 / 15.0 / 2.3 / 22.7 / 10.7 / 4.7 / 2.0 / 3.0 … No regression.
- Canvas fallback (`?gl=0`) renders correctly with the new turf colour and the
  condition-driven sun.
- Frames captured and inspected: `shots/pbr-fixed.png`, `crowd2-afternoon.png`,
  `crowd-night.png`, `sun-goldenHour.png`, `gh-band3.png`, `turf-wide.png`,
  `form.png`, `canvas-fallback.png`.
- Diagnostic passes used and then removed: roughness as greyscale, the three
  lighting terms split into RGB, `sign(dot(N,V))`, and the world normal as
  colour. The last of those is what actually found the winding bug.

Note for anyone doing this again: **`shots/dbg-nrm.png` and `shots/dbg-ndv.png`
are worth keeping.** A normal-visualisation pass found in one frame what four
rounds of reasoning about the vertex shader did not.
