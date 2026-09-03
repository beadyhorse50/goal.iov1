# goal.io — art style guide

The visual bible. Every number here is either already in the code or is a target
the code should move to; nothing is aspirational mood-boarding. Where a value is
live, the file it lives in is named. Where it is a target, it says **TARGET**.

Read `GRAPHICS-AUDIT.md` before proposing anything here that needs an asset —
several obvious ideas are blocked on content that does not exist.

---

## 0. The one-line brief

**Televised football, seen from the shooter's shoulder, on a phone held in one
hand.** Broadcast framing and broadcast colour, but every read has to survive at
90 pixels tall. Score! Hero is the reference for *legibility and pace*, not for
its flat-shaded look — goal.io is lit, has a real shadow map and a post chain,
and should look a generation newer.

The failure mode this guide exists to prevent is **arcade drift**: saturated
traffic-light green, rubber-toy players, a stadium made of coloured rectangles.
It has already happened once — see the comment above `COL.grass1` in
`js/render.js:29`, where mint-green turf was the single strongest arcade tell in
the frame.

---

## 1. Colour

### 1.1 The three-hue rule

The interface owns exactly three hues, and no fourth is ever introduced:

| Role | Hue | Where it may appear |
|---|---|---|
| **Surface** | deep navy | every panel, card, bar, overlay, the letterbox |
| **Action** | electric blue | anything the thumb can touch, and only that |
| **Reward** | gold | stars, XP, level-ups, the minute clock, nothing else |

Green belongs to the pitch. It appears in the UI only as `--good` `#25d97a`, and
only as a *state* (a tick, a positive delta) — never as a surface, never as a
button. Red belongs to the home kit and to `--bad` `#ff4763`. If a new accent
seems necessary, the answer is a value change inside an existing hue, not a new
hue.

### 1.2 UI palette — live, `config/ui.json`

Written straight onto `:root` at boot, so changing `b500` restyles the game.

```
Surface   n900 #050b16   n800 #08111f   n700 #0b1728   n600 #101f34
          n500 #16293f   n400 #1e344c   n300 #2a4359
Action    b600 #0069d9   b500 #0090ff   b400 #38b0ff   b300 #7ccdff
Reward    g600 #c98a0a   g500 #f0a91b   g400 #ffc233   g300 #ffd970
Ink       ink  #f2f7fc   ink2 #c3d2e0   dim  #8199b0   dim2 #5a7189
State     bad  #ff4763   good #25d97a
Glass     panel rgba(255,255,255,.045)   line rgba(255,255,255,.09)
          line2 rgba(255,255,255,.16)    glow rgba(0,144,255,.34)
```

**Never pure black, never pure white.** `n900` is a cool navy, not `#000`; `ink`
is a cool off-white, not `#fff`. Pure black on an OLED phone kills the sense that
the panel is glass sitting over a lit scene, which is the entire premise of the
HUD.

### 1.3 World palette — live, `js/render.js:26`

```
Turf      grass1 #43a259   grass2 #2f7f45      (base mow bands)
          grass1Lit #51b166  grass2Lit #388c4e (sheen at the band edge)
Lines     rgba(255,255,255,.95)
Concrete  #20262e
Ad board  bg #f4f7fa  fg #12305a
```

The two mow directions need real separation or the stripes vanish once depth
haze lifts the far end. A stripe on a nearly-clipped green has no headroom to be
lighter in — which is why the base greens are deliberately dark and cool.

### 1.4 Kit palette — live, `js/render.js:44`

```
Home      shirt #d8324a   shorts #f0f4f8   socks #d8324a
Away      shirt #5566d8   shorts #2b3492   socks #2b3492
Keeper    shirt #25b596   shorts #12705c   socks #12705c
```

**One-colour shirts with white trim.** A white torso between two red sleeves read
as a sheet of paper taped to the player: a high-contrast block boundary running
straight down the silhouette with no shading across it. Single-colour shirts have
no such boundary and let the white shorts break the silhouette at the waist
instead. Any new club kit obeys this — halves, quarters and hoops are banned
until the renderer can shade across a block boundary convincingly.

### 1.5 Character palette — live, `js/render.js:47`

```
Skin ramp  #f0c9a4  #dda87c  #c08a5c  #96613c  #6d4227   (five, by squad number)
Hair       #39291d
Boot       #191c22
Boot flash #00e5a0  #ff2e93  #ffc233  #38b0ff  #f2f5f8  #ff6a2b
Crowd      #d9ab80 #f3ece1 #c33b2e #8d5b3b #e7e0d3 #6d4831
           #3a4170 #d2603a #f5f5f5 #a43c3c #e8c98a #4d4f57
```

Modern boots are never black. A flash colour on the upper is the single detail
that dates a football game most obviously if it is missing.

### 1.6 The saturation hierarchy — the rule that actually matters

Measured on the live values:

| Layer | Saturation | Why |
|---|---|---|
| UI action `b500` | ~100% | must win against a lit 3D scene behind glass |
| Kits `d8324a` / `5566d8` | 62–68% | the players are the subject |
| Turf `43a259` | ~41% | the ground is a backdrop, not a character |
| Crowd | 20–45%, randomised | mass, never individual reads |

**Saturation descends with distance from the ball.** If a new element does not
fit this ladder, it is the wrong colour — including a "nicer", greener pitch.

---

## 2. Character proportions

### 2.1 The canonical skeleton — live, `js/anim.js:18`

Metres, ground plane `z = 0`, `x` right, `y` forward, `z` up.

| Joint | Height (m) | Offset from parent |
|---|---|---|
| ankle | 0.00 | `[0, 0, −0.40]` from knee |
| knee | 0.40 | `[0, 0, −0.42]` from hip |
| hip | 0.82 | `[±0.095, 0, −0.06]` from pelvis |
| **pelvis (root)** | **0.88** | — |
| spine | 1.04 | `[0, 0, 0.16]` |
| chest | 1.32 | `[0, 0, 0.28]` |
| shoulder | 1.38 | `[±0.228, 0, 0.06]` from chest |
| elbow | 1.12 | `[0, 0, −0.26]` from shoulder |
| hand | 0.87 | `[0, 0, −0.25]` from elbow |
| neck | 1.44 | `[0, 0, 0.12]` |
| head joint (chin line) | 1.55 | `[0, 0, 0.11]` |
| crown | ≈1.80 | mesh, not a joint |

17 bones. That is the whole rig — no fingers, no toes, no twist bones, no facial
rig. Anything that needs an eighteenth bone is out of scope.

### 2.2 The locked ratios

These are the identity. Change one and every player stops looking like the same
game.

| Ratio | Value | Note |
|---|---|---|
| **Height in heads** | **7.2** | head unit 0.25 m, crown 1.80 m |
| Leg ÷ height | 0.456 | real athletes ≈0.47; shortened slightly for on-screen stability |
| Shoulder span ÷ hip span (joints) | 2.40 | 0.456 m vs 0.190 m |
| Shoulder ÷ hip (silhouette, with mass) | ≈1.72 | the taper that reads at distance |
| Arm ÷ leg | 0.62 | 0.51 m vs 0.82 m |
| Hand diameter | 0.114 m | 0.46 head units — undersized on purpose |
| Boot capsule radius | 0.074 → 0.128 m | tapered, with a sole inset |

**7.2 heads is the whole call.** Life is 7.5–8. Score! Hero sits near 7. Chibi
sits at 4–5. At 7.2 the head is ~4% larger than life, which is enough to carry a
face at phone scale without reading as a caricature, and it is why the players
look like athletes rather than mascots. Do not "fix" it toward realism.

Hands are volume markers, not hands. At gameplay scale a correctly-sized hand is
three pixels of noise; a slightly small sphere reads as a closed fist, which is
what a running footballer has anyway.

### 2.3 The 90-pixel constraint

At gameplay distance a player is **≈90 px tall**. That makes the head ≈12 px and
any facial feature 2–4 px. Consequences, all mandatory:

1. **No feature narrower than 3 px may carry meaning.** Eyes, brows and mouth are
   *value blocks*, not lines. They exist for the celebration and replay cameras;
   at gameplay they only need to darken the right region of the head.
2. **The read is silhouette plus two values.** Shirt value against turf value,
   and shorts value against shirt value. Everything else is decoration.
3. **The waist break is load-bearing.** White shorts against a coloured shirt cut
   the figure at 0.88 m — that horizontal is what stops the player reading as a
   coloured stick.
4. **Hair is a silhouette element, not a texture.** Four styles, distinguished by
   outline shape at 12 px, not by strand detail.

### 2.4 Variation budget

Identity is derived from the squad number, deterministically — same number, same
player, every session. Live in `js/render.gl.js` / `js/skin.gl.js`.

| Axis | Count | Range |
|---|---|---|
| Skin tone | 5 | the ramp in §1.5 |
| Hairstyle | 4 | silhouette-distinct at 12 px |
| Build | continuous | ±6% on chest and thigh radius |
| Brow / jaw / eye structure | continuous | small, for close cameras only |
| Boot flash | 6 | §1.5 |
| Idle phase offset | continuous | so a group never breathes in unison |

### 2.5 Known geometry debt — **TARGET**

From `REVIEW.md` R9, all visible only in close cameras and store screenshots:

- The near shoulder cap stands slightly proud of the deltoid.
- Hands are barely visible with the arms down.
- A faint seam at the knee past ~0.6 rad — the thigh inside the shorts is
  deliberately not built.

Fixing these is a close-up job, worth doing before any marketing capture and not
before.

---

## 3. Stadium

### 3.1 What it is

**A modern ~25,000-seat English club ground, not a superstadium.** The career
runs through three clubs, so the venue has to feel like it can be a step up
without the top of the ladder looking absurd. A continuous bowl with generous
rounded corners, not four separate stands — four stands read as a lower-league
ground and, more practically, four roof lines make the shadow staging in §4
impossible.

### 3.2 The bowl — live, `js/render.gl.js:1021`

Derived from the pitch, so moving a pitch dimension moves the whole stadium.

| Parameter | Value | Derived |
|---|---|---|
| Pitch | 68 × 105 m | `config/pitch.json` |
| Grass surround | 6.0 m | then the ad boards |
| Bowl half-width `hx` | 42.4 m | `34 + 6 + 2.4` |
| Bowl half-length `hy` | 60.9 m | `52.5 + 6 + 2.4` |
| Corner radius | 20 m | generous — reads as one bowl |
| Perimeter path segments `K` | 148 | |
| Rows | 26 | |
| Rise / run | 0.46 / 0.84 m | **rake 28.7°** |
| Front row floor `base` | 1.25 m | top of the perimeter wall |
| Back row | 13.2 m | `1.25 + 26 × 0.46` |
| Roof lift | 3.6 m above back row | ≈16.8 m |
| Roof overhang | 15.0 m forward over the rake | |

**The rake is built as real steps.** A smooth ramp with treads painted on reads
correctly from the front and falls apart in silhouette at the top edge — which is
exactly where the crowd meets the sky and exactly where the eye actually goes.

### 3.3 The roof is lighting geometry

The 15 m overhang and the 16.8 m lip exist to throw a shadow edge across the
pitch at low sun. That is the whole reason golden hour is pinned to 9° elevation
(§4.3). Never change `roofOver` or `roofLift` without re-checking the golden-hour
shadow line — it is the single most recognisable lighting event in televised
football, and here it is generated, not painted.

### 3.4 Crowd

18,000 individual spectators, palette in §1.5, pre-sorted by colour for draw
cost, stride-thinned with distance. Rules:

- **Mass, never individuals.** No spectator may be identifiable. Randomised
  value, low saturation, no faces.
- The crowd is the dominant frame cost. Any new crowd feature is measured before
  it is kept.

### 3.5 Stadium debt — **TARGET**

1. **The GL bowl is one tier.** The canvas renderer has two tiers plus a facia
   with banners, and is still architecturally richer. This is the last place the
   old renderer wins and it is the #1 open visual item. Target: a second tier
   above a facia band at ~7 m, the facia carrying club banners and a scoreboard.
2. Props exist — corner flags, floodlight pylons, dugouts — generated by
   `tools/blender/stadium_props.py`.

---

## 4. Lighting

### 4.1 The model

One key (the sun), one broad ambient probe tinted toward the sky colour, plus a
floodlight contribution that rises as the sun falls. A shadow map for the cast,
plus a separate ambient-occlusion contact pool under each figure — the two are
graded separately because a contact shadow and a cast shadow behave nothing
alike.

Post chain, in order: SSAO → bloom → depth of field → reprojected motion blur →
highlight shoulder → grading → vignette → grain. Three traps, all in `WEBGL.md`:

- RGBA16F needs `EXT_color_buffer_float` or it fails **silently**.
- **Do not run a full filmic tonemap over a display-referred scene.** Compress
  the top ~20% with a highlight shoulder and leave the rest alone.
- Reprojected motion blur must skip camera cuts.

### 4.2 The six conditions — live, `config/conditions.json`

`light` = exposure, `warm` = colour temperature, `flood` = floodlight
contribution, `wet` = surface sheen, `haze` = distance falloff.

| Preset | light | warm | flood | wet | haze | sun el/az | Sky (zenith → horizon) |
|---|---|---|---|---|---|---|---|
| afternoon | 1.00 | 0.55 | 0.10 | 0 | 1.00 | 40° / 128° | `#1f4f78` `#77b1cf` `#e2edee` |
| goldenHour | 0.96 | 1.00 | 0.25 | 0 | 1.25 | **9°** / 105° | `#243f6b` `#b3763f` `#f5cf9a` |
| overcast | 0.88 | 0.18 | 0.30 | 0.18 | 1.45 | 34° / 142° | `#43505c` `#7c8a94` `#c3ccd1` |
| rain | 0.80 | 0.10 | 0.55 | 0.72 | 1.75 | 27° / 155° | `#2e3944` `#5b6874` `#98a4ad` |
| night | 0.66 | 0.30 | 1.00 | 0.10 | 0.85 | 33° / 205° | `#070b14` `#0e1626` `#1d2a3c` |
| nightRain | 0.62 | 0.20 | 1.00 | 0.78 | 1.30 | 31° / 212° | `#060910` `#101a28` `#1f2c3a` |

Lighting is **presentation only** — it never touches the ball. A level's
difficulty must not change because it got dark.

### 4.3 The rules

1. **Sun elevation is a staging parameter, not weather.** 9° puts the roof lip's
   shadow across the pitch. Below ~6° the shadow swallows everything; above ~12°
   the edge sits behind the camera and the effect is gone. 40° is short shadows
   and a flat, un-dramatic "just a football match" — correct for an early career
   level, and correct nowhere else.
2. **Never neutral.** Every preset commits to a temperature. `warm` never sits
   between 0.35 and 0.50; that band is where a frame stops looking graded and
   starts looking un-graded.
3. **Wet is a sheen, not a colour.** `wet` raises specular response and darkens
   the turf slightly. It must never tint.
4. **Haze does the depth work.** No fog colour is authored separately — haze
   pulls distant geometry toward the sky's horizon colour, which is why the sky
   ramp has three stops.
5. **Floodlights and sun are exclusive in feel.** `flood` above 0.55 means the
   pylons are the key and the sun is fill, and the grade should follow — cooler
   shadows, harder falloff, visible pylon flare.

---

## 5. Camera

### 5.1 The gameplay camera — live, `js/render.js:16`

| Property | Value |
|---|---|
| Eye | `(0, 20, 12)` |
| Look-at | `(0, −10, 1)` |
| Height above pitch | 12 m |
| Distance behind target | 30 m |
| **Elevation** | **20.1°** |
| Focal length | 900 px over the portrait play area |
| Vertical FOV | 0.9 rad = **51.6°** |
| Horizontal FOV (390 px wide) | **24.5°** |
| Near / far | 0.30 / 400 m |

Portrait does something specific and worth naming: the camera is **wide
vertically and long-lens horizontally**. 24.5° across is close to a 90 mm lens.
That is why the pitch reads as compressed and broadcast-like rather than
fish-eyed, and it is why moving to landscape would need a different lens, not
just a different aspect ratio.

### 5.2 The rules

1. **Elevation band 15°–25°.** Below 15° the box markings collapse into each
   other and the player cannot judge distance. Above 25° it becomes a top-down
   puzzle game and loses the "you are the player" read. 20° is the middle, and
   where it stays.
2. **The ball is anchored low-centre so the thumb never covers it.** The aim line
   is drawn from the ball, so the ball has to sit above the thumb's resting arc —
   roughly 35% up from the bottom edge. This is the single best-judged decision in
   the control scheme (`REVIEW.md`, "would not reject on these"). Do not re-centre
   the ball.
3. **Push, never cut, during play.** Cuts belong to replay and to the miss
   post-mortem only — and any cut must flag the motion-blur pass to skip that
   frame.
4. **Every camera move is solved, not keyframed.** The miss camera is composed
   from the actual ball end point and the goal; the replay angle is derived from
   the near post. Nothing is hand-placed, because levels differ.

### 5.3 The camera beats — live

| Beat | Behaviour |
|---|---|
| Strike | fast lens push |
| Pass | slower push plus lateral drift |
| Goal | goal sequence, then replay |
| Replay | 0.45× speed, low angle behind the near post, broadcast banner, holds on the final frame |
| Miss | post-mortem framing both the goal and the ball's end point, with the flight line, the keeper's committed dive arc, and the miss distance in centimetres |

**TARGET:** half-time and full-time stings. Kickoff card, goal sequence, replay
and miss post-mortem exist; the rest of the broadcast furniture does not.

---

## 6. Animation

### 6.1 The clip set — live, `js/anim.js:48`

Thirteen clips. Sparse keys, hand-authored as pose dictionaries.

| Clip | Duration | Loop | Note |
|---|---|---|---|
| `idle` | 3.40 s | ✓ | per-player phase offset |
| `run` | 1.00 s | ✓ | |
| `strike` | 0.42 s | — | amplitude-scaled by kick power |
| `pass` | 0.34 s | — | amplitude-scaled |
| `chip` | 0.40 s | — | its own shape, **not** a scaled drive |
| `receive` | 0.46 s | — | first-touch cushion |
| `diveL` / `diveR` | 0.62 s | — | keeper |
| `brace` | 2.20 s | ✓ | defensive wall, phase-offset |
| `keeperSet` | 1.25 s | ✓ | |
| `celebrate` | 1.10 s | ✓ | chosen by squad number |
| `celebrate2` | 1.35 s | ✓ | |
| `celebrate3` | 0.92 s | ✓ | |

### 6.2 The rules

1. **Pairwise crossfade only. No blend trees.** This is a deliberate ceiling, and
   it is enough at this camera distance. Any clip that only works blended
   three-ways is the wrong clip.
2. **Amplitude scaling, not clip switching.** `Animator.amp` / `scalePose` scale
   strike, chip and pass by the power of the kick, so a tap and a 30 m/s drive do
   not play identically. This is the cheapest realism in the whole system, and any
   new action clip should use it rather than shipping soft/medium/hard variants.
3. **Contact frames are the only frames that matter.** `strike` is 0.42 s — about
   25 frames — and gets 5 keys: plant down, hips loaded, contact at ≈0.26, follow
   through, settle. Adding keys between them buys nothing at 90 px.
4. **Anticipation is compressed to almost nothing.** The animation is feedback for
   a swipe that has already happened, so the strike leads with the plant already
   down. A real 12-frame wind-up would read as input lag.
5. **Nothing idles in unison.** Every looping clip carries a per-player phase
   offset. Eleven players breathing together is the strongest tell that they are
   instanced.
6. **Sim reports, presentation interprets.** The simulation pushes named cues
   (`bounce`, `post`, `save`, `block`, `deflect`, `net`) onto `world.cues` and has
   no idea what any of them look or sound like. Animation reacts to cues; it never
   reaches back.

### 6.3 Animation debt — **TARGET**

- No walk or jog — only `idle` and `run`, so standing-to-running is a crossfade
  across a gap. A 1.2 s `jog` would close it.
- No tackle, block reaction or shoulder-barge.
- No half-time / full-time body language.

---

## 7. UI

### 7.1 Tokens — live, `config/ui.json`

```
Radius   r-s 10px   r-m 16px   r-l 22px   r-xl 28px
Space    s1 4   s2 8   s3 12   s4 16   s5 24   s6 32   s7 48      (8px scale)
Face     "Bahnschrift SemiCondensed", "Bahnschrift", "Roboto Condensed",
         "SF Compact Display", "Helvetica Neue", system-ui, -apple-system
Stretch  font-stretch: 92%
Numerals font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1
```

### 7.2 The rules

1. **Condensed or it is not this game.** `font-stretch: 92%` drives the variable
   system faces where a named condensed family is not installed — that is what
   stops the identity collapsing to plain San Francisco on iOS. **TARGET:** bundle
   a real webfont (`REVIEW.md` R6). Small work, disproportionate effect.
2. **Tabular numerals everywhere, always.** A score or clock that reflows as
   digits change is the cheapest possible way to look unfinished.
3. **Tracking rises as size falls.** 17 px score → normal; 13 px team label →
   `.08em`; 10.5 px minute → `.14em`. Small condensed type without tracking is
   unreadable at arm's length.
4. **One card treatment.** `panel rgba(255,255,255,.045)` + a 1 px
   `rgba(255,255,255,.09)` line + `backdrop-filter: blur(16px)` + a deep soft
   shadow. Every panel in the game is this. Depth comes from blur and shadow,
   never from a second background colour.
5. **56 px is the button.** Below 48 px it fails a thumb; 56 px with an inner top
   highlight and a slow travelling specular is the only primary button.
6. **The HUD is glass over a lit scene.** It must never become opaque, because the
   moment it does, the 3D behind it stops being the subject.
7. **Shield crests, never circles.** The crest shape is club identity, and it is
   the same shape at every size.

### 7.3 The screens

Match HUD (scorebug, level tag, touches, rewind) · level select (match tiles with
difficulty pips derived from measured win rates, the three outliers marked red) ·
pre-match brief · result card (stars, XP, career record) · career (levels, skills,
achievements) · settings (audio and haptics toggles, two-step progress reset).

Regenerate `ui-preview.html` from the real stylesheet to review any of these —
DOM screenshots are impossible in this environment.

---

## 8. Image prompts

**These are concept and reference prompts, not a texture pipeline.** Nothing
generated here drops into the game as-is: kits are painted at runtime from a
greyscale atlas plus a tint mask, and the environment is procedural. Use these to
lock a look before authoring in Blender, and as reference underlays while
modelling.

Append this suffix to every prompt below:

> `--style raw --ar 3:2` · consistent palette: navy `#0b1728`, electric blue
> `#0090ff`, gold `#ffc233`, turf `#43a259`/`#2f7f45`, home red `#d8324a`, away
> blue `#5566d8`

Use this negative prompt on every one:

> `chibi, big head, cartoon mascot, cel shading, flat vector, toon outline,
> traffic-light green grass, mint green pitch, pure black, pure white, lens flare
> spam, watermark, text artifacts, fisheye, wide-angle distortion`

---

### 8.1 Master key art

> Cinematic still from a modern mobile football game. A single footballer in a
> deep red one-colour shirt with white trim and white shorts strikes a ball from
> the edge of the penalty area, seen from behind and slightly above at a
> 20-degree elevation. Portrait framing, long-lens compression across the pitch.
> Dark cool striped turf, a continuous rounded stadium bowl with a cantilevered
> roof, 25,000 spectators reading as low-saturation mass. Late afternoon sun at 9
> degrees throwing a hard shadow line from the roof lip diagonally across the
> grass. Broadcast colour grade, gentle bloom on the highlights, shallow depth of
> field behind the player. Photoreal, physically lit, not stylised.

### 8.2 Outfield player — character sheet, home kit

> Character reference sheet for a game-ready footballer. Front, three-quarter,
> side and back orthographic views on a neutral grey field. Athletic build,
> **7.2 heads tall**, shoulder-to-hip taper of roughly 1.7 to 1. Deep red
> `#d8324a` short-sleeved shirt with thin white trim at collar and cuff, white
> `#f0f4f8` shorts, red socks, dark boots `#191c22` with a bright mint-green
> flash on the upper. Squad number 9 on the back. Short dark hair. Neutral A-pose
> with arms slightly out. Clean even studio lighting, no dramatic shadows, no
> background. Modelling reference, orthographic, no perspective distortion.

### 8.3 Outfield player — character sheet, away kit

> Orthographic character reference sheet, same athletic proportions as above.
> Periwinkle blue `#5566d8` one-colour shirt with white trim, navy `#2b3492`
> shorts and socks, dark boots with a magenta flash. Squad number 4. Different
> hairstyle — short curls. Neutral A-pose, studio lighting, grey field.

### 8.4 Goalkeeper

> Orthographic character reference sheet for a football goalkeeper, same athletic
> 7.2-head proportions. Teal `#25b596` long-sleeved shirt, dark teal `#12705c`
> shorts and socks, padded gloves in off-white, dark boots. Set position: knees
> soft, weight forward, hands out at hip height, eyes up. Front, side and
> three-quarter views. Studio lighting, grey field, no background.

### 8.5 Head and hairstyle variants

> Four male footballer heads in a row, three-quarter view, matched lighting and
> scale. Left to right: short fade, medium textured crop, short curls, tied-back
> long hair. Four different skin tones spanning light olive to deep brown.
> Athletic, mid-twenties, neutral expression, no beards. Simplified planar
> structure suitable for a low-polygon game head — brow, cheek and jaw read as
> clear planes, not fine detail. Even studio light, grey background.

### 8.6 Boots

> Product photograph of a modern football boot, three-quarter view. Matte
> near-black upper `#191c22` with a single bright mint-green `#00e5a0` flash
> sweeping from the midfoot to the heel, subtle stud pattern on a slightly
> lighter sole. Clean studio lighting on a dark grey seamless background. Sharp
> focus, no branding, no logos, no text.

### 8.7 Kit texture atlas reference

> Flat orthographic layout of football kit panels arranged as a texture atlas on
> a white background: short-sleeved shirt front, shirt back with a large squad
> number, two sleeve panels, shorts front, shorts back, sock. Rendered in flat
> mid-grey with only fabric shading, seams, stitch lines, ribbed collar and
> ventilation mesh — **no colour at all**, greyscale only, so it can be tinted.
> Even lighting, no shadows, no perspective.

### 8.8 Stadium bowl — wide interior

> Wide interior view of a modern 25,000-seat football stadium from a corner,
> taken from high in the stand. One continuous bowl with generously rounded
> corners — not four separate stands. A single steep tier raked at about 29
> degrees, 26 rows, topped by a cantilevered roof overhanging 15 metres. Dark
> striped turf below, low white perimeter wall with pale advertising boards. Full
> crowd reading as low-saturation texture, no individual faces. Overcast even
> light. Architectural photography, photoreal, wide framing without distortion.

### 8.9 Stadium bowl — two-tier target

> Interior of a modern football stadium showing the seating structure in section:
> a lower tier of raked seating, a horizontal facia band at roughly 7 metres
> carrying club banners and a slim LED scoreboard, then a shallower upper tier
> above it, then a cantilevered roof. Rounded corner where two sides meet. Empty
> seats in dark navy, structural steel and cool grey concrete `#20262e`.
> Architectural reference, clear structural read, flat daylight, no crowd.

### 8.10 Roof and floodlight

> Detail of a cantilevered stadium roof seen from below and behind, showing the
> steel truss structure, the underside cladding, and a row of floodlight fittings
> mounted along the front lip. Late golden light raking across the structure from
> the left; the roof lip casts a hard shadow edge. Architectural detail
> photography, cool grey steel, warm light, no background clutter.

### 8.11 Pitch-side props

> Football pitch-side props on a neutral grey field, arranged in a row,
> orthographic: a corner flag with a plain triangular flag on a flexible pole, a
> covered team dugout with six seats and a curved perspex roof, a floodlight
> pylon base, and a low white perimeter wall section with a blank advertising
> board. Clean even lighting, modelling reference, no background, no logos, no
> text.

### 8.12 Turf and mow stripes

> Overhead close-up of a professional football pitch surface. Dark cool green
> grass `#2f7f45` and `#43a259` in alternating mow bands running across frame, a
> crisp painted white line crossing at an angle, individual blade texture visible
> but the bands clearly separated in value. Slightly damp, low specular sheen.
> Even overcast light, photoreal, no players, no shadows.

### 8.13 Goal frame and net

> Football goal photographed square-on from the front at pitch level. Rounded
> white posts and crossbar, a translucent white net with visible sag hung from a
> curved frame, the back panel of the net denser than the sides. Dark striped
> grass in front. Soft overcast light so the net reads as volume rather than
> lines. Photoreal, shallow depth of field on the background, no crowd.

### 8.14 Lighting — afternoon

> Football pitch in bright mid-afternoon sun, sun 40 degrees above the horizon.
> Short hard shadows directly under the players, a clear sky ramp from `#1f4f78`
> at zenith to `#e2edee` at the horizon, crisp saturated colour, minimal haze.
> Neutral-warm grade. Broadcast still, photoreal.

### 8.15 Lighting — golden hour (hero condition)

> Football pitch at golden hour, sun 9 degrees above the horizon and low behind
> the stand. The stadium roof lip throws a hard diagonal shadow edge across the
> grass, brilliant warm light on the far half and cool shadow on the near half.
> Sky ramping from `#243f6b` at zenith through `#b3763f` to `#f5cf9a` at the
> horizon. Long player shadows, warm rim light on every figure, visible
> atmospheric haze at the far end. Broadcast still, photoreal, strong grade.

### 8.16 Lighting — overcast

> Football pitch under heavy overcast, no visible sun. Flat, soft, directionless
> light, cool desaturated grade, `#43505c` to `#c3ccd1` sky. Faintly damp turf
> with a low sheen, no hard shadows anywhere, floodlights on at low power adding
> a slightly warmer fill. Muted, moody, photoreal broadcast still.

### 8.17 Lighting — night under floodlights, wet

> Football pitch at night in the rain, lit entirely by four floodlight pylons.
> Near-black `#060910` sky, brilliant white pooled light on a soaked pitch,
> strong specular streaks reflecting off the wet grass, visible rain streaks
> catching the beams, breath and spray. Cool grade with hard falloff into the
> shadows, crowd reading only as a dim speckled mass beyond the light. Dramatic,
> photoreal, broadcast still.

### 8.18 Camera framing reference

> Portrait 9:19.5 framing reference for a mobile football game. Camera 12 metres
> above the pitch and 30 metres behind the ball, tilted down 20 degrees, long lens
> so the pitch compresses. The ball sits 35% up from the bottom edge, the goal
> mouth in the upper third, the stadium roof line just entering the top of frame.
> Faint composition guides overlaid. Clean, technical, photoreal underlay.

### 8.19 UI — match HUD

> Mobile game UI overlay on a dark navy football scene, portrait phone screen.
> Top left: a compact glass scorebug 42 px tall with a 4 px electric-blue vertical
> bar, two three-letter team codes in condensed bold uppercase, a score block, and
> a match minute in gold. Beside it, a level tag chip. Bottom: a row of touch pips
> and a rewind button. All panels are frosted glass at 4.5% white over the scene
> with a 1 px hairline border, 10 px corner radius, deep soft drop shadow.
> Condensed sports typography, tabular numerals, tight tracking. Flat UI design,
> dark navy `#0b1728`, electric blue `#0090ff`, gold `#ffc233`.

### 8.20 UI — level select

> Mobile game level-select screen, portrait, dark navy background. A vertical list
> of match cards, each 16 px radius frosted glass with a 1 px hairline border,
> showing a shield crest, an opponent name in condensed bold uppercase, a
> competition label in small dimmed tracked-out caps, a row of three star slots in
> gold, and five small difficulty pips on the right with two filled. One card in
> the list has its pips in red as a warning. A 56 px electric-blue primary button
> at the bottom with a subtle inner top highlight. Clean flat UI, 8 px spacing
> grid, generous whitespace.

### 8.21 UI — result card

> Mobile game result screen, portrait, dark navy. A large centred card with three
> gold stars across the top, two filled and one empty, a big condensed uppercase
> headline, a small stat block below in two columns with tabular numerals, an XP
> progress bar in electric blue with a gold fill segment, and two stacked 56 px
> buttons — a filled blue primary and a ghost secondary with a hairline border.
> Frosted glass panels, 22 px radius, deep soft shadows, condensed sports
> typography. Flat UI design.

### 8.22 Crowd reference

> Dense football crowd in a stadium stand, photographed from a distance with a
> long lens so no individual face is identifiable. Mixed muted clothing colours —
> dusty reds, off-whites, tans, navy, grey — reading as a speckled low-saturation
> texture rather than as people. Slightly out of focus, even overcast light, no
> banners, no text.

### 8.23 Ball

> Studio product photograph of a modern football, three-quarter view. Mostly white
> panelled surface with a small amount of electric blue `#0090ff` and gold
> `#ffc233` geometric detailing, subtle textured grain on the panels, soft
> specular highlights. Clean dark grey seamless background, even softbox lighting,
> sharp focus, no branding, no logos, no text.

---

## 9. What this guide does not cover

Blocked on assets that do not exist in the project, per `GRAPHICS-AUDIT.md`:

- **Photographic textures.** Everything is procedural or runtime-painted.
- **Recorded commentary and PA.** A synth cannot fake it; this is a content
  problem, not a code one.
- **Reflections** beyond the wet-sheen specular approximation.
- **Cloth simulation.** Shirts and nets are rigid or vertex-animated.

Do not propose a feature that depends on one of these without saying where the
asset comes from.

---

## 10. Change control

Anything in §2.2 (locked ratios), §5.1 (camera) or §1.1 (the three-hue rule) is
identity. Changing one of them is a redesign, not a tweak, and it invalidates
every screenshot and every other section of this document. Everything else is
open to iteration.

After changing world colour or lighting, capture with the `js/shot.js` harness
and look at the frame — numbers passing is not the same as it looking right, and
several real bugs in this project passed every numeric check.
