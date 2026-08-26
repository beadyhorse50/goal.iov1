/* goal.io — skeletal animation.

   A bone hierarchy in the player's local frame (x right, y forward, z up),
   keyframed clips, and crossfade blending between them. Poses are per-joint
   Euler triples [pitch, yaw, roll] in radians:

     pitch — rotation about the joint's own right axis. POSITIVE SWINGS THE
             BONE'S TIP FORWARD. Bones extend along -U, so a positive pitch
             tips U backwards and the tip forwards.
     yaw   — twist about the joint's own up axis.
     roll  — splay about the joint's own forward axis (arms out, knees apart).

   Joints not mentioned in a keyframe are neutral.
*/
"use strict";

/* offsets are [x, y, z] from the parent joint, in the parent's frame */
var RIG = [
  { n: "pelvis", p: null,     o: [0, 0, 0.88] },
  { n: "spine",  p: "pelvis", o: [0, 0, 0.16] },
  { n: "chest",  p: "spine",  o: [0, 0, 0.28] },
  { n: "neck",   p: "chest",  o: [0, 0, 0.12] },
  { n: "head",   p: "neck",   o: [0, 0, 0.11] },

  { n: "shL",    p: "chest",  o: [-0.228, 0, 0.06] },
  { n: "elL",    p: "shL",    o: [0, 0, -0.26] },
  { n: "haL",    p: "elL",    o: [0, 0, -0.25] },
  { n: "shR",    p: "chest",  o: [0.228, 0, 0.06] },
  { n: "elR",    p: "shR",    o: [0, 0, -0.26] },
  { n: "haR",    p: "elR",    o: [0, 0, -0.25] },

  { n: "hipL",   p: "pelvis", o: [-0.095, 0, -0.06] },
  { n: "knL",    p: "hipL",   o: [0, 0, -0.42] },
  { n: "anL",    p: "knL",    o: [0, 0, -0.40] },
  { n: "hipR",   p: "pelvis", o: [0.095, 0, -0.06] },
  { n: "knR",    p: "hipR",   o: [0, 0, -0.42] },
  { n: "anR",    p: "knR",    o: [0, 0, -0.40] }
];

var RIG_INDEX = (function () {
  var m = {};
  for (var i = 0; i < RIG.length; i++) m[RIG[i].n] = RIG[i];
  return m;
})();

/* ------------------------------------------------------------------ clips
   { loop, dur, keys: [ {t, pose} ] }  — poses interpolate linearly. */
var CLIPS = {

  /* stood waiting: weight slightly forward, arms hanging just off the body */
  idle: {
    loop: true, dur: 3.4,
    keys: [
      { t: 0.0,  pose: { spine: [-0.05, 0, 0], shL: [0.03, 0, -0.16], shR: [0.03, 0, 0.16],
                         elL: [-0.16, 0, 0], elR: [-0.16, 0, 0],
                         hipL: [0.02, 0, -0.03], hipR: [0.02, 0, 0.03],
                         knL: [-0.05, 0, 0], knR: [-0.05, 0, 0] } },
      { t: 1.7,  pose: { spine: [-0.08, 0, 0], shL: [0.06, 0, -0.19], shR: [0.06, 0, 0.19],
                         elL: [-0.20, 0, 0], elR: [-0.20, 0, 0],
                         hipL: [0.02, 0, -0.03], hipR: [0.02, 0, 0.03],
                         knL: [-0.07, 0, 0], knR: [-0.07, 0, 0] } },
      { t: 3.4,  pose: { spine: [-0.05, 0, 0], shL: [0.03, 0, -0.16], shR: [0.03, 0, 0.16],
                         elL: [-0.16, 0, 0], elR: [-0.16, 0, 0],
                         hipL: [0.02, 0, -0.03], hipR: [0.02, 0, 0.03],
                         knL: [-0.05, 0, 0], knR: [-0.05, 0, 0] } }
    ]
  },

  /* a contra-lateral running cycle; driven by stride phase, not wall time */
  run: {
    loop: true, dur: 1.0,
    keys: [
      { t: 0.00, pose: { spine: [-0.16, 0, 0],
                         hipL: [0.72, 0, -0.04], knL: [-0.42, 0, 0], anL: [0.18, 0, 0],
                         hipR: [-0.52, 0, 0.04], knR: [-1.05, 0, 0], anR: [0.30, 0, 0],
                         shL: [-0.62, 0, -0.14], elL: [-0.72, 0, 0],
                         shR: [0.62, 0, 0.14],  elR: [-0.55, 0, 0] } },
      { t: 0.25, pose: { spine: [-0.18, 0, 0],
                         hipL: [0.18, 0, -0.04], knL: [-0.95, 0, 0], anL: [0.10, 0, 0],
                         hipR: [0.05, 0, 0.04],  knR: [-0.22, 0, 0], anR: [0.12, 0, 0],
                         shL: [-0.10, 0, -0.14], elL: [-0.80, 0, 0],
                         shR: [0.10, 0, 0.14],   elR: [-1.35, 0, 0] } },
      { t: 0.50, pose: { spine: [-0.16, 0, 0],
                         hipL: [-0.52, 0, -0.04], knL: [-1.05, 0, 0], anL: [0.30, 0, 0],
                         hipR: [0.72, 0, 0.04],   knR: [-0.42, 0, 0], anR: [0.18, 0, 0],
                         shL: [0.62, 0, -0.14],  elL: [-0.55, 0, 0],
                         shR: [-0.62, 0, 0.14],  elR: [-0.72, 0, 0] } },
      { t: 0.75, pose: { spine: [-0.18, 0, 0],
                         hipL: [0.05, 0, -0.04], knL: [-0.22, 0, 0], anL: [0.12, 0, 0],
                         hipR: [0.18, 0, 0.04],  knR: [-0.95, 0, 0], anR: [0.10, 0, 0],
                         shL: [0.10, 0, -0.14], elL: [-1.35, 0, 0],
                         shR: [-0.10, 0, 0.14], elR: [-0.80, 0, 0] } },
      { t: 1.00, pose: { spine: [-0.16, 0, 0],
                         hipL: [0.72, 0, -0.04], knL: [-0.42, 0, 0], anL: [0.18, 0, 0],
                         hipR: [-0.52, 0, 0.04], knR: [-1.05, 0, 0], anR: [0.30, 0, 0],
                         shL: [-0.62, 0, -0.14], elL: [-0.72, 0, 0],
                         shR: [0.62, 0, 0.14],  elR: [-0.55, 0, 0] } }
    ]
  },

  /* the strike: plant, hips back, leg through, follow-through */
  strike: {
    loop: false, dur: 0.42,
    keys: [
      { t: 0.00, pose: { spine: [0.10, 0.10, 0],
                         hipR: [-0.82, 0, 0.06], knR: [-1.05, 0, 0], anR: [-0.10, 0, 0],
                         hipL: [0.16, 0, -0.05], knL: [-0.26, 0, 0],
                         shL: [0.85, 0, -0.42], elL: [-0.45, 0, 0],
                         shR: [-0.60, 0, 0.30], elR: [-0.30, 0, 0] } },
      { t: 0.15, pose: { spine: [-0.04, -0.06, 0],
                         hipR: [0.62, 0, 0.03], knR: [-0.20, 0, 0], anR: [0.22, 0, 0],
                         hipL: [0.06, 0, -0.05], knL: [-0.14, 0, 0],
                         shL: [-0.35, 0, -0.55], elL: [-0.55, 0, 0],
                         shR: [0.55, 0, 0.34],  elR: [-0.40, 0, 0] } },
      { t: 0.26, pose: { spine: [-0.14, -0.10, 0],
                         hipR: [1.02, 0, 0.02], knR: [-0.06, 0, 0], anR: [0.26, 0, 0],
                         hipL: [-0.04, 0, -0.05], knL: [-0.20, 0, 0],
                         shL: [-0.60, 0, -0.60], elL: [-0.60, 0, 0],
                         shR: [0.80, 0, 0.38],  elR: [-0.45, 0, 0] } },
      { t: 0.42, pose: { spine: [-0.06, 0, 0],
                         hipR: [0.34, 0, 0.04], knR: [-0.40, 0, 0], anR: [0.12, 0, 0],
                         hipL: [0.04, 0, -0.05], knL: [-0.16, 0, 0],
                         shL: [-0.20, 0, -0.30], elL: [-0.35, 0, 0],
                         shR: [0.30, 0, 0.22],  elR: [-0.30, 0, 0] } }
    ]
  },

  /* a shorter, flatter version for a simple pass */
  pass: {
    loop: false, dur: 0.34,
    keys: [
      { t: 0.00, pose: { hipR: [-0.42, 0, 0.05], knR: [-1.05, 0, 0],
                         shL: [0.42, 0, -0.30], shR: [-0.30, 0, 0.22], spine: [0.06, 0.06, 0] } },
      { t: 0.13, pose: { hipR: [0.48, 0, 0.03], knR: [-0.14, 0, 0],
                         shL: [-0.22, 0, -0.40], shR: [0.36, 0, 0.26], spine: [-0.10, -0.05, 0] } },
      { t: 0.34, pose: { hipR: [0.10, 0, 0.04], knR: [-0.20, 0, 0],
                         shL: [-0.08, 0, -0.22], shR: [0.14, 0, 0.18], spine: [-0.04, 0, 0] } }
    ]
  },

  /* A CHIP is a different action from a drive: shorter backlift, the foot goes
     under the ball, and the follow-through stops early rather than swinging
     through. Given its own clip because scaling the driven strike cannot
     produce it — the shape is wrong, not just the amplitude. */
  chip: {
    loop: false, dur: 0.40,
    keys: [
      { t: 0.00, pose: { spine: [0.06, 0.06, 0],
                         hipR: [-0.44, 0, 0.06], knR: [-0.78, 0, 0], anR: [-0.24, 0, 0],
                         hipL: [0.14, 0, -0.05], knL: [-0.24, 0, 0],
                         shL: [0.62, 0, -0.40], elL: [-0.42, 0, 0],
                         shR: [-0.44, 0, 0.28], elR: [-0.28, 0, 0] } },
      /* the foot slides under — ankle extended, knee still bent */
      { t: 0.16, pose: { spine: [0.02, -0.04, 0],
                         hipR: [0.34, 0, 0.03], knR: [-0.34, 0, 0], anR: [0.44, 0, 0],
                         hipL: [0.04, 0, -0.05], knL: [-0.16, 0, 0],
                         shL: [-0.24, 0, -0.50], elL: [-0.50, 0, 0],
                         shR: [0.42, 0, 0.32], elR: [-0.36, 0, 0] } },
      /* clipped follow-through: it stops, it does not swing through */
      { t: 0.40, pose: { spine: [0.00, 0, 0],
                         hipR: [0.44, 0, 0.04], knR: [-0.44, 0, 0], anR: [0.30, 0, 0],
                         hipL: [0.04, 0, -0.05], knL: [-0.16, 0, 0],
                         shL: [-0.16, 0, -0.28], elL: [-0.32, 0, 0],
                         shR: [0.24, 0, 0.20], elR: [-0.26, 0, 0] } }
    ]
  },

  /* Receiving a first touch. The ball is teleported to the receiver's feet by
     the simulation and the camera's shock absorber hides the jump — but the
     PLAYER used to do nothing at all, which is why a pass landed as a
     discontinuity. A short cushion: weight drops, the near foot comes out to
     meet it, then settles. */
  receive: {
    loop: false, dur: 0.46,
    keys: [
      { t: 0.00, pose: { spine: [-0.14, 0, 0],
                         hipR: [0.40, 0, 0.05], knR: [-0.52, 0, 0], anR: [0.20, 0, 0],
                         hipL: [0.10, 0, -0.05], knL: [-0.30, 0, 0],
                         shL: [0.30, 0, -0.46], elL: [-0.48, 0, 0],
                         shR: [0.30, 0, 0.46], elR: [-0.48, 0, 0] } },
      { t: 0.18, pose: { spine: [-0.22, 0.05, 0],
                         hipR: [0.66, 0, 0.05], knR: [-0.36, 0, 0], anR: [0.34, 0, 0],
                         hipL: [0.16, 0, -0.05], knL: [-0.44, 0, 0],
                         shL: [0.44, 0, -0.60], elL: [-0.56, 0, 0],
                         shR: [0.20, 0, 0.38], elR: [-0.40, 0, 0] } },
      { t: 0.46, pose: { spine: [-0.10, 0, 0],
                         hipR: [0.18, 0, 0.04], knR: [-0.30, 0, 0], anR: [0.12, 0, 0],
                         hipL: [0.08, 0, -0.04], knL: [-0.22, 0, 0],
                         shL: [0.16, 0, -0.34], elL: [-0.34, 0, 0],
                         shR: [0.16, 0, 0.34], elR: [-0.34, 0, 0] } }
    ]
  },

  /* Keeper dives. The body roll onto its side is applied outside this clip;
     what happens in here is the shape of the athlete inside that roll.

     The old single clip posed both arms and both legs identically. Rolled onto
     its side, a symmetrical body is a starfish — arms out level, legs straight,
     face down. It read as a corpse rather than a goalkeeper, and no amount of
     roll tuning fixes it, because the problem is the symmetry itself.

     A real dive is asymmetric in every joint: the leading arm reaches past the
     ball, the trailing arm stays tucked toward the chest, the underneath leg
     extends to push, the top knee tucks up, and the spine twists to bring the
     chest around behind the hands. So there are two clips, and pickClip picks
     one by the direction of the dive. diveL leads with the left arm.

     Sign reminder from the top of this file: bones extend along -U, so a
     positive pitch swings a bone's tip FORWARD, and on the upward spine chain
     a positive pitch leans the torso BACKWARDS. */
  diveL: {
    loop: false, dur: 0.62,
    keys: [
      /* gather — weight drops onto the pushing leg, arms cock back */
      { t: 0.00, pose: { spine: [-0.22, 0.10, -0.06], chest: [0, 0.14, 0],
                         shL: [0.62, 0, -0.62], shR: [0.40, 0, 0.44],
                         elL: [-0.85, 0, 0], elR: [-0.68, 0, 0],
                         hipL: [0.30, 0, -0.12], hipR: [0.46, 0, 0.14],
                         knL: [-0.62, 0, 0], knR: [-0.60, 0, 0],
                         neck: [0.05, -0.10, 0] } },
      /* full extension — lead arm long, trail arm across the chest,
         bottom leg driving, top knee starting to tuck */
      { t: 0.24, pose: { spine: [0.02, 0.26, -0.14], chest: [0.04, 0.20, 0],
                         shL: [2.05, 0.16, -0.16], shR: [0.95, 0, 0.72],
                         elL: [-0.05, 0, 0], elR: [-0.70, 0, 0],
                         hipL: [-0.34, 0, -0.05], hipR: [-0.05, 0, 0.18],
                         knL: [-0.12, 0, 0], knR: [-0.62, 0, 0],
                         neck: [0.14, -0.18, 0] } },
      /* landing — hands take it first, chest turns down, top knee tucked,
         bottom leg trailing straight. This is the pose that gets held, so it
         is the one that has to look like a goalkeeper on the floor. */
      { t: 0.62, pose: { spine: [-0.06, 0.30, -0.20], chest: [0.02, 0.24, 0],
                         shL: [1.92, 0.22, -0.10], shR: [1.20, 0, 0.58],
                         elL: [-0.22, 0, 0], elR: [-0.66, 0, 0],
                         hipL: [-0.26, 0, -0.04], hipR: [0.18, 0, 0.22],
                         knL: [-0.30, 0, 0], knR: [-0.66, 0, 0],
                         neck: [0.10, -0.22, 0] } }
    ]
  },

  diveR: {
    loop: false, dur: 0.62,
    keys: [
      { t: 0.00, pose: { spine: [-0.22, -0.10, 0.06], chest: [0, -0.14, 0],
                         shL: [0.40, 0, -0.44], shR: [0.62, 0, 0.62],
                         elL: [-0.68, 0, 0], elR: [-0.85, 0, 0],
                         hipL: [0.46, 0, -0.14], hipR: [0.30, 0, 0.12],
                         knL: [-0.60, 0, 0], knR: [-0.62, 0, 0],
                         neck: [0.05, 0.10, 0] } },
      { t: 0.24, pose: { spine: [0.02, -0.26, 0.14], chest: [0.04, -0.20, 0],
                         shL: [0.95, 0, -0.72], shR: [2.05, -0.16, 0.16],
                         elL: [-0.70, 0, 0], elR: [-0.05, 0, 0],
                         hipL: [-0.05, 0, -0.18], hipR: [-0.34, 0, 0.05],
                         knL: [-0.62, 0, 0], knR: [-0.12, 0, 0],
                         neck: [0.14, 0.18, 0] } },
      { t: 0.62, pose: { spine: [-0.06, -0.30, 0.20], chest: [0.02, -0.24, 0],
                         shL: [1.20, 0, -0.58], shR: [1.92, -0.22, 0.10],
                         elL: [-0.66, 0, 0], elR: [-0.22, 0, 0],
                         hipL: [0.18, 0, -0.22], hipR: [-0.26, 0, 0.04],
                         knL: [-0.66, 0, 0], knR: [-0.30, 0, 0],
                         neck: [0.10, 0.22, 0] } }
    ]
  },

  celebrate: {
    loop: true, dur: 1.1,
    keys: [
      { t: 0.00, pose: { spine: [0.18, 0, 0], neck: [0.22, 0, 0],
                         shL: [2.35, 0, -0.45], shR: [2.35, 0, 0.45],
                         elL: [-0.25, 0, 0], elR: [-0.25, 0, 0],
                         hipL: [0.20, 0, -0.06], hipR: [-0.10, 0, 0.06],
                         knL: [-0.30, 0, 0], knR: [-0.15, 0, 0] } },
      { t: 0.55, pose: { spine: [0.24, 0, 0], neck: [0.26, 0, 0],
                         shL: [2.60, 0, -0.62], shR: [2.60, 0, 0.62],
                         elL: [-0.14, 0, 0], elR: [-0.14, 0, 0],
                         hipL: [-0.10, 0, -0.06], hipR: [0.20, 0, 0.06],
                         knL: [-0.15, 0, 0], knR: [-0.30, 0, 0] } },
      { t: 1.10, pose: { spine: [0.18, 0, 0], neck: [0.22, 0, 0],
                         shL: [2.35, 0, -0.45], shR: [2.35, 0, 0.45],
                         elL: [-0.25, 0, 0], elR: [-0.25, 0, 0],
                         hipL: [0.20, 0, -0.06], hipR: [-0.10, 0, 0.06],
                         knL: [-0.30, 0, 0], knR: [-0.15, 0, 0] } }
    ]
  },

  /* defender set, ready to move */
  brace: {
    loop: true, dur: 2.2,
    keys: [
      { t: 0.0, pose: { spine: [-0.10, 0, 0],
                        shL: [0.20, 0, -0.34], shR: [0.20, 0, 0.34],
                        elL: [-0.55, 0, 0], elR: [-0.55, 0, 0],
                        hipL: [0.26, 0, -0.10], hipR: [0.26, 0, 0.10],
                        knL: [-0.42, 0, 0], knR: [-0.42, 0, 0] } },
      { t: 1.1, pose: { spine: [-0.13, 0, 0],
                        shL: [0.24, 0, -0.38], shR: [0.24, 0, 0.38],
                        elL: [-0.60, 0, 0], elR: [-0.60, 0, 0],
                        hipL: [0.32, 0, -0.10], hipR: [0.32, 0, 0.10],
                        knL: [-0.50, 0, 0], knR: [-0.50, 0, 0] } },
      { t: 2.2, pose: { spine: [-0.10, 0, 0],
                        shL: [0.20, 0, -0.34], shR: [0.20, 0, 0.34],
                        elL: [-0.55, 0, 0], elR: [-0.55, 0, 0],
                        hipL: [0.26, 0, -0.10], hipR: [0.26, 0, 0.10],
                        knL: [-0.42, 0, 0], knR: [-0.42, 0, 0] } }
    ]
  },

  /* Two more celebrations. One is not a celebration, it is a pose — the same
     arms-aloft every goal for a whole career reads as a bug. These are chosen
     by the scorer's squad number so a given player always celebrates the same
     way, which is how real players read as characters. */

  /* arms wide, chest out, head back — the "point to the crowd" */
  celebrate2: {
    loop: true, dur: 1.35,
    keys: [
      { t: 0.00, pose: { spine: [0.22, 0.10, 0], neck: [0.26, 0, 0],
                         shL: [1.55, 0, -1.20], shR: [1.55, 0, 1.20],
                         elL: [-0.18, 0, 0], elR: [-0.18, 0, 0],
                         hipL: [0.14, 0, -0.06], hipR: [-0.06, 0, 0.06],
                         knL: [-0.24, 0, 0], knR: [-0.12, 0, 0] } },
      { t: 0.66, pose: { spine: [0.28, -0.10, 0], neck: [0.30, 0, 0],
                         shL: [1.72, 0, -1.36], shR: [1.72, 0, 1.36],
                         elL: [-0.10, 0, 0], elR: [-0.10, 0, 0],
                         hipL: [-0.06, 0, -0.06], hipR: [0.14, 0, 0.06],
                         knL: [-0.12, 0, 0], knR: [-0.24, 0, 0] } },
      { t: 1.35, pose: { spine: [0.22, 0.10, 0], neck: [0.26, 0, 0],
                         shL: [1.55, 0, -1.20], shR: [1.55, 0, 1.20],
                         elL: [-0.18, 0, 0], elR: [-0.18, 0, 0],
                         hipL: [0.14, 0, -0.06], hipR: [-0.06, 0, 0.06],
                         knL: [-0.24, 0, 0], knR: [-0.12, 0, 0] } }
    ]
  },

  /* one fist pumped, the other arm down — a contained, aggressive celebration */
  celebrate3: {
    loop: true, dur: 0.92,
    keys: [
      { t: 0.00, pose: { spine: [0.14, -0.14, 0], neck: [0.18, 0.10, 0],
                         shL: [0.30, 0, -0.30], shR: [2.30, 0, 0.42],
                         elL: [-0.40, 0, 0], elR: [-0.62, 0, 0],
                         hipL: [0.18, 0, -0.06], hipR: [-0.04, 0, 0.06],
                         knL: [-0.30, 0, 0], knR: [-0.16, 0, 0] } },
      { t: 0.42, pose: { spine: [0.24, -0.20, 0], neck: [0.24, 0.14, 0],
                         shL: [0.20, 0, -0.24], shR: [2.62, 0, 0.30],
                         elL: [-0.34, 0, 0], elR: [-0.20, 0, 0],
                         hipL: [0.08, 0, -0.06], hipR: [0.06, 0, 0.06],
                         knL: [-0.20, 0, 0], knR: [-0.24, 0, 0] } },
      { t: 0.92, pose: { spine: [0.14, -0.14, 0], neck: [0.18, 0.10, 0],
                         shL: [0.30, 0, -0.30], shR: [2.30, 0, 0.42],
                         elL: [-0.40, 0, 0], elR: [-0.62, 0, 0],
                         hipL: [0.18, 0, -0.06], hipR: [-0.04, 0, 0.06],
                         knL: [-0.30, 0, 0], knR: [-0.16, 0, 0] } }
    ]
  },

  /* GOALKEEPER SET POSITION.

     The keeper was running the ordinary idle: stood upright, arms hanging,
     rocking very gently. In the aim frame — which is the frame the player
     spends most of their time looking at — that read as a mannequin propped up
     on the goal line, and it undercut everything else in the shot.

     A keeper waiting for a shot is a coiled spring, and all of it is readable
     in silhouette: knees bent, weight forward over the toes, chest down, hands
     up and away from the body at about hip-to-waist height, and a constant
     small bounce so they are always ready to push off either way. The bounce
     is the part that makes it look alive rather than posed, so the two keys
     sit fairly far apart in height.

     Sign note (see the top of this file): bones extend along -U, so on the
     upward spine chain a NEGATIVE pitch leans the torso forwards, which is
     what is wanted here. */
  keeperSet: {
    loop: true, dur: 1.25,
    keys: [
      /* Values here are deliberately moderate, and that is a constraint of the
         renderer rather than of the pose. Two things break if pushed:

         - Knees past about 0.6 rad open a gap at the joint, because the thigh
           inside the shorts and the shin inside the boot are not built at all
           (there is no z-buffer, so hidden geometry is omitted rather than
           occluded). A deep crouch makes the omission visible.
         - Elbows past about 0.7 rad swing the forearms straight down the
           camera axis, where they foreshorten to nothing and the hands vanish
           behind them. The keeper ended up looking like they had one stump.

         So the stance reads through SHOULDER SPLAY and a forward lean instead:
         hands held wide and high in silhouette, chest down, knees only softly
         bent. Silhouette is what carries at gameplay distance anyway. */
      { t: 0.00, pose: { spine: [-0.24, 0, 0], chest: [-0.08, 0, 0],
                         neck: [0.14, 0, 0],
                         shL: [0.30, 0, -1.02], shR: [0.30, 0, 1.02],
                         elL: [-0.46, 0, -0.20], elR: [-0.46, 0, 0.20],
                         hipL: [0.34, 0, -0.17], hipR: [0.34, 0, 0.17],
                         knL: [-0.50, 0, 0], knR: [-0.50, 0, 0] } },
      /* the ready bounce — rises and narrows slightly */
      { t: 0.52, pose: { spine: [-0.17, 0, 0], chest: [-0.05, 0, 0],
                         neck: [0.11, 0, 0],
                         shL: [0.24, 0, -0.88], shR: [0.24, 0, 0.88],
                         elL: [-0.36, 0, -0.16], elR: [-0.36, 0, 0.16],
                         hipL: [0.22, 0, -0.14], hipR: [0.22, 0, 0.14],
                         knL: [-0.34, 0, 0], knR: [-0.34, 0, 0] } },
      /* weight shifts across — never let both halves match, or it reads as a
         mannequin being scaled up and down */
      { t: 0.86, pose: { spine: [-0.22, 0.06, 0], chest: [-0.07, 0.05, 0],
                         neck: [0.13, -0.05, 0],
                         shL: [0.27, 0, -0.96], shR: [0.33, 0, 1.06],
                         elL: [-0.42, 0, -0.18], elR: [-0.50, 0, 0.22],
                         hipL: [0.30, 0, -0.16], hipR: [0.38, 0, 0.18],
                         knL: [-0.44, 0, 0], knR: [-0.54, 0, 0] } },
      { t: 1.25, pose: { spine: [-0.24, 0, 0], chest: [-0.08, 0, 0],
                         neck: [0.14, 0, 0],
                         shL: [0.30, 0, -1.02], shR: [0.30, 0, 1.02],
                         elL: [-0.46, 0, -0.20], elR: [-0.46, 0, 0.20],
                         hipL: [0.34, 0, -0.17], hipR: [0.34, 0, 0.17],
                         knL: [-0.50, 0, 0], knR: [-0.50, 0, 0] } }
    ]
  }
};

/* ------------------------------------------------------- pose evaluation */
function evalClip(clip, t, out) {
  out = out || {};
  for (var k in out) delete out[k];
  if (!clip) return out;

  var time = clip.loop ? (t % clip.dur + clip.dur) % clip.dur : Math.min(t, clip.dur);
  var keys = clip.keys, i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < time) i++;
  var a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  var span = b.t - a.t;
  var u = span > 0.0001 ? clamp((time - a.t) / span, 0, 1) : 0;
  u = u * u * (3 - 2 * u);                       // ease so keys don't snap

  var j, av, bv;
  for (j in a.pose) {
    av = a.pose[j]; bv = b.pose[j] || [0, 0, 0];
    out[j] = [av[0] + (bv[0] - av[0]) * u,
              av[1] + (bv[1] - av[1]) * u,
              av[2] + (bv[2] - av[2]) * u];
  }
  for (j in b.pose) {
    if (out[j]) continue;
    av = a.pose[j] || [0, 0, 0]; bv = b.pose[j];
    out[j] = [av[0] + (bv[0] - av[0]) * u,
              av[1] + (bv[1] - av[1]) * u,
              av[2] + (bv[2] - av[2]) * u];
  }
  return out;
}

function blendPose(a, b, w, out) {
  out = out || {};
  for (var k in out) delete out[k];
  var j, av, bv;
  for (j in a) {
    av = a[j]; bv = b[j] || [0, 0, 0];
    out[j] = [av[0] + (bv[0] - av[0]) * w,
              av[1] + (bv[1] - av[1]) * w,
              av[2] + (bv[2] - av[2]) * w];
  }
  for (j in b) {
    if (out[j]) continue;
    av = [0, 0, 0]; bv = b[j];
    out[j] = [bv[0] * w, bv[1] * w, bv[2] * w];
  }
  return out;
}

/* --------------------------------------------------------------- player */
function Animator() {
  this.cur = "idle"; this.t = 0;
  this.prev = null;  this.prevT = 0;
  this.fade = 0;     this.fadeDur = 0.16;
  this.amp = 1;                       /* pose amplitude, see scalePose */
  this._a = {}; this._b = {}; this._o = {}; this._s = {};
}

Animator.prototype.play = function (name, restart) {
  if (this.cur === name && !restart) return;
  if (!CLIPS[name]) return;
  this.prev = this.cur; this.prevT = this.t;
  this.fadeDur = name === "strike" || name === "pass" ? 0.07 : 0.16;
  this.fade = 1;
  this.cur = name; this.t = 0;
};

Animator.prototype.step = function (dt) {
  this.t += dt;
  if (this.fade > 0) {
    this.prevT += dt;
    this.fade -= dt / this.fadeDur;
    if (this.fade <= 0) { this.fade = 0; this.prev = null; }
  }
};

/* Scale a pose away from neutral.

   Used to drive the strike from the power of the kick: at 0.4 the backlift and
   follow-through are two thirds of full, at 1.0 they are slightly past it. This
   is amplitude only — the SHAPE of the action is the clip's job, which is why a
   chip needed its own clip rather than a scale factor.

   Applied after blending so it also scales through a crossfade. */
function scalePose(pose, k, out) {
  out = out || {};
  for (var j in out) delete out[j];
  for (var n in pose) {
    var v = pose[n];
    out[n] = [v[0] * k, v[1] * k, v[2] * k];
  }
  return out;
}

/* crossfade the outgoing clip into the incoming one */
Animator.prototype.pose = function () {
  var cur = evalClip(CLIPS[this.cur], this.t, this._a);
  var out = cur;
  if (this.fade > 0 && this.prev) {
    var old = evalClip(CLIPS[this.prev], this.prevT, this._b);
    out = blendPose(old, cur, 1 - this.fade, this._o);
  }
  if (this.amp !== 1) out = scalePose(out, this.amp, this._s);
  return out;
};

/* ------------------------------------------------------------- solve rig
   Walks the hierarchy and returns { joint: {o, R, F, U} } in world space.
   `bR/bF/bU` is the player's body basis, `root` the pelvis world position. */
function rotAxis(v, axis, ang) {
  var c = Math.cos(ang), s = Math.sin(ang);
  var d = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  return {
    x: v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * (1 - c),
    y: v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * (1 - c),
    z: v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * (1 - c)
  };
}

function solveRig(pose, root, bR, bF, bU, out) {
  out = out || {};
  for (var i = 0; i < RIG.length; i++) {
    var j = RIG[i];
    var pR, pF, pU, po;
    if (j.p === null) { pR = bR; pF = bF; pU = bU; po = root; }
    else { var pj = out[j.p]; pR = pj.R; pF = pj.F; pU = pj.U; po = pj.o; }

    var o = {
      x: po.x + pR.x * j.o[0] + pF.x * j.o[1] + pU.x * j.o[2],
      y: po.y + pR.y * j.o[0] + pF.y * j.o[1] + pU.y * j.o[2],
      z: po.z + pR.z * j.o[0] + pF.z * j.o[1] + pU.z * j.o[2]
    };

    var R = pR, F = pF, U = pU;
    var a = pose[j.n];
    if (a) {
      if (a[2]) { U = rotAxis(U, F, a[2]); R = rotAxis(R, F, a[2]); }   // roll
      if (a[0]) { U = rotAxis(U, R, a[0]); F = rotAxis(F, R, a[0]); }   // pitch
      if (a[1]) { R = rotAxis(R, U, a[1]); F = rotAxis(F, U, a[1]); }   // yaw
    }
    out[j.n] = { o: o, R: R, F: F, U: U };
  }
  return out;
}

/* length of a joint's offset from its parent — the bone length above it */
function boneLen(name) {
  var j = RIG_INDEX[name];
  return j ? Math.hypot(j.o[0], j.o[1], j.o[2]) : 0;
}
