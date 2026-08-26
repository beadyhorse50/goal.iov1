# goal.io — the WebGL renderer

A second renderer, behind a flag, alongside the canvas one. This is item 1 on
the handover's "what to do next" list. It is not finished and it is not the
default; it is far enough along to be worth continuing.

**Turn it on:** `?gl=1` in the URL, or `localStorage.goalio_gl = "1"` then
reload. `?gl=0` or `GLR.off()` puts it back. With the flag off, both new files
parse and define their globals and do nothing else.

---

## 1. Files

```
js/gl.js          device layer: context, shaders, buffers, mat4, textures   (~340 ln)
js/render.gl.js   the renderer: sky, turf, bowl, crowd, goal, ball, trail   (~980 ln)
js/shotgl.js      capture harness — NOT loaded by index.html                (~190 ln)
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

## 4. What is not done

1. **Players.** Still canvas. This is the whole remaining job — a skinned mesh
   driven by `anim.js`, instanced. Until then the hybrid shows a seam: canvas
   players draw soft blob shadows next to the ball's hard cast one, and a
   player in front of the ball paints over it.
2. **Second tier.** The canvas stadium has two tiers, a facia with banners and
   an upper bank of seats. The GL bowl is one deep tier plus a roof. Side by
   side the canvas architecture is still richer.
3. **Rain, splashes, grain** are still canvas passes over the top.
4. **Corner flags, rings, post-mortem lines** are canvas or missing.
5. **No post-processing yet** — no bloom, no DoF, no motion blur. The point of
   getting here was to make those reachable; none of them are written.
6. `preserveDrawingBuffer: true` is on so frames can be read back. Turn it off
   for a release build.

## 5. Verifying it — and the one genuinely good surprise

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

## 6. Measured

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

## 7. Traps already hit — do not reintroduce

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

## 8. Next, in order

1. **Players.** Skinned mesh from the `anim.js` rig, instanced, with the ball
   and the players in the same depth buffer. This ends the hybrid and is the
   only thing standing between this renderer and being switchable.
2. **Second tier and facia**, to match the canvas architecture.
3. **Post-processing**: bloom on the floodlights first — it is the cheapest
   thing that reads as production value, and it is the reason for the rewrite.
4. Rain and splashes as GL passes, lit by the scene rather than composited.
5. Then, and only then, consider making it the default.
