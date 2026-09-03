# goal.io — full project briefing

**Paste this whole file into a new Claude session to bring it up to speed.**

If instead you open Claude Code *in the `goal.io/` folder*, you do not need
this: `CLAUDE.md` loads automatically and points at everything below. This file
exists for sessions that start somewhere else — claude.ai, a fresh chat, a
different machine.

---

## 1. What it is

**goal.io** — a swipe-to-shoot football game in the Score! Hero mould. An
installable mobile PWA with **no engine, no build step and no dependencies**:
plain JavaScript, a hand-written WebGL2 renderer, and stdlib Python for tools.

- **Live:** https://beadyhorse50.github.io/goal.iov1/
- **Repo:** https://github.com/beadyhorse50/goal.iov1 (branch `main`, Pages from root)
- **Local root:** `…\VS CODE\NU LONDON\goal.io\` — this folder **is** the git repo root

You drag anywhere on screen to strike; the length of the drag is power, the
curve of the drag is the bend the ball takes. Fifteen authored match scenarios
across three seasons, three stars each.

---

## 2. Environment — read this first, it explains a lot of the design

| | |
|---|---|
| Python | 3.14, plus `pip` 26.2.1 (packages **are** installable) |
| Blender | **5.2.1 LTS**, at `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` — **not on PATH** |
| Node / npm | **Not installed** |
| Browser | Yes |
| `uv` | Installed at `%USERPROFILE%\.local\bin` |

The game and its tools are deliberately dependency-free — that is a design
choice, not a limitation. Blender is used **headless, by script**, as an
offline asset-authoring step whose output is committed.

**Do not propose React, Three.js, React Three Fiber, Tailwind or a bundler.**
There is no Node. The game is already 3D with a working WebGL2 PBR renderer;
porting it would be a from-scratch rewrite of everything except the simulation.

---

## 3. Architecture

Everything is a plain global loaded by `<script>` in `index.html`, in this
order — **the order matters**:

```
res.js  config.bundle.js  core.js  config.js  sim.js  anim.js  audio.js
render.js  gl.js  post.gl.js  kit.js  gltf.js  render.gl.js  skin.gl.js
props.gl.js  fx.js  career.js  game.js
```

| File | Lines | What |
|---|---|---|
| `js/render.js` | 3432 | The original 2D-canvas renderer. **Complete, and the automatic fallback.** |
| `js/render.gl.js` | 2939 | WebGL2 scene: sky, turf, stadium bowl, 18k instanced crowd, goal, ball, trail |
| `js/game.js` | 1236 | Input, swipe→kick, loop, career/UI screens |
| `js/sim.js` | 859 | Ball flight, players, defender + keeper AI, rewind, cue queue |
| `js/post.gl.js` | 714 | HDR post: bloom, DoF, motion blur, **SSAO**, **FXAA**, grade |
| `js/skin.gl.js` | 600 | Skinned, textured glTF players |
| `js/anim.js` | 571 | 17-joint rig solver, 13 procedural clips, blending |
| `js/audio.js` | 496 | Fully synthesised audio — buses, convolution reverb, crowd bed |
| `js/gl.js` | 449 | WebGL device layer: context, shaders, buffers, mat4, targets |
| `js/fx.js` | 413 | The feel layer: time director, shake, hit-stop, goal timeline |
| `js/core.js` | 389 | Pitch geometry, physics constants, career data, save |
| `js/career.js` | 298 | XP, levels, skills, achievements, stats |
| `js/gltf.js` | 277 | GLB loader (skinned **and** static) |
| `js/props.gl.js` | 265 | Corner flags, floodlights, dugouts |
| `js/res.js` | 254 | Resolution budget — targets 4K worth of pixels, adapts down |
| `js/kit.js` | 189 | Paints club kits into a canvas at runtime |
| `js/config.js` | 189 | Applies `config/*.json` over the globals |
| `js/test.js`, `js/shot.js`, `js/shotgl.js` | 410 | Harnesses — **not loaded**, injected from the console |

### The one architectural idea to understand

**New renderers wrap old ones; they never edit them.** `render.gl.js` replaces
`render.js`'s world-draw globals with no-ops, keeps the originals in `ORIG`,
and wraps `renderWorld()`. `GLR.useCanvas(true)` swaps them back *inside one
page load*. `js/config.js` does the same to `core.js`'s data. `js/skin.gl.js`
and `js/props.gl.js` hook the player pass the same way.

Consequence: every layer has a complete, working fallback, and one deleted
`<script>` tag reverts any of it.

**Flags:** `?gl=0` canvas renderer · `?skin=0` primitive players ·
`?props=0` no props · `?aa=0` no FXAA · `?res=2k` lower resolution

---

## 4. Data and configuration

**No game data lives in code.** `js/core.js` still holds the literals as
defaults, but `config/*.json` overrides them at boot.

```
config/pitch.json physics.json conditions.json difficulty.json levels.json
       ui.json audio.json kits.json kit-layout.json progression.json
```

```bash
python tools/config_validate.py      # structure, ranges, pitch geometry; exits non-zero
python tools/config_build.py         # emits config/config.bundle.js
python tools/cms.py                  # content portal on :8130
```

The **build step exists for one reason**: `game.js` boots synchronously and
builds the level grid immediately, so a `fetch()`ed config would arrive after
the first match had already read the old data. The bundle is committed, so a
clone still needs no toolchain.

The CMS refuses to save anything the validator rejects — it writes, validates,
and **restores the previous file on failure**. It includes a drag-and-drop
pitch editor for scenario positions.

---

## 5. How to run and verify — this is the part people waste time on

```bash
python devserver.py . shots-gl 8125      # then open http://localhost:8125
```

**The Claude Code browser pane does not composite frames.** The page runs in a
hidden tab, so `requestAnimationFrame` never fires, the game loop never runs,
and `computer{action:"screenshot"}` **always fails**. The game is not broken
when this happens.

Instead, inject the harnesses from the console and drive the loop by hand:

```js
var s=document.createElement('script'); s.src='js/shot.js'; document.head.appendChild(s);
s=document.createElement('script'); s.src='js/shotgl.js'; document.head.appendChild(s);

GSHOT.grab("f.png", {level:0})                              // composite both layers, POST to disk
GSHOT.zoom("net.png", {rect:[0.3,0.3,0.4,0.3], scale:3})    // crop + magnify
GSHOT.check()                                               // programs, GL errors
SKIN.stats()  PROPS.stats()  CONFIG.report()  GPOST.dbg.showAO = true
```

**WebGL readback works even though screenshots do not** — `gl.readPixels` needs
no compositor. That makes the GL renderer *easier* to verify here than the
canvas one.

### Always run the simulation safety net

```js
var s=document.createElement('script'); s.src='js/test.js'; document.head.appendChild(s);
T.balance(400)        // every level: win rate + best stars
T.solve(7, 4000)      // hammer one level (0-based index)
```

**Run `T.balance()` after touching `sim.js`, `core.js`, `physics.json`,
`pitch.json` or `levels.json`.** A level at 0% is unwinnable. Levels 9, 10 and
13 legitimately sit near 1%, so a suspicious zero at low sample counts needs
`T.solve()` before you believe it — in one session level 8 read 0% at 150
samples and 3% at 4,000.

### Measuring performance honestly

Frame times on this machine vary by **up to 5 ms run-to-run for identical
code**, and under load the spread has been 13 ms. Interleave the two things
being compared *inside one page load* (`GLR.useCanvas`, `SKIN.setEnabled`),
take medians, force GPU completion with a `readPixels` per frame, and report a
range. Never quote a single figure. **All numbers so far are desktop — measure
on a phone.**

---

## 6. Blender

Used **headless and by script**, never interactively:

```bash
BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
"$BL" --background --factory-startup --python tools/blender/roundtrip.py -- \
      assets/models/Forward.glb build/roundtrip/Forward.glb
"$BL" --background --factory-startup --python tools/blender/stadium_props.py -- \
      assets/models/stadium_props.glb
```

`--factory-startup` is not optional — no user prefs, no third-party addons, so
the output is what a clean machine produces.

`roundtrip.py` is the **gate**: it proves import/export does not damage the
27-bone rig before you trust Blender with anything. Verified lossless.

There is also a Blender MCP (`ahujasid/blender-mcp`) configured in `.mcp.json`,
which gives a *live* connection for interactive art direction. It is optional —
every asset so far was produced by the scripted route with no MCP at all.

---

## 7. Assets

| | |
|---|---|
| `assets/models/{Defender,Forward,Goalkeeper}.glb` | Rigged, textured footballers. 27 Unity-Humanoid bones, LOD0 5,688 tris + LOD1 1,452, 4 materials, 8 embedded 512² PNGs, **0 animations** |
| `assets/models/stadium_props.glb` | Corner flag (40 tris), dugout (156), floodlight pylon (824) |

The characters were generated by `football-characters/chargen/` — **pure
Python, no dependencies**, one level up from the repo. It can produce more
variants, kits and body types without Blender.

---

## 8. Traps that have each already cost hours

1. **The two skeletons disagree about bind bone direction.** glTF is authored
   T-posed so an arm runs along +X; goal.io's neutral arm hangs along −U.
   Applying the clips without correcting for that renders **every player in a
   T-pose**. The fix is derived from both rigs at load, not hardcoded. See
   `docs/PLAYERS.md`.
2. **A service worker silently served stale JS for hours.** If an edit appears
   to have no effect, check for a controlling service worker first.
3. **Every colour helper must go through `parseCol()`** — they return
   `rgb(...)` and used to accept only `#rrggbb`. Feeding one to another gave
   `NaN`, which canvas silently ignores. Cost hours twice.
4. **The keeper is deliberately fallible** — it reads the flight as if straight
   for the first 0.45 s. "Improving" it makes every level unwinnable.
5. **`STRIDE_K = 4.28` is measured, not chosen.** Re-authoring the run clip
   means re-measuring it.
6. **FEEL owns time.** Do not add a second `dt` scale; they will fight.
7. **Do not run a filmic tonemap over this scene.** The shaders output
   display-referred colour deliberately. ACES lifted the turf's red from 86 to
   140 and cut saturation 0.58 → 0.32.
8. **RGBA16F needs `EXT_color_buffer_float`** or the post chain fails silently.
9. **`primitive_cube_add(size=1)` spans ±0.5**, so the scale factor is `size`,
   not `size/2`. Getting it wrong halves every box and looks like something
   modelled slightly small. Print measured dimensions.
10. **Blender's glTF importer creates a stray Icosphere** in a collection named
    `glTF_not_exported`. Harmless, never exported, not worth chasing.

---

## 9. Current state

**Working:** 15 levels, all winnable, 14/15 three-starable · WebGL2 PBR with
shadow map, SSAO, FXAA, bloom, DoF, motion blur · skinned textured players in
runtime-painted club kits with squad numbers · 18k-instance crowd · corner
flags, floodlights, dugouts · six weather conditions · career with XP, levels,
4 skills, 15 achievements · full config layer + validator + CMS · PWA offline.

**Known gaps:**

1. **No imported animation.** All 13 clips are procedural; the models carry
   `animations: 0`. This is the single highest-value remaining item and the
   only one that genuinely needs Blender.
2. **Three body types for eleven players** — same mesh, same face per team.
3. **Lighting runs in gamma space**, not linear. Correct fix is ~20 lines then
   re-tuning everything; deliberately deferred.
4. **No telemetry**, so the CMS has no analytics and nobody knows which levels
   are actually mis-tuned versus designed that way.
5. **1.4 MB of models** in the service worker's install. KTX2/Draco unexplored.
6. **Everything measured on desktop.**

---

## 10. Documentation map

| Doc | |
|---|---|
| `CLAUDE.md` | Entry point for a new session |
| `docs/HANDOVER.md` | Full state and the trap list |
| `docs/WEBGL.md` | The default renderer and its post-chain traps |
| `docs/GRAPHICS-AUDIT.md` | What the renderer can and cannot do *(partly superseded — it says skinned characters and textures are unreachable; they now ship)* |
| `docs/PLAYERS.md` | Skinning, and the bind-fixup trap |
| `docs/BLENDER.md` | The headless Blender pipeline |
| `docs/CONFIG.md` | The config system |
| `docs/CAREER.md` | Progression, and why skills cannot break balance |
| `docs/CMS.md` | The content portal |
| `docs/REVIEW.md` | Critique — closed and open |
| `docs/UNITY-MIGRATION.md` | Plan for a Unity port |

---

## 11. Shipping

```bash
git add -A && git commit -m "what changed" && git push
```

**Bump `VERSION` in `sw.js`** if anything in `js/`, `config/` or `index.html`
changed (currently `v17`), and **add any new file to `ASSETS`** — forgetting
breaks the game *offline only*, which is very easy to ship by accident. GitHub
Pages redeploys in about a minute.

---

## 12. How the owner wants it worked on

Iterate autonomously: analyse, fix, verify, move to the next highest-impact
thing. Do not stop to ask permission for individual changes. Weight effort
toward **feel and visual polish** over features.

**Verify visually — numbers passing is not the same as it looking right.**
Several real bugs here passed every numeric check.

**When something looks wrong, instrument the exact frame rather than guessing.**
In this project a confident wrong theory has preceded the actual cause more
than once: the invisible stadium was an inside-out winding found by reading
pixel values, not by reasoning about fog; and three separate "that looks wrong"
judgements — the night grade, the turf brightness, an asymmetric arm — were all
wrong and were settled by measurement.
