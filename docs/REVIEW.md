# goal.io — competitor review and pre-release rejection report

Two reports that were asked for and not delivered during the polish pass. Written
against the build as it stands after that pass, with measurements from
`T.balance()` and `js/shot.js` where numbers are quoted.

A note on method: the competitor comparison is from knowledge of these titles,
not from running them side by side on a device. Where I am asserting something
about a competitor I have kept it to things that are structural and well known
about them, not to specifics I cannot check.

---

# PART 1 — COMPETITOR REVIEW

Benchmarks: **Score! Hero 2** (the direct comparator — same swipe-to-shoot
premise), **Dream League Soccer**, **FIFA Mobile / EA FC Mobile**,
**eFootball Mobile**, **Top Eleven** (for menu and meta polish).

## 1. Visual quality — 6/10 → 7/10 against the field

Where goal.io now competes: stripe work, atmospheric depth, per-match weather
and time of day, and colour grading are genuinely at Score! Hero's level and in
places past it. Score! Hero does not vary conditions per match at all.

Where it loses:

- **Shadows are better but not real.** There is now an ambient-occlusion
  contact pool under every figure plus a cast silhouette that softens and fades
  with the light — which fixes the "hovering with a stain nearby" read. It is
  still a projection, not a shadow map: nothing casts onto anything except the
  ground plane.
- **No texture on anything.** Every surface is a flat fill or a linear
  gradient. The turf noise is a single tiling grain overlay. Competitors sample
  real turf, kit fabric and net textures; that is the single largest remaining
  gap in raw fidelity and it is a WebGL problem, not a tuning problem.
- **Hoardings blow out to pure white** at the frame edge in bright conditions.
  Every competitor tone-maps these.
- **The pitch has no goalmouth wear where the camera actually looks.** The
  `WEAR[]` table has entries but they are subtle to the point of invisibility.

## 2. Camera quality — 7/10 → 8/10

The strongest area relative to the field. The goal camera's two composed beats
and the off-axis net framing are better than Score! Hero's, which mostly holds
one angle. Measured jerk of 0.066 m/frame² is genuinely smooth.

Losses:

- **Anticipation is partial.** The celebration camera now leads the scorer
  along their velocity, and passes get a forward drift — but nothing leads a
  shot *before* it is struck, which is what a broadcast operator does.
- **No momentum or overshoot.** The camera eases to its target and stops. Real
  operators overshoot slightly and settle; the absence is why motion reads
  slightly mechanical.
- **One camera language for all 15 levels.** There are now four distinct shots
  (play, goal beats A/B, miss, replay) but no per-scenario framing: no low
  dramatic angle for a free kick, no high wide for a long-range effort.

## 3. Animation quality — 5/10 → 7/10 (addressed)

Was the weakest axis. Every item below has been closed except the last two.

- **13 clips, up from 7.** Added `chip` (its own shape — a scaled drive cannot
  produce a chip, the follow-through is clipped rather than swung through),
  `receive` (a first-touch cushion), and `celebrate2`/`celebrate3`.
- **Strike now scales with power.** `Animator.amp` scales the pose away from
  neutral, driven by the recorded kick speed: measured 0.557 rad of hip swing at
  low power against 0.856 at full. A tap and a rocket no longer look identical,
  which mattered because shooting is the action the player repeats most.
- **Three celebrations**, chosen by squad number so a given player always
  celebrates the same way — that repetition is what makes them read as a
  character rather than a random picker.
- **First touch is animated.** The ball still teleports to the receiver's feet
  (that is the simulation's design), but the player now cushions it, so a pass
  lands as an action rather than a discontinuity.
- **Idle variation.** A per-player phase offset on idle and brace, so eleven
  players stop breathing in unison.
- **Foot planting is correct** and measured — see `STRIDE_K` in the handover.

Still open: **no blend trees** (clips crossfade pairwise, which is enough at
this camera distance but caps how complex the movement can get), and **no
dedicated turn, deceleration or off-balance recovery animations.**

## 4. User interface — 7/10 → 8/10 (rebuilt)

Rebuilt on a navy / electric-blue / gold palette with an 8px spacing scale and a
fixed type ramp. One card treatment everywhere — navy glass, hairline border, lit
top edge, real drop shadow — so nothing in the interface is bespoke. Buttons are
56px with an inner highlight, a travelling specular band and a 60ms-down /
260ms-back spring. Motion (stagger, press, star landings) is at or above Score!
Hero's.

Losses that remain:

- **Typography is still system-font dependent**, only mitigated. The stack is
  condensed-first with `font-stretch:92%`, which holds the identity where a
  condensed face or a variable system font exists — but bundling a real webfont
  is the only complete fix, and every competitor does it.
- **No layered depth in menus.** The backdrop now carries a centre-circle arc
  and pitch bands, but it is still flat behind the content. FIFA Mobile and Top
  Eleven use parallax.
- **Card content is thin.** Match tiles now carry a difficulty band and a
  next-up highlight; competitors also show a crest, the opponent and a reward.

## 5. Match presentation — 5/10 → 7/10 (mostly addressed)

- Kickoff card, animated scorebug and a full goal sequence.
- **Goal replay now exists**, which was the biggest hole: 0.45x playback of the
  whole attempt from a low angle behind the near post, broadcast banner with a
  live progress rule, holding on the final frame. It replays from a tape of the
  real attempt — ball plus every player's position, facing, velocity and stride
  phase — so it uses the real animation and lighting rather than being faked.
- **Post-mortem on a miss**: flight line, keeper's committed dive arc, and the
  miss distance in centimetres, over a camera composed to hold both the goal and
  the ball's end point.
- Still missing: half-time and full-time stings, substitution furniture, stat
  overlays.
- **No commentary or PA.** Competitors all have at least stock VO. goal.io has
  crowd and whistle only. This is a large perceived-production-value gap and it
  is expensive to close honestly (voice recording), which is worth saying out
  loud rather than pretending a synth can do it.

## 6. Menu polish — 7/10 → 8/10

Transitions, press states, boot screen, and a settings screen with audio and
haptics toggles plus a two-step progress reset. Missing: no quality/graphics
toggle, no achievements or stats page, no store or meta layer — fine for a
premium single-player career, but every free-to-play competitor uses that layer
for retention.

## 7. Game feel — 7/10 → 8/10

The area that improved most. Hit-stop, trauma shake, lens punch, ball squash,
layered audio with a ducking crowd bed, and a goal timeline put this near the
top of the category. Score! Hero's strike feel is, honestly, thinner than
goal.io's now.

Remaining: **no strike anticipation** — the ball still leaves with no wind-up
frame, because the swipe releases and the kick happens on the same event. A
chip, a drive and a pass now differ in animation and in camera language (a pass
gets a slower push and a lateral drift rather than a punch), but their *impact*
profiles are still one sound scaled by volume and shake.

## 8. Player engagement — 4/10 → 6/10

Was the weakest axis by a distance. Two of the three causes are now closed.

- **Difficulty is still brutal, but no longer unexplained.** Measured win rates
  on random input: median ~5%, and **level 13 at 0.7%, level 10 at 1.0%,
  level 9 at 1.0%** against level 6 at 26% — a **37×** spread. Human play is
  aimed rather than random so real rates are far higher, but the ratio is what
  matters. Match tiles now carry a difficulty band with the three outliers
  marked red, and their pre-match brief warns explicitly. **The levels
  themselves are still untuned** — that is a design decision, not an oversight.
- **Onboarding is now a guided first touch.** A ghost stroke draws itself on the
  grass, in world perspective, looping until the player touches the screen. Runs
  once ever. Teaching the *curve* by showing it is the whole point: it is the
  one thing about this game that cannot be learned from a text bullet.
- **Failure is now legible.** A post-mortem overlay draws the real flight line,
  the keeper's committed dive arc and the miss distance in centimetres, framed by
  a camera composed to hold both the goal and where the ball finished.
- **15 levels and done.** No endless mode, no daily challenge, no reason to
  return once the career is finished.
- **No reward loop.** Stars accumulate and unlock the next match. Nothing else.

---

# PART 2 — PRE-RELEASE REJECTION REPORT

Reviewing as a publisher looking for reasons this does not hold a 4.8. Each item
has the retention argument, because that is the test.

## Would reject on these

### R1 — Onboarding (severity: highest) — **CLOSED**
Seven bullets of text behind a "HOW TO PLAY" button, and level 1 drops the
player straight into a live shot with a one-line tip.
**Retention cost:** the swipe-to-curve mechanic is not discoverable. A player
who does not realise the *shape* of the line controls the bend will read the
game as random and churn inside two minutes. This is the classic day-0 drop.
**Fix:** an interactive first touch — hold the level, draw a ghost line, let
them trace it, then release. Nothing else in this list matters as much.

### R2 — Failure feedback is opaque (severity: high) — **CLOSED**
`world.eventInfo` holds a sentence and the result card prints it. There is no
spatial information at all: no keeper dive path, no near-miss marker, no
"6 inches wide".
**Retention cost:** a player who cannot see *why* they failed cannot form a
theory to improve, so repeated failure feels arbitrary rather than instructive.
Difficulty is only motivating when it is legible.
**Fix:** on a miss, hold the frame and draw the flight path with the keeper's
dive and the distance from the post. The data is already there — `world.path`,
`gk.dive`, `goalX/goalZ`.

### R3 — Difficulty spread is unsignposted (severity: high) — **PARTLY CLOSED**
(pips and a pre-match warning are in; the three outlier levels are still
untuned, which was deliberate — retuning them needs `T.balance()` iteration and
a decision about whether they *should* be that hard.)
Measured 37× spread in win rate between the easiest and hardest levels with no
difficulty indicator anywhere in the UI.
**Retention cost:** players hit level 10 or 13 after a run of successes and
experience it as the game breaking rather than as a challenge.
**Fix:** a difficulty band on each match tile, and re-tune the three outliers.

### R4 — One strike animation (severity: medium-high) — **CLOSED**
Every shot from a tap to a maximum-power drive plays the same clip.
**Retention cost:** the core interaction is shooting. If the most repeated
action in the game looks identical every time regardless of input, the game
stops feeling responsive to *skill* — which is precisely what a skill game
sells.
**Fix:** scale wind-up and follow-through by power; separate chip and driven
strikes.

### R5 — No replay (severity: medium) — **CLOSED**
A goal cuts to a result card after 3.4 s.
**Retention cost:** the replay is the share moment and the reward moment. Its
absence removes the game's only natural screenshot/share beat.

### R6 — Font dependency (severity: medium) — **MITIGATED, not closed**
(a condensed-first stack plus `font-stretch:92%` keeps the identity on the
platforms that have a condensed face or a variable system font; bundling a real
webfont is still the only complete fix.)
The condensed identity vanishes on iOS.
**Retention cost:** first-impression quality on the platform that monetises
best. A player on iPhone is not seeing the game that was designed.
**Fix:** bundle one variable font. Cheap, contained, large effect.

### R7 — No settings (severity: medium) — **CLOSED**
No audio toggle. The game starts a crowd bed and plays a whistle on level start
with no way to silence it.
**Retention cost:** mobile play is frequently in public. No mute is a
uninstall-grade annoyance and a common 1-star review.

### R8 — Content ends (severity: medium)
15 levels, no post-career loop.
**Retention cost:** day-7 retention has nothing to hold onto.

### R9 — Player models at close range (severity: low-medium)
Shoulder cap stands proud, hands barely visible with arms down, knee seam past
0.6 rad.
**Retention cost:** low in play (players are ~90 px), real in store screenshots
and in the celebration camera, which is where marketing material comes from.

### R10 — Heavy levels at 13–14 ms desktop (severity: low-medium, unquantified)
Levels 5, 10, 11 are 13–14 ms on desktop. On a mid-range Android this plausibly
misses 60 fps.
**Retention cost:** unknown until measured on a device. Flagging as unverified
rather than asserting it, because I have not run this on hardware.

## Would not reject on these
Controls (the swipe model is sound, anchoring the line at the ball so the thumb
never covers it is genuinely well judged), art direction coherence, audio
quality, goal moment, menu motion, level variety of scenario.

---

# What is left

Items 1, 2, 4, 5, 7 from the original list are closed; 3 and 6 are partly done.
What remains, in order:

1. **Re-tune levels 9, 10 and 13** (R3). Pips warn the player now, but a 37x
   spread in win rate is still a design decision nobody has actually made. Needs
   `T.balance()` iteration.
2. **Bundle a real webfont** (R6). Small work, disproportionate effect on iOS.
3. **Content loop beyond the 15-match career** (R8). Nothing holds day 7.
4. **Half-time / full-time stings** to finish the broadcast furniture.
5. **WebGL renderer** — unlocks textures, real shadows, true post-processing,
   and is the only route past the current fidelity ceiling.
6. **Player close-up geometry** (R9) — shoulder cap, hands, knee seam.
7. **Commentary / PA.** Needs recorded voice; a synth cannot fake it.

The ordering point from the first pass still holds: items 1–4 are design and
presentation work on the existing renderer and all of them beat the WebGL
rewrite on impact per hour. The rewrite is right for fidelity, not next.
