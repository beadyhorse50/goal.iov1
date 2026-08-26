# goal.io — the WebGL renderer

The renderer. **It is the default now.**

**Turn it off:** `?gl=0` in the URL, or `GLR.off()`. The canvas renderer is
still complete and still there, and `boot()` falls back to it automatically if
WebGL2 or any shader program fails — so a device that cannot run this gets a
working game rather than a black screen.

It became the default when it started winning on both axes at once. Measured
interleaved in a single page load with a `readPixels` per frame to force GPU
completion:

| Level | Canvas | WebGL |
|-------|--------|-------|
| 1     | 8.21 ms | **7.18 ms** |
| 5     | 11.06 ms | **6.01 ms** |
| 10    | 10.24 ms | **6.20 ms** |

and the GL frame is doing considerably more while being cheaper: the players,
18,000 individually simulated spectators, a real shadow map, and a full post
chain, against a canvas frame with a stride-thinned crowd and no post at all.
Interleaving is not optional — this machine moves up to 5 ms run to run for
identical code, so comparing two page loads compares thermal states.

---

## 1. Files

```
js/gl.js          device layer: context, shaders, buffers, mat4, textures,
                  colour/depth render targets, M4.invert
js/post.gl.js     the post chain: bright pass, bloom, DoF, motion blur,
                  highlight shoulder, grade, vignette, grain
js/render.gl.js   the renderer: sky, turf, bowl, crowd, goal, ball, trail,
                  PLAYERS, and the grade that drives the post chain
js/shotgl.js      capture harness — NOT loaded by index.html
```

`index.html` gains two `<script>` tags, `sw.js` gains the two files in
`ASSETS` and a `VERSION` bump. Nothing else in the project was edited.

## 2. How it attaches, and why that way

**It does not touch `js/render.js`.** Every world pass in there is a plain
global function, so `render.gl.js` overwrites the ones it takes over with
no-ops and wraps `renderWorld()`:

```js
TAKEN = [drawSky, drawStadium, drawDepthHaze, drawPitch, drawFloodPools,
         drawGrain, drawRings, drawGoal, drawCornerFlags, drawBall, drawGrade]
```

The originals are kept in `ORIG` and `GLR.useCanvas(true)` puts them back, so
both renderers can run in one page load. That is not a convenience — see §5.

The frame is two layers:

```
#gamegl   WebGL: sky, bowl, crowd, turf, goal, net, ball, trail, shadows
#game     2D:    players, aim, post-mortem, FX, speedlines, rain, offscreen
DOM       vignette, kinetic type, HUD
```

**The players are still on canvas.** That hybrid is deliberate. A part-finished
WebGL renderer loses to a finished canvas one for a long stretch, and the way
not to lose that bet is to hand it the pitch first and keep the actors on
canvas until the skinned path beats what it replaces.

Everything tuned in the canvas renderer is reused, not rewritten: `Cam` and
`cameraFollow()`, `CONDITIONS`, `COL`, `ADS`, `screenToGround()`, `VP`, `LIGHT`,
and the whole FEEL layer. `FEEL.zoomMul()` and `FEEL.cinePush()` drive the GL
projection by converting `Cam.F` back into an angle, so the zoom punch and the
cinematic push work with no extra plumbing. Camera shake is applied in clip
space so both layers move as one picture.

## 3. What it does that the canvas renderer cannot

- **A depth buffer.** No painter's bias, no manual sort, no "geometry that is
  permanently hidden is simply not built".
- **A shadow map.** The ball's shadow is cast geometry through a depth texture
  with hardware PCF, not a projected ellipse. It separates from the ball
  correctly when the ball is in the air.
- **Pitch markings as analytic distance fields.** Every line is a distance in
  metres, antialiased by `fwidth`. Correct from any camera, no per-line quads.
- **18,000+ individual spectators** in one instanced draw call, each with a
  head, shoulders, skin tone and shirt, bobbing on its own phase. The canvas
  crowd's ceiling was a few thousand blocks and it cost 7.4 ms of a 13.9 ms
  frame.
- **Fog, exposure and colour temperature per fragment** rather than as
  full-frame fills over the finished image.
- **Floodlight pools in world space.** The canvas pools are screen-space radial
  gradients, so they slide across the turf as the camera moves. These are
  bolted to the pitch.

## 4. Players, and why they are not skinned

Players are in GL. The hybrid seam is gone: they are in the same depth buffer as
everything else, they cast into the shadow map, and every post pass applies to
them.

They are **not** a skinned mesh, and that was a deliberate call. `solveRig()`
already produces joint frames on the CPU, so each bone becomes one instance of a
unit tapered cylinder and each joint cap one instance of a sphere — about 26 limb
instances and 9 spheres per player, so a full squad is three draw calls of a few
hundred instances. Skinning matters when vertices are weighted across joints;
these are jointed solids, which the canvas renderer already established read
correctly at this camera distance. Rebuilding them as a weighted mesh would cost
a great deal and change almost nothing on screen.

The head is its own program. A head is the one part that has to carry identity,
and a skin sphere with a hair-coloured sphere on top cannot: the first attempt
stacked a hair sphere at a *smaller* radius than the skull, so it was entirely
inside the head and the player just looked bald. Hair, brow, eyes with catch
lights and mouth are all analytic in head-local space, which the instance basis
provides for free — object X is the head's right, Y its up, Z its facing. Being
per-pixel rather than screen-space marks (the canvas approach) means it stays
correct at any zoom and rotates with the head instead of sliding across it.

## 5. What is still not done

1. **Second tier.** The canvas stadium has two tiers, a facia with banners and
   an upper bank of seats. The GL bowl is one deep tier plus a roof. Side by
   side the canvas architecture is still richer.
2. **Rain, splashes, grain** are still canvas passes over the top, composited
   rather than lit by the scene.
3. **Corner flags, rings, post-mortem lines** are canvas or missing.
4. **Aim line and FX** are canvas, which is correct — they are UI, not world.
5. `preserveDrawingBuffer: true` is on so frames can be read back. Turn it off
   for a release build.

## 5a. The post chain

`js/post.gl.js`. The scene renders into an RGBA16F target and the chain turns it
into the finished picture:

```
bright pass (half res, soft knee)  ->  blur  ->  tight glow
                                    downsample -> blur -> wide glow
scene -> downsample -> blur                    -> depth-of-field source
composite: motion blur, DoF, bloom, shoulder, grade, vignette, grain
```

Three things in here are worth knowing before touching it.

**RGBA16F is not colour-renderable in plain WebGL2.** `texImage2D` accepts the
format without complaint and the framebuffer then never completes — no GL error,
just a target that quietly fails, so the post chain disables itself and the
picture merely looks un-graded. `EXT_color_buffer_float` has to be enabled at
context creation, before anything makes a target. `GLX.init` does it now.

**Do not run a full filmic tonemap over this scene.** ACES and friends assume
scene-referred input where mid-grey sits near 0.18; these shaders output
display-referred colour, tuned to be the final image. Running ACES over that is
double-tonemapping and it is not subtle — measured, it lifted the turf's red
channel from 86 to 140 and cut saturation from 0.58 to 0.32, and the whole frame
went milky. What is wanted is a **highlight shoulder only**: identity below 0.74,
asymptotic to 1.0 above. That fixes the blown-out hoardings the pre-release
review flagged (a crowd highlight that clipped at 255 now rolls off to 236) and
leaves midtones exactly as the shader intended.

**Motion blur is reprojected, and reprojection cannot tell a pan from a cut.**
Both put a large screen-space velocity on every pixel, and on a cut the result is
the entire frame smeared into unreadable streaks. This game cuts twice on every
attempt — into the goal camera's first beat and into the miss camera. Cuts are
detected geometrically in `runPost()` (eye moved more than 2.2 m, or the forward
vector turned more than 0.010) and the blur is skipped for that frame.

Depth of field focuses on **the ball**, not on the camera's centre distance. The
ball is what the player is tracking, so keeping it sharp while the crowd behind
goes soft reads as a long lens following the action; focusing on frame centre
would blur the ball whenever it left the middle of the screen.

`GLR.dbg.post = 0` renders straight to the back buffer, which is how you tell a
grading problem from a geometry problem. `GLR.dbg.players = 0` hands the actors
back to the canvas layer.

## 6. Verifying it — and the one genuinely good surprise

The handover records that the dev browser never composites, so
`requestAnimationFrame` never fires and DOM screenshots are impossible. That is
still true. **But WebGL readback does not need a compositor.** `gl.readPixels`
and `toDataURL` on the GL canvas both work in a hidden tab, which makes this
renderer *easier* to verify in this environment than the canvas one.

```js
// inject js/shot.js first — GSHOT uses its stepper
var s=document.createElement('script'); s.src='js/shot.js'; document.head.appendChild(s);
s=document.createElement('script'); s.src='js/shotgl.js'; document.head.appendChild(s);

GSHOT.check()                  // context, every program's link state, gl.getError()
GSHOT.peek(5)                  // raw pixels out of the drawing buffer
GSHOT.grab("f.png", {level:0}) // composite both layers and POST
GSHOT.zoom("net.png", {rect:[0.3,0.3,0.4,0.3], scale:3})
GLR.dbg.crowd = 0              // disable any pass: sky stand roof crowd ground posts ball net
GLR.useCanvas(true)            // swap renderers inside one page load
GLR.stats()                    // spectator count, bowl rows
```

Serve with a second dev server so the two sessions do not fight over
`shots/`:

```bash
python goal.io/devserver.py goal.io goal.io/shots-gl 8125
```

`.claude/launch.json` has this as `goalio-gl`.

## 7. Measured

Interleaved GL/canvas passes in a single page load, five passes of forty frames
each, median of medians, forced to GPU completion with a `readPixels` per
frame. Interleaving is not optional: this machine moves up to 5 ms run to run
for identical code, so comparing two page loads compares thermal states.

| Level | Canvas median | WebGL median |
|-------|---------------|--------------|
| 1     | 6.5 ms (5.5–9.4)  | 6.6 ms (4.8–7.4)  |
| 5     | 13.3 ms (12.1–14.2) | 9.4 ms (7.3–11.5) |
| 10    | 13.7 ms (12.5–15.4) | 8.9 ms (8.2–9.9)  |

Read that carefully:

- **Both numbers include the canvas player pass**, because the GL path is a
  hybrid. GL is not being measured alone.
- GL draws **18,492 spectators** where the canvas crowd is thinned by stride.
- At level 1 the ranges overlap and the two are equal.
- These are desktop numbers from a machine with an Adreno X1-45. **Measure on a
  phone before believing any of it.**

Night grade was checked by sampling, not by eye: turf, crowd and sky all land
within about 10% of the canvas renderer, GL slightly darker. Day turf luminance
matches within 4% at three of four sample points. Both times the eyeball read
("the GL night looks like daylight", "the GL turf is brighter") was wrong and
the measurement corrected it.

## 8. Traps already hit — do not reintroduce

- **The stand mesh was wound inside-out and every face was culled.** It did not
  look like a culling bug; it looked like a stand that had failed to build, and
  the pixels behind it were the ground's apron colour. Found by reading pixels
  and comparing them against every colour in the shader, after two confident
  theories (fog, a dead shader branch) were both wrong. `quad()` now documents
  its winding.
- **Advertising board text renders mirrored** unless U is negated. The
  perimeter path runs counter-clockwise, so increasing U is left-to-right for a
  camera *outside* the bowl — which is no camera this game has.
- **A motion trail built as one quad per segment stacks.** The trail runs almost
  straight down the view axis, consecutive quads overlap in screen space, and
  additive blending turns a tapering comet into a solid pale bar. It is one
  continuous ribbon with shared edges now.
- **Trail width must be clamped in pixels, not metres.** A fixed world width
  turns the segments nearest the lens into a wedge across the frame. The canvas
  trail clamps to 0.8–16 px for the same reason.
- **A 12 cm line at 60 m is genuinely sub-pixel** and honest antialiasing fades
  it to nothing. Below a pixel, lines widen instead of dimming. Energy is not
  conserved and that is the correct call.
- **Fog must start at a distance.** A flat exponential from the camera hazes the
  goal at 60 m. It is zero across the play area and climbs hard beyond it, which
  is what separates the stands from the pitch.
- **The ground plane must reach past where fog saturates**, or the edge of the
  quad reads as a second horizon.
- **Gangways are an absence of people, not a dark rectangle.** The crowd
  generator skips those columns and the rake shows through. The canvas renderer
  rebuilt its vomitories twice learning the same thing.
- **Attribute locations are bound explicitly** in `GLX.prog` so one VAO can be
  drawn by both the shading pass and the depth-only shadow pass. Without that
  the linker is free to number them differently and the ball's shadow silently
  draws garbage.
- **Sample textures outside non-uniform control flow.** A `texture()` call
  inside an `if` has undefined derivatives, which shows up as the mip level
  popping along the boards as the camera pans.
- **The sky ramp cannot be physically honest.** A camera looking slightly down
  only ever sees the bottom of the elevation range, so all three sky stops have
  to live in the first third of it or the blue never appears.

## 9. Next, in order

1. **Second tier and facia**, to match the canvas architecture. The bowl is the
   last place the canvas renderer is still richer.
2. **Rain and splashes as GL passes**, lit by the scene and depth-tested,
   instead of composited flat over the top.
3. **Mow stripes** are subtler in GL than on canvas. `uBands` is wired; the
   contrast wants raising to match.
4. **Screen-space ambient occlusion.** The depth texture is already there for
   DoF, so the marginal cost is one more pass, and contact darkening between
   players and turf is the last obvious "flat" tell.
5. Turn off `preserveDrawingBuffer` for release.

Add a graphics-quality setting before shipping to a wide device range: the post
chain is the obvious thing to drop on a weak GPU, and `GLR.dbg.post = 0` already
does exactly that.
