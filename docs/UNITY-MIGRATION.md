# goal.io → Unity migration plan

The web build exists to prove the design: physics, keeper behaviour, level
balance, camera rules and animation are all tuned and measured. Unity's job is
to give it a renderer we cannot hand-write — real shadows, PBR turf, post
processing, particles — not to re-invent the game.

The governing principle: **port the simulation verbatim, rebuild only the
presentation.** Everything measured stays measured.

---

## 1. What moves, and how

| Layer | Web file | Unity | Effort |
|---|---|---|---|
| Physics + AI | `js/sim.js` (662 ln) | `Sim/Ball.cs`, `Sim/Player.cs`, `Sim/World.cs` | **Direct port.** ~2 days |
| Constants + levels | `js/core.js` (276 ln) | `Data/Pitch.cs`, `Data/Levels.asset` (ScriptableObject) | ~1 day |
| Animation clips | `js/anim.js` (337 ln) | Unity `AnimationClip` + Animator | **Rebuild** ~3 days |
| Renderer | `js/render.js` (1,300 ln) | **Deleted.** URP does this | — |
| Input → kick | `js/game.js` (computeKick) | `Input/SwipeController.cs` | ~1 day |
| Camera | `js/render.js` cameraFollow | `Camera/BroadcastCamera.cs` | **Direct port.** ~1 day |
| UI | `index.html` + game.js screens | UI Toolkit (UXML/USS) | ~4 days |
| Characters | `football-characters/models/*.glb` | Import as-is | ~0.5 day |

Roughly **three weeks** for one developer to reach parity, then polish on top.

---

## 2. Decisions that matter

### Do NOT use Rigidbody for the ball
This is the most important call in the migration. The ball's behaviour —
quadratic drag, Magnus curve, skid-then-roll, bounce restitution — is a custom
integrator tuned against real measurements (a 20 m/s ground pass runs 48 m; a
driven shot first bounces at 21 m; a chip peaks at 7 m). Unity's PhysX will not
reproduce those numbers, and the keeper AI reads a *prediction* of that exact
integrator.

Port `stepBall()` into a plain C# class stepped from `FixedUpdate` at 120 Hz.
Use a Unity collider only for visual collision events you want (net, post
rattle), never for trajectory.

The same applies to `predictPath()` — the keeper's spin-blind read and the
defenders' misjudgement both depend on running the *same* integrator forward.

### Port the camera, don't reach for Cinemachine
Cinemachine is excellent, but the smoothness work here is specific and already
measured: eased ball-lead on a smoothed velocity, an axis frozen outside the
aim phase, and a teleport shock absorber. Frame-to-frame camera jerk currently
measures **0.066 m/frame²** uniformly across every level, with no event spikes.

Port `cameraFollow()` into `BroadcastCamera.cs` and drive `Camera.main.transform`
directly in `LateUpdate`. Keep the jerk test as a play-mode test so a regression
is caught, not discovered.

### Determinism
Keep the sim in fixed-step, float-deterministic C# with no `Random` in the
trajectory path. The level solver (`js/test.js`, `T.balance()`) that verified
all 15 levels are beatable should be ported as an EditMode test — it is the
only thing standing between you and an unwinnable level after a tuning change.

---

## 3. Project setup

- **Unity 2022.3 LTS**, **URP**. Not HDRP — this is a mobile title.
- URP asset: one Forward renderer, **HDR on**, MSAA 4x, shadow distance 45 m,
  one cascade, soft shadows off (use a tightened shadow bias instead).
- Colour space **Linear**, **Gamma** only if you must ship to very old Androids.
- Target 60 fps on a Snapdragon 7-series; budget ~120 draw calls, ~250k tris.

### Lighting
- One directional light as the key, shadows on, angled to match the web build's
  light vector `(-0.32, 0.42, 0.85)`.
- Bake the stands, hoardings and stadium shell to lightmaps — they never move.
- Players and ball take **real-time shadows only**; everything else baked.
- Light probes across the pitch so players pick up bounce.
- Post: Bloom (threshold ~1.1, low intensity), subtle Vignette, Colour Adjust
  with a touch of saturation. **No motion blur, no DoF** — costly and it hurts
  readability on a phone.

---

## 4. Assets

### Characters
`football-characters/models/*.glb` import directly:
1. Rig → Humanoid → Create From This Model. The 27 bones are Unity-named and
   map automatically.
2. Add a `LODGroup`: `_LOD0` (5,688 tris) above 40 % screen height, `_LOD1`
   (1,452) down to 4 %, cull below.
3. Materials extract as `Skin` / `Kit` / `Boots` / `Hair` — four submeshes, so
   kit swaps are a single material assignment at runtime.
4. Generate new strips with `chargen/variant.py` from a JSON spec.

### Pitch
Replace the hand-drawn turf with a real shader:
- Base colour + normal + roughness turf textures (2048², or 1024² with detail
  tiling).
- **Mow stripes**: a second UV channel or world-space mask driving a tint and
  an anisotropic sheen — not painted into the albedo, so the stripe direction
  can change per stadium.
- Pitch markings as a decal or a mask channel, never geometry.
- Reuse the wear layout in `render.js` `WEAR[]` as a mask.

### Crowd
The web build animates 5,200 sprite people. In Unity use a **GPU-instanced
crowd**: one quad mesh, `Graphics.DrawMeshInstancedIndirect`, per-instance
colour and phase in a compute buffer. One draw call, tens of thousands of
people, cheaper than what runs today.

---

## 5. Scene structure

```
Match
├── Stadium            (static, lightmapped)
│   ├── Stands, Roof, Hoardings, Floodlights
│   └── Pitch          (turf shader + markings decal)
├── Goals              (net = cloth-lite or a vertex-animated shader)
├── Squad              (pooled SkinnedMeshRenderers, LODGroup each)
├── Ball               (mesh + trail)
├── Sim                (World.cs — no transforms, pure data)
├── BroadcastCamera
└── UI (UIDocument)
```

`Sim` owns positions; a thin `View` layer copies sim state onto transforms in
`Update`. Keeping them separate is what lets the sim run at a fixed 120 Hz
while rendering runs free.

---

## 6. UI

Use **UI Toolkit**, not uGUI — the current interface is already structured as
markup + stylesheet, so `index.html`'s CSS translates to USS almost line for
line. The chamfered panels are `clip-path` today; in USS use a nine-slice
sprite or a small shader.

Port order: HUD scorebug → pre-match card → match grid → result card → menu.
Add the transitions the web build lacks: panels slide-and-fade in over 180 ms
with an ease-out curve, staggered ~40 ms per element.

---

## 7. Milestones

| # | Deliverable | Exit test |
|---|---|---|
| 1 | Sim ported, no rendering | Ported `T.balance()` EditMode test: 15/15 levels beatable, same win rates as web |
| 2 | Characters + pitch in scene, static camera | Runs 60 fps on target device with 8 players |
| 3 | BroadcastCamera ported | Jerk play-mode test ≤ 0.07 m/frame² on all 15 levels |
| 4 | Animator + swipe input | A full level is playable end to end |
| 5 | UI ported | All screens reachable, no placeholder text |
| 6 | Lighting, VFX, crowd, audio | Side-by-side against the web build: strictly better on every axis |

Do not start milestone *n+1* until *n*'s exit test passes. That is what keeps
"port" from turning into "rewrite".

---

## 8. Risks

- **Animation is the long pole.** The clips are authored as joint-angle
  keyframes in code; Unity wants `AnimationClip` assets. Either write an editor
  script that bakes `CLIPS[]` into clips (fast, keeps the tuning), or re-author
  by hand in the Animator (slower, better quality). I would bake first, then
  re-author the strike and dive by hand.
- **Turf shader is where the "AAA" impression is won or lost.** Budget real
  time for it; it is 60 % of the screen.
- **Do not let PhysX creep into the ball.** The moment someone adds a Rigidbody
  "just for collisions", the keeper AI's predictions stop matching reality and
  the difficulty curve silently breaks.
- **Determinism across platforms** if you ever add replays or online: pin the
  sim to fixed-point or accept float drift and record inputs plus periodic
  state snapshots.
