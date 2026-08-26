# goal.io

A swipe football game in the mould of **Score! Hero**, built as an installable
mobile web app (PWA). Freeze-frame match situations; you draw the ball's path
with your thumb and the physics decides the rest.

## Running it

**On a laptop** — just open `index.html` in a browser. Drag with the mouse.

**On your phone** (this is what it's built for) — serve the folder over the
network and open it on the handset:

```bash
python -m http.server 8123 --directory .
```

Then browse to `http://<your-computer-ip>:8123` on the phone and use
*Add to Home Screen*. It launches fullscreen, portrait, with no browser chrome.
The service worker caches everything, so after the first load it plays offline.

Note: iOS only registers service workers over **https** or `localhost`. Over a
plain LAN IP it still plays, it just won't cache for offline use.

## How it plays

- **Drag anywhere** — the line grows from the ball, so your thumb never covers it.
- **Length of the drag = power.** The arc around the ball is the power meter.
- **Curve the line and the ball bends that way.** This is the whole game.
- **GROUND / DRIVEN / CHIP** sets how the ball is struck (0°, 9°, 29°).
- **End the line on a teammate** to pass; they take the next touch.
- **Rewind** takes back one bad touch — three per match, instead of restarting.
- The blue dots preview only the **first ~60%** of the flight, so reading the
  bend is still on you.

15 matches across 3 seasons, from a Sunday-league trial to a European Cup final.
Three stars per match: score, score within par touches, and hit the match's
bonus condition (bend it / chip it / from outside the box / never concede a touch).

## The physics

Everything is simulated in real metres and real seconds on a 105×68m pitch.

| Effect | Model |
|---|---|
| Air drag | quadratic, `a = 0.010·v²` — tuned to a 0.43kg size-5 ball |
| Magnus (curve) | lateral `a = 0.42·spin·v`, 40% as strong once rolling |
| Rolling | 2.3 m/s² grass resistance, plus a skid phase before it settles |
| Loft | true 3D height with gravity, bounce (0.55 restitution) and friction |
| Spin decay | 0.62× per second |

A 20 m/s ground pass runs about 48m. A driven shot first bounces around 21m out.
A chip peaks near 7m and lands at 37m. Those are all real-ish numbers.

**The keeper** is the interesting part. They read the flight, but they read it as
if it were *straight* for the first 0.45s — because a bend that hasn't happened
yet is not visible. Once they commit, the dive is ballistic: no re-aiming, about
1.7m of travel and an arm's reach on the end of it. That's why a whipped ball
beats them and a firm central shot doesn't. Hard shots are also harder to hold.

**Defenders** work the same way: each one gets a per-touch misread of up to a
metre and 40–220ms of reaction lag, and a ball hit hard enough gets past the body
they can get in the way of — often as a deflection rather than a clean block.

## The look

Modelled on Score! Hero's staging, with my own art.

**Interface** — deep navy surfaces, electric blue for anything you can press,
gold for anything you have earned. Built on an 8px spacing scale and a fixed
type ramp, with one card treatment used everywhere: navy glass, a hairline
border, a lit top edge and a real drop shadow. Condensed uppercase type
(Bahnschrift, Roboto Condensed or a variable system face, with `font-stretch`
holding the proportions where none of those exist).

Buttons are 56px with an inner highlight and a specular band that travels
across them, and they spring on press — 60ms down, 260ms back, because the
asymmetry is what makes a button feel like a key rather than a fade. Panels
arrive in sequence 42ms apart. A broadcast scorebug carries club, score and
clock and flips the digit when you score; the pre-match card is a fixture sheet
with shield crests and the story beat; match tiles carry a difficulty band taken
from measured win rates, with the three hardest levels flagged.

**Stadium** — striped turf where adjacent mow bands catch the light from
opposite ends, graded toward the horizon so distance reads, and lit by a single
directional key. Four raked stands with a 5,200-person crowd broken into home,
away and neutral blocks, gangways cut up the rake, supporters' banners on the
facia, and a run of sponsor hoardings along every touchline. Board text is drawn
by building the affine transform that maps a flat rect onto the board's
projected corners, with a handedness flip because the camera basis is
left-handed.

**Conditions** — six, assigned across the career: afternoon, golden hour,
overcast, rain, night and night rain. Each one drives the sky, the haze, the
floodlights, the wetness of the surface and a whole-frame colour grade, so the
pitch and the players are always in the same light.

## Animation

`js/anim.js` is a small skeletal animation system — a bone hierarchy, keyframed
clips, and crossfade blending between them.

- **17-joint rig** (pelvis, spine, chest, neck, head, shoulders/elbows/hands,
  hips/knees/ankles) defined as local offsets in the player's own frame.
- **Poses are per-joint Euler triples** `[pitch, yaw, roll]` in radians. Pitch
  turns about the joint's own right axis; bones extend along -U, so a positive
  pitch swings the bone's *tip* forward. That means for the upward spine chain a
  positive pitch leans the torso *backwards* — the one sign trap in the file, and
  it is documented at the top of it.
- **Thirteen clips**: idle, run, strike, chip, pass, receive, diveL, diveR,
  celebrate ×3, brace, keeperSet. Keys ease with a smoothstep so they do not
  snap. The two dives are separate and asymmetric because a symmetrical body
  rolled onto its side is a starfish, not a goalkeeper.
- **The strike scales with power.** Amplitude comes off the recorded kick speed,
  so a tap and a driven shot play the same clip at different sizes. A chip gets
  its own clip rather than a scale factor — the follow-through is clipped rather
  than swung through, which is a different shape, not a smaller one.
- **Celebrations are per player**, chosen by squad number, so a given player
  always celebrates the same way.
- **Crossfading**: switching clips fades the outgoing pose into the incoming one
  over 70-160ms, so a player entering a strike from a run does not pop.
- **The run cycle is driven by stride phase, not wall time**, so the feet do not
  skate at different speeds. Its clock is overridden after the animator steps —
  stepping still has to happen every frame or the crossfade never completes.
- Clips are chosen from game state alone (`pickClip`), so the simulation stays
  free of presentation concerns.

## The rendering

A real 3D scene, drawn with a hand-written renderer on a 2D canvas — no WebGL
and no libraries, so it stays a single folder you can open offline.

- **Pinhole camera** with position, look-at, focal length and near-plane
  clipping, sitting behind the ball *along the ball-to-goal axis* so both share
  the screen's centre line. The axis is frozen during a flight, or it would
  swing through 180 degrees as the ball reached the goal.
- **Players are solid geometry** — tapered prisms for every limb (up to ten
  sides up close, four at distance), lit spheres for head, hands and joint caps.
  Proportions are deliberately heroic rather than anatomical: about 6.9 heads
  tall with broad shoulders, which is what gives the reference its character.
- **Smooth shading.** Each prism face carries the true surface normal at both of
  its side edges; the face is filled with a gradient between the two lambert
  values, so an eight-sided limb reads as a cylinder rather than a faceted tube.
  Only enabled above 34px tall — below that the flat fill is indistinguishable.
- **Seam sealing.** Adjacent canvas polygons antialias against each other and
  leave a hairline gap. While drawing a player, every fill is also stroked in
  its own paint, which closes them.
- **Depth bias for garments.** There is no z-buffer, so a shirt and the arm
  inside it can sort wrongly and flicker. Clothing is biased a centimetre or two
  toward the camera, and geometry that is permanently hidden (the thigh inside
  the shorts, the shin inside the boot) simply is not built.
- **Faces** are drawn after the face buffer flushes — queued behind the head
  sphere they would be painted over — and only when the head is genuinely turned
  toward the camera.
- **The ball** is a lit sphere with twelve panel centres on an icosahedron,
  rotated with its roll so it visibly spins.
- **Pitch markings are painted on the ground plane** as real-width quads.
- **The goal** is a genuine box: posts and bar with thickness, plus back, roof
  and side netting drawn as 3D cords.
- **The aim line** is the true predicted flight, drawn as white dots sized in
  metres, with a fainter dot on the grass beneath a lofted ball.

Between 3 and 10ms a frame depending on how many players are on screen.

## Layout

```
index.html      shell, styles, HUD and overlay markup
js/core.js      pitch geometry, physics constants, career/level data, save
js/sim.js       ball flight, players, defender + keeper AI, rewind snapshots
js/audio.js     audio engine: buses, generated stadium reverb, crowd bed
js/render.js    3D camera, projection, stadium, players, weather, replay, FX
js/fx.js        the feel layer: time director, shake, cues, the goal timeline
js/game.js      input, swipe->kick conversion, game loop, career flow, UI
js/test.js      headless harness (not loaded by the game — see below)
js/shot.js      headless capture harness (not loaded — see below)
sw.js           offline cache, network-first for code
```

The swipe is projected onto the grass plane by intersecting the camera ray with
z=0, so the line you draw lands exactly where your finger is in the 3D world.

### Testing

`js/test.js` isn't loaded by `index.html`. Inject it from the console to run the
simulation headlessly:

```js
var s=document.createElement('script');s.src='js/test.js';document.head.appendChild(s);
// then:
T.balance(400)      // brute-force every level, reports win rate + best stars
T.ballRun(20,0,0)   // single ball flight: range, apex, lateral deviation
T.solve(9, 500)     // hammer one level
```

`T.balance()` is how the levels were checked for solvability — all 15 are
beatable and all 15 can be three-starred.
