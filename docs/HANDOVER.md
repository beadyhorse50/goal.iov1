# goal.io — project handover

This is the full picture: what exists, what is verified, what is broken, and
what to do next. A new chat should read `../CLAUDE.md` first, then this.

---

## 1. What this is

**goal.io** — a swipe-to-shoot football game in the Score! Hero mould, built as
an installable mobile PWA. Real ball physics, a career of 15 match scenarios,
a hand-written 3D renderer, and a skeletal animation system.

Plus a **separate deliverable**: four procedurally generated, rigged, textured
footballer models in glTF/GLB, ready for Unity.

There is **no game engine and no Node** in this environment. Python 3.14 and a
browser are all that is available. Everything was hand-written on the standard
library and plain JS. Do not assume npm, Unity, Blender, numpy or Pillow exist.

---

## 2. Where everything is

Everything belonging to the game is inside the `goal.io/` folder, which is also
the git repo root. Nothing about it lives above that folder.

```
goal.io/                        the game (open index.html, or serve it)
  index.html                    shell, all CSS, HUD + overlay markup    (588 ln)
  js/core.js                    pitch geometry, physics constants,
                                career/level data, CONDITIONS, save     (389 ln)
  js/sim.js                     ball flight, players, defender + keeper
                                AI, rewind, cue queue, celebration      (859 ln)
  js/anim.js                    skeletal animation: rig, clips, blending (571 ln)
  js/audio.js                   audio engine: buses, reverb, crowd bed   (496 ln)
  js/render.js                  canvas renderer — camera, stadium,
                                players, weather, FX. The fallback     (3432 ln)
  js/gl.js                      WebGL2 context, programs, FBO helpers   (449 ln)
  js/render.gl.js               WebGL renderer — the default           (2888 ln)
  js/post.gl.js                 post chain: bloom, DoF, motion blur,
                                highlight shoulder, grading             (422 ln)
  js/fx.js                      the feel layer: time, shake, cues, goal  (413 ln)
  js/game.js                    input, swipe->kick, loop, career, UI    (1064 ln)
  js/res.js                     resolution / device scaling             (254 ln)
  js/test.js                    headless balance harness — NOT loaded    (92 ln)
  js/shot.js                    headless capture harness — NOT loaded   (136 ln)
  js/shotgl.js                  GL capture harness — NOT loaded         (182 ln)
  js/render.backup.js           pre-stadium-rebuild copy of render.js
  sw.js, manifest.webmanifest   PWA offline + install
  icon-192.png, icon-512.png    install icons
  devserver.py                  dev server that accepts screenshot POSTs
  ui-preview.html               all six UI screens, generated from the real CSS
  README.md                     player-facing + technical docs
  CLAUDE.md                     entry point for a new chat — read first
  docs/HANDOVER.md              this file
  docs/REVIEW.md                critique — what is closed, what is open
  docs/GRAPHICS-AUDIT.md        what the renderer can and cannot do
  docs/WEBGL.md                 the default renderer and its traps
  docs/UNITY-MIGRATION.md       full migration plan, effort estimates, risks
  .claude/launch.json           goalio-dev (8124), goalio-gl (8125)
  shots/, shots-gl/             captures — gitignored, regenerable
  before-after.html             polish-pass comparison — gitignored, large
  overhaul.html                 overhaul-pass comparison — gitignored, large
```

One level up, outside the repo and not part of the game:
`football-characters/` — the Unity-ready character models (unchanged),
the other half of `docs/UNITY-MIGRATION.md`.

### Running it

From inside `goal.io/`:

```bash
python -m http.server 8123
```

For development use `devserver.py` instead — it sends `Cache-Control: no-store`
and accepts `POST /` with `{name, png}` to write a PNG into a shots folder,
which is how every screenshot in `shots/` was made:

```bash
python devserver.py . shots 8124
```

`.claude/launch.json` defines this as `goalio-dev` on port 8124, and
`goalio-gl` on 8125 writing into `shots-gl/`.

---

## 3. Current state, honestly

### Verified working
- **15/15 levels beatable**, 14/15 three-starable in 300 random tries
  (level 4's chip bonus needs a few thousand tries to hit by chance, it is not
  a lock-out — `T.solve(3, 4000)` finds it).
- **Frame times** at phone resolution, desktop, median of 3 runs per level.
  Identical code measured **4.6–9.1 ms** on one pass and **7.4–14.2 ms** on
  another, so the honest figure is a range, not a number: roughly **7–14 ms**
  depending on the machine's thermal state, with level 1 cheapest and levels 5
  and 10 (wide camera, more crowd) dearest. Do not quote a single figure from
  this environment — **measure on a phone.**
- Chip, rewind, career flow, all UI screens reachable, no console errors
  through a full menu → pre-match → play → goal → result cycle.
- Four GLB characters still pass full glTF 2.0 validation.

### Overhaul pass — what changed
Full detail in `REVIEW.md`. Summary:
- **UI rebuilt from scratch.** New palette (navy / electric blue / gold), 8px
  spacing scale, fixed type ramp, one card treatment everywhere, shield crests,
  56px buttons with inner highlight and travelling specular, condensed type
  stack with `font-stretch` so the identity survives on iOS.
- **New screens:** settings (audio + haptics toggles, two-step progress reset),
  and difficulty pips on every match tile derived from measured win rates with
  the three outliers marked red and warned about in the pre-match brief.
- **Onboarding:** a guided first touch — a ghost stroke drawn in world space on
  the grass, looping until the player touches. Runs once, ever.
- **Failure feedback:** a post-mortem overlay on every miss — the actual flight
  line, the keeper's committed dive arc, and the miss distance in centimetres —
  plus a composed **miss camera** that frames the goal and the ball's end point
  together, solved from the actual spread.
- **Characters:** per-player identity from the squad number (four hairstyles,
  build variation, brow/jaw/eye structure), a real face (brow, eyes with catch
  lights, nose, mouth), boots with soles and flash colours, athletic torso taper.
- **Shadows split** into an ambient-occlusion contact pool and a graded cast
  silhouette that softens with the light.
- **Cinematic camera beats:** a fast lens push on a strike, a slower push plus
  lateral drift on a pass.
- **Net** rebuilt as a translucent volume with a denser back panel, sag and
  rounded posts.
- **Animation went from 7 clips to 13.** Added `chip` (its own shape, not a
  scaled drive), `receive` (a first-touch cushion — the ball used to teleport to
  the receiver's feet with the player doing nothing), and `celebrate2`/`3`
  chosen per squad number. Strike, chip and pass are now **amplitude-scaled by
  the power of the kick** via `Animator.amp` / `scalePose`, so a tap and a
  30 m/s drive no longer play identically. Idle and brace carry a per-player
  phase offset so a group stops breathing in unison.
- **Goal replay.** `sim.js` keeps a tape of the whole attempt — ball plus every
  player's position, facing, velocity and stride phase. Playback writes it back
  onto the live objects so the replay gets the real animation, kit and lighting
  for the cost of an array. Runs at 0.45x from a low angle behind the near post
  with a broadcast banner, then holds on the final frame.

### The WebGL renderer is now the default
See `WEBGL.md` for the full picture. It draws the world, the players and
a post chain (bloom, depth of field, reprojected motion blur, highlight
shoulder, grading, vignette, grain). Measured interleaved in one page load with
GPU completion forced, it is **faster than the canvas renderer on every level**
(7.2/6.0/6.2 ms against 8.2/11.1/10.2 ms on levels 1/5/10) while drawing far
more. The canvas renderer is intact and is the automatic fallback; `?gl=0`
forces it.

That closes the "structural ceiling" this document used to end on. PBR-ish
per-pixel lighting, a real shadow map, true post-processing and 18,000
individual spectators are all in. What is still out of reach is authored
content: photographic textures and recorded commentary are asset problems, not
renderer problems.

### Known broken / unfinished (in priority order)
1. **The GL bowl is one tier.** The canvas stadium has two tiers plus a facia
   with banners, so the canvas architecture is still richer. This is the last
   place the old renderer wins.
2. **Performance is probably fine and genuinely unverified.** See the range
   above. Run-to-run variance on this machine is up to 5 ms for identical code,
   which is wider than most of the optimisations that were made — so treat any
   single measurement here with suspicion and **profile on a device.** The crowd
   is still the dominant cost; stride-thinning was the win that got it there.
3. **Service worker still unverified in a real browser.** It is now
   network-first and correctly versioned (see section 4), but the embedded dev
   browser blocks SWs so nobody has watched it update in the wild.
4. **No half-time or full-time sting.** Kickoff card, goal sequence, goal
   replay and the miss post-mortem all exist now; the rest of the broadcast
   furniture does not.
5. **No commentary or PA.** Honest gap — closing it properly needs recorded
   voice, which a synth cannot fake, so it is a content problem rather than a
   code one.
6. **Player close-ups are still weak.** At gameplay distance they read fine.
   Up close: the near shoulder cap stands slightly proud, hands are barely
   visible with arms down, and there is a faint seam at the knee when it bends
   past ~0.6 rad (the thigh inside the shorts is deliberately not built).
7. **No content beyond the 15-match career.** Nothing to return to on day 7.

---

## 4. Architecture, and the traps

### The simulation is separate from presentation — keep it that way
`sim.js` never reads anything in `render.js`. This still holds. Two things were
added that could look like violations and are not:

- **`world.cues`** — a queue the sim pushes named events onto (`bounce`,
  `post`, `save`, `block`, `deflect`, `net`). The sim reports *that a thing
  happened*; it has no idea what any of it sounds or looks like.
  `FEEL.drainCues()` turns cues into sound, shake and particles.
- **`World.celebrate()`** — moves the scorer and team-mates after a goal. The
  level is already decided, so this cannot affect balance, and positions are
  simulation state by definition. Without it a goal landed on a freeze-frame
  of eleven statues.

### FEEL owns time — do not add a second time scale
`js/fx.js` decides how fast the world runs. Hit-stop, the goal slow-motion ramp
and normal play all come out of `FEEL.stepTime(dt)`. If you add another place
that scales `dt`, they will fight. `world.slowmo` is now only the sim *asking*
for drama; the director chooses the curve.

### Physics is tuned against real measurements — do not casually retune
- Air drag `a = 0.010·v²`, rolling decel 2.3 m/s², Magnus `a = 0.42·spin·v`.
- A 20 m/s ground pass runs ~48 m. A driven shot first bounces ~21 m out. A
  chip peaks near 7 m.

### The keeper is deliberately fallible
It reads the flight **as if it were straight for the first 0.45 s**. Once
committed, the dive is ballistic. **Do not "improve" the keeper's prediction** —
it will silently make every level unwinnable.

### Animation sign convention — the one real trap
In `anim.js`, pitch rotates about a joint's own right axis and bones extend
along **−U**, so a positive pitch swings a bone's *tip forward*. For the
upward spine chain that means **positive pitch leans the torso backwards**.

Also: the animator's `step()` must be called **every frame** even when the run
clip's clock is overridden by stride phase.

### STRIDE_K is measured, not chosen
`sim.js` advances stride phase by `speed · dt · STRIDE_K`, and `STRIDE_K = 4.28`
is derived from the rig, not taste: over one run cycle the planted ankle is
within 4 cm of the ground for 22% of the cycle and sweeps 0.441 m backwards at
2.033 m per clip-second, so the body must cover 2.03 m per cycle for the foot
to stay stuck to the turf. The old value of 1.5 gave 5.8 m per cycle and the
feet skated at two thirds of running speed. **If the run clip's leg swing is
re-authored, re-measure this** — it is a property of the clip.

### Every colour helper must go through parseCol()
`render.js` has `shade()`, `mixHex()` and `gradeGrass()`, and they all *return*
`"rgb(r,g,b)"` strings. They used to *accept* only `"#rrggbb"`. The moment one
was fed another's output, `parseInt` produced `NaN`, canvas rejected the
fillStyle and silently kept whatever colour it last held. This cost real time
twice: once as white shorts rendering solid black, and once as the entire pitch
rendering black in the foreground and white in the middle distance — with no
error anywhere. `parseCol()` accepts both forms. Use it.

### Rendering traps already hit and fixed — do not reintroduce
- **No z-buffer.** Depth is a painter's algorithm with a manual bias. Geometry
  that is permanently hidden is simply not built.
- Every face of a player queues into **one buffer** and sorts together.
- **Garment bias must stay below the torso's 0.022.** Both arms get the same
  bias, so pushing sleeves further forward makes the *far* sleeve beat the
  chest — the exact "far arm paints over the torso" failure the buffer exists
  to prevent.
- Adjacent canvas polygons antialias against each other; while drawing a
  player every fill is also **stroked in its own paint**.
- The camera axis is **frozen outside the aim phase**.
- **Clip to the play area BEFORE applying shake.** Shaking first rotates the
  clip region itself and walks the visible frame off the drawn area, showing
  bare canvas in the corners. `OVER` is the overscan the backdrop paints past
  the viewport to cover it.
- **Nothing may be drawn on the grass in front of the carrier.** The camera
  sits behind them, so ground in front projects into the same screen area as
  their body, and anything drawn after the figure paints over the shirt. A set
  of direction chevrons was tried there and read as amber diamonds punched
  through the kit.
- **The depth haze must stop at the horizon.** It is atmosphere between the
  camera and the stands; nothing in the foreground is behind any of it. Running
  it past the horizon laid a grey wash over the pitch and turned night matches
  into fog.
- **Exposure belongs to `drawGrade()`, not to individual objects.** Grading only
  the turf produced a black pitch with brightly lit players standing on it,
  because players draw from fixed palette colours.

### The service worker is network-first now, on purpose
The old one was cache-first with a fixed cache name, so the cache was only ever
repopulated when `sw.js` itself changed: a player who opened the game once kept
that build forever and every later update was invisible to them. It also cost
hours of development time, because edits to the renderer silently never reached
the page — **if a change appears to have no effect, check for a controlling
service worker first.** Code and markup are now network-first with a 1.8 s
timeout falling back to cache; icons stay cache-first. **Bump `VERSION` in
`sw.js` on release, and add any new `js/` file to `ASSETS`** or the game will
break offline while working perfectly online.

---

## 5. How to verify anything

Two harnesses, neither loaded by `index.html`. Inject from the console.

**`js/test.js` — simulation.** The safety net.

```js
var s=document.createElement('script'); s.src='js/test.js'; document.head.appendChild(s);
T.balance(400)      // brute-force every level: win rate + best stars
T.ballRun(20,0,0)   // one ball flight: range, apex, lateral deviation
T.solve(9, 4000)    // hammer a single level
```

**Always run `T.balance()` after touching `sim.js` or `core.js`.** A level that
drops to 0 % win rate is unwinnable. Note that low-win-rate levels (10, 13, 15
sit at 1–3 %) can read 0 % at 200 tries purely by sampling — confirm with
`T.solve()` before believing a regression.

**`js/shot.js` — pictures.** The dev browser runs the page in a hidden tab, so
`requestAnimationFrame` never fires and the game loop never runs. This drives
the loop by hand and POSTs frames to `devserver.py`.

```js
var s=document.createElement('script'); s.src='js/shot.js'; document.head.appendChild(s);
SHOT.grab("aim.png", {level:0, w:390, h:844, t:0.6})
SHOT.seq("goal", {level:0, kick:{power:.95, mode:1, aimX:4.5, curve:-0.3},
                  at:[0.86, 1.0, 1.5, 2.4, 3.1]})
SHOT.probe()        // phase, ball, camera, touches
```

To inspect something small, crop and zoom in-page rather than saving the whole
frame — `Read`ing a 2 MP screenshot downscales it and hides exactly the sort of
artefact you are looking for. Draw a sub-rect of `cvs` into a small canvas with
`imageSmoothingEnabled = false` and POST that.

**Verify visually, and instrument rather than guess.** Both of those earned
their place again in this pass: the amber diamonds on the kit were diagnosed by
recolouring every skin tone magenta and observing that the diamonds *didn't*
change; the black pitch was found by disabling render passes one at a time and
reading pixels with `getImageData`. Two confident theories about each were
wrong before the measurement.

Camera smoothness has its own test — trace `Cam.px/py/pz` across
aim → strike → flight → goal and measure the frame-to-frame change in speed.
Target ≤ 0.07 m/frame².

---

## 6. What was done in the polish pass

For context on why the code looks the way it does.

**Audio (`js/audio.js`, new).** Was six synth blips. Now a real engine: dry/wet
buses through a generated stadium impulse response into a compressor, a
continuously running crowd bed built from pink noise plus 900 baked claps with
three LFOs riding it, and a sidechain duck every transient punches through.
Kicks are three layers (leather, body, thump). The roar is a four-second noise
swell with 2,600 claps and a filter opening upward. A stadium tail behind a
kick is what makes it a kick in a stadium.

**Feel (`js/fx.js`, new).** One time director (hit-stop + eased slow-motion
ramps), trauma-based camera shake decaying by its square, a real lens zoom
punch, vignette and chroma pulses, ball squash with recovery wobble, crowd
flash bulbs, and the goal timeline (freeze → slow-mo → kinetic GOAL → bulbs →
confetti → ease out).

**Match presentation.** Kickoff card, animated scorebug flip, per-letter goal
typography, staggered screen transitions, spring press states on everything
tappable, travelling specular on primary buttons, result stars landing one at a
time with rising pitch, counting stat tiles.

**Stadium.** Vomitories rebuilt twice — a painted dark quad read as a sticker
and a modelled recess read as a grey chevron, so they are now gangways: bare
steps up the rake with handrails and one dark notch at the foot. Crowd has
home/away/neutral blocks (away wedge deliberately off-centre, or the ground
looks like the opposition's), banners on the facia, heads and shoulders above
18 px, and a shaded roof underside.

**Turf.** Twenty mow stripes with *opposing* sheen per band (adjacent bands
catch light from opposite ends — this is most of the effect), depth grading
toward the sky's own horizon colour, and a directional key light using the
light vector nothing used to read.

**Conditions (`CONDITIONS` in core.js).** Six: afternoon, golden hour,
overcast, rain, night, night rain, assigned per level as an arc from Sunday
league daylight to European nights. Layered screen-space rain, perspective-
correct ground splashes, wet sheen, and a whole-frame colour grade.

**Animation.** Keeper set position (bouncing, hands wide) instead of the idle
clip. Two asymmetric dive clips instead of one symmetrical one — rolled onto
its side, a symmetrical body is a starfish, and no amount of roll tuning fixes
that. Goal celebration: the scorer peels away, the team converges, the camera
follows them.

**Cameras.** The goal camera is two composed beats. Framing the whole goal
from the front cannot work in portrait — to fit a 7.3 m goal across a 390 px
frame you stand 16 m back, and at 16 m the 15 m stand behind it fills two
thirds of the screen. So beat A goes tight and off-axis on the ball in the net,
and beat B stands off the *scorer* and opens out.

**Performance.** The crowd was 7.4 ms of a 13.9 ms frame, all of it canvas
state changes. Batching rectangles into one path per colour made it *worse*
(9.7 ms). What worked: pre-sort the crowd list by colour once at startup so
`fillStyle` changes a couple of dozen times a frame, keep `fillRect` on its
fast path, and thin distant banks by *stride* rather than by rejecting people
inside the loop.

---

## 7. What to do next

### The structural ceiling — read this before promising AAA

The renderer is a hand-written rasteriser on a **2D canvas**. There is no GPU
pipeline. This pass took the canvas renderer a long way — lighting direction,
atmospheric depth, colour grading, weather and a whole-frame grade are all in
now — but the following are still **not reachable** without WebGL:

- PBR materials, real texture sampling on geometry
- Real-time shadow mapping (current shadows are projected silhouettes)
- True post-processing (bloom, DoF, colour grading with real HDR, motion blur)
- Weather that *lights* the scene rather than being composited over it
- Facial detail at gameplay distance
- Crowds an order of magnitude larger, which is what would finally fix the
  performance ceiling rather than shaving milliseconds off it

A **raw WebGL renderer** (no library, still dependency-free and offline-capable)
unlocks all of it in one move. It is a rewrite of `render.js` only — `sim.js`,
`anim.js`, `core.js`, `fx.js`, `audio.js` and `game.js` are unaffected, and the
art direction decided in this pass (stripe contrast, wear layout, colour ramps,
condition tables, light vector) ports directly as shader parameters rather than
being thrown away.

**Do it behind a flag alongside the canvas renderer**, and switch when it beats
what exists. A partial WebGL renderer looks worse than a finished canvas one
for a long stretch, and there is now a finished canvas one to lose against.

### Recommended order

1. **WebGL renderer**, behind a flag. Everything else is now downstream of it.
2. **Crowd bitmap caching** if you stay on canvas — re-render the crowd every
   2nd or 3rd frame and blit it. Biggest remaining perf win.
3. **Loading screen**, and verify the service worker in a real browser.
4. **Replay banner and half-time stings** to finish match presentation.
5. **Player close-up work** — shoulder cap, hands, knee seam.

---

## 8. Style notes for whoever continues

- Match the existing code's voice: plain functions, `var`, comments that
  explain *why* not *what*, and a note wherever a non-obvious trap was fixed.
  Several comments in `render.js` now record approaches that were tried and
  removed; leave those in, they are the most useful thing in the file.
- Verify visually. Numbers passing is not the same as it looking right.
- When something looks wrong, **instrument the exact frame** rather than
  guessing. In this pass the amber diamonds, the black pitch and the crowd
  performance regression each had a confident wrong theory before measurement.
- Do not trust that an edit reached the page. Check for a service worker.
