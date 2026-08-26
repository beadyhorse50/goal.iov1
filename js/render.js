/* goal.io — 3D perspective renderer.
   A pinhole camera sits behind and above the ball, looking down the pitch at
   the goal. Everything the simulation produces is already in real metres, so
   this file only projects it. Screen space is CSS pixels; ctx is pre-scaled
   by DPR in renderWorld.
*/
"use strict";

var cvs, ctx, DPR = 1;
var VP = { x: 0, y: 0, w: 0, h: 0 };      // portrait play area inside the canvas
var NEAR = 0.35;
var SURROUND = 6.0;      // metres of grass outside the touchlines, then the boards
var FOV_Y = 52 * Math.PI / 180;

/* camera state, smoothed toward its target each frame */
var Cam = {
  px: 0, py: 20, pz: 12,                  // position
  tx: 0, ty: -10, tz: 1,                  // look-at
  F: 900,                                 // focal length in pixels
  r: { x: 1, y: 0, z: 0 },                // basis vectors, rebuilt per frame
  u: { x: 0, y: 0, z: 1 },
  f: { x: 0, y: -1, z: 0 },
  cx: 0, cy: 0                            // screen centre
};

var COL = {
  /* The two mow directions need real separation or the stripes vanish once the
     depth haze lifts the far end. Lit variants are the sheen at the band edge. */
  /* Deepened and cooled from #4fbf68/#3b9751. Those were mint greens, and with
     a broad ambient probe lifting every surface toward the sky colour they came
     out on screen as traffic-light green -- the single strongest arcade tell in
     the frame. Televised turf is darker and sits closer to a blue-green; the
     mow stripes then have somewhere to go, because a stripe on a nearly-clipped
     green has no headroom to be lighter in. */
  grass1: "#43a259", grass2: "#2f7f45",
  grass1Lit: "#51b166", grass2Lit: "#388c4e",       // clearly striped turf
  line: "rgba(255,255,255,.95)",
  /* A white torso between two red sleeves read as a sheet of paper taped to
     the player, and no amount of banding fixed it — the problem is a
     high-contrast block boundary running straight down the silhouette with no
     shading across it. A single-colour shirt with white trim has no such
     boundary, reads cleanly at gameplay distance, and lets the white shorts
     break the silhouette at the waist instead. */
  us: "#d8324a", usAlt: "#f0f4f8", usSock: "#d8324a",   // red shirt, white shorts
  them: "#5566d8", themAlt: "#2b3492", themSock: "#2b3492",
  gk: "#25b596", gkAlt: "#12705c", gkSock: "#12705c",
  skin: "#d59b70", hair: "#39291d", boot: "#191c22",
  /* Modern boots are never black. A flash colour on the upper is the single
     detail that dates a football game most obviously if it is missing. */
  bootFlash: ["#00e5a0", "#ff2e93", "#ffc233", "#38b0ff", "#f2f5f8", "#ff6a2b"],
  skins: ["#f0c9a4", "#dda87c", "#c08a5c", "#96613c", "#6d4227"],
  hairs: ["#2a1d14", "#4a3220", "#1b1512", "#6b4a28", "#2f2320"]
};

/* heads for the near crowd — shirt colours on a face read as a mannequin */
/* Above this on-screen height a spectator is drawn with a head and shoulders
   instead of a single block, and no more than CROWD_DETAIL_MAX of them per
   bank — the goal camera sits close to a stand, and without a cap the detailed
   path is the most expensive thing in that frame. */
/* Measured on the goal camera, which is the worst case because it sits ~10 m
   from a stand: no detail 9.1 ms, px15/max130 11.8 ms, px18/max90 10.5 ms.
   18/90 keeps heads on everyone big enough for the difference to be visible
   while staying within 1 ms of the original whole-frame budget. */
var CROWD_DETAIL_PX = 18;
var CROWD_DETAIL_MAX = 90;

var CROWD_SKIN = ["#e8bb91", "#d3a074", "#b8825a", "#8f5f3e", "#69422a", "#f0cda9"];

/* a warm, mixed crowd rather than a field of green dots */
var CROWD_COLS = [
  "#d9ab80", "#f3ece1", "#c33b2e", "#8d5b3b", "#e7e0d3", "#6d4831",
  "#3a4170", "#d2603a", "#f5f5f5", "#a43c3c", "#e8c98a", "#4d4f57"
];

/* fixed key light, used for lambert shading and for shadow offset direction */
/* THE ACTIVE CONDITION.

   Set once when a level starts and read by the sky, the turf, the haze, the
   floodlights and the crowd. Defaults to a bright afternoon so the renderer
   still works if nothing sets it (the headless harness never does). */
var COND = null;
function setCondition(c) {
  COND = c || null;
  RAIN = null;                     // rebuilt on demand at the new density
  var k = cond();
  setSun(k.sunEl == null ? 40 : k.sunEl, k.sunAz == null ? 128 : k.sunAz);
}

function cond() {
  if (COND) return COND;
  if (typeof CONDITIONS !== "undefined") return CONDITIONS.afternoon;
  return { light: 1, warm: 0.55, flood: 0.1, wet: 0, rain: 0, haze: 1,
           sky: ["#1f4f78", "#77b1cf", "#e2edee"] };
}

/* THE KEY LIGHT.

   Was (-0.32, 0.42, 0.85): 58 degrees of elevation, which is close to noon.
   That is a poor light for football. It flattens standing figures — a vertical
   surface is nearly edge-on to it, so players got almost no direct light and
   their shadows were stubby blobs directly beneath them.

   Dropped to about 40 degrees, which is a late-afternoon kick-off and the
   elevation most football is actually televised at. Standing figures now have
   a lit side and a shaded side, and shadows have length and direction. */
var LIGHT = { x: 0, y: 0, z: 1, el: 40, az: 128 };

/* Point the key light. Mutating LIGHT in place rather than replacing it matters:
   both renderers, the canvas shadow projection and the GL uniform upload all
   hold a reference to this object and read it per frame, so a new object would
   leave stale copies behind in some of them and not others. */
function setSun(el, az) {
  var e = el * Math.PI / 180, a = az * Math.PI / 180, c = Math.cos(e);
  LIGHT.x = c * Math.cos(a);
  LIGHT.y = c * Math.sin(a);
  LIGHT.z = Math.sin(e);
  LIGHT.el = el; LIGHT.az = az;
}
setSun(40, 128);

function initRender() {
  cvs = document.getElementById("game");
  ctx = cvs.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () { setTimeout(resize, 250); });
}

/* RES owns the pixel ratio now, and it moves on its own — the adaptive pass
   can change it with the window size untouched — so the ratio is part of what
   counts as "the canvas is the wrong size". */
function pixelRatio() {
  return (typeof RES !== "undefined") ? RES.sync()
                                      : Math.min(window.devicePixelRatio || 1, 2.5);
}

function checkResize() {
  var w = window.innerWidth || document.documentElement.clientWidth;
  var h = window.innerHeight || document.documentElement.clientHeight;
  if (w !== Cam.lastW || h !== Cam.lastH || pixelRatio() !== DPR) resize();
}

function resize() {
  DPR = pixelRatio();
  var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
  var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
  Cam.lastW = window.innerWidth; Cam.lastH = window.innerHeight;
  cvs.width = Math.round(w * DPR);
  cvs.height = Math.round(h * DPR);
  cvs.style.width = w + "px";
  cvs.style.height = h + "px";

  /* keep a phone-shaped play area even on a wide desktop window */
  if (w / h > 0.62) { VP.w = h * 0.56; VP.h = h; VP.x = (w - VP.w) / 2; VP.y = 0; }
  else { VP.w = w; VP.h = h; VP.x = 0; VP.y = 0; }

  Cam.F = (VP.h / 2) / Math.tan(FOV_Y / 2);
  Cam.cx = VP.x + VP.w / 2;
  Cam.cy = VP.y + VP.h / 2;
}

/* ---------------------------------------------------------------- maths */
function sub3(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross3(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function unit3(a) {
  var m = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / m, y: a.y / m, z: a.z / m };
}

function buildBasis() {
  var pos = { x: Cam.px, y: Cam.py, z: Cam.pz };
  var tgt = { x: Cam.tx, y: Cam.ty, z: Cam.tz };
  Cam.f = unit3(sub3(tgt, pos));
  Cam.r = unit3(cross3(Cam.f, { x: 0, y: 0, z: 1 }));
  Cam.u = cross3(Cam.r, Cam.f);
}

/* world point -> camera space {x right, y up, z forward} */
function toCam(p) {
  var v = { x: p.x - Cam.px, y: p.y - Cam.py, z: (p.z || 0) - Cam.pz };
  return { x: dot3(v, Cam.r), y: dot3(v, Cam.u), z: dot3(v, Cam.f) };
}

/* camera space -> screen */
function toScreen(c) {
  var k = Cam.F / c.z;
  return { x: Cam.cx + c.x * k, y: Cam.cy - c.y * k, k: k };
}

function project(p) { return toScreen(toCam(p)); }

/* pixels-per-metre at a given world point */
function scaleAt(p) {
  var c = toCam(p);
  return c.z > NEAR ? Cam.F / c.z : 0;
}

/* Clip a polygon (camera space) against the near plane so nothing behind the
   camera wraps around and paints across the screen. */
function clipNear(poly) {
  var out = [], n = poly.length, i, a, b, t;
  for (i = 0; i < n; i++) {
    a = poly[i]; b = poly[(i + 1) % n];
    var ain = a.z >= NEAR, bin = b.z >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      t = (NEAR - a.z) / (b.z - a.z);
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: NEAR });
    }
  }
  return out;
}

/* Fill/stroke a world-space polygon. pts = [{x,y,z}, ...] */
function poly3(pts, fill, stroke, lw) {
  var cam = [], i;
  for (i = 0; i < pts.length; i++) cam.push(toCam(pts[i]));
  cam = clipNear(cam);
  if (cam.length < 3) return;
  ctx.beginPath();
  for (i = 0; i < cam.length; i++) {
    var s = toScreen(cam[i]);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
    if (!stroke && SEAL) { ctx.strokeStyle = fill; ctx.lineWidth = 1; ctx.stroke(); }
  }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
}

/* A line drawn ON the grass, with real width, so it thins with distance. */
function groundLine(x1, y1, x2, y2, w, col) {
  var d = norm(x2 - x1, y2 - y1), h = (w || 0.12) / 2;
  var nx = -d.y * h, ny = d.x * h;
  poly3([{ x: x1 + nx, y: y1 + ny, z: 0.01 }, { x: x2 + nx, y: y2 + ny, z: 0.01 },
         { x: x2 - nx, y: y2 - ny, z: 0.01 }, { x: x1 - nx, y: y1 - ny, z: 0.01 }],
        col || COL.line);
}

function groundArc(cxw, cyw, rad, a0, a1, w, col) {
  var steps = Math.max(6, Math.round(Math.abs(a1 - a0) / 0.18));
  for (var i = 0; i < steps; i++) {
    var s0 = a0 + (a1 - a0) * (i / steps), s1 = a0 + (a1 - a0) * ((i + 1) / steps);
    groundLine(cxw + Math.cos(s0) * rad, cyw + Math.sin(s0) * rad,
               cxw + Math.cos(s1) * rad, cyw + Math.sin(s1) * rad, w, col);
  }
}

function groundDot(cxw, cyw, rad) {
  var pts = [];
  for (var i = 0; i < 10; i++) {
    var a = i / 10 * 6.2832;
    pts.push({ x: cxw + Math.cos(a) * rad, y: cyw + Math.sin(a) * rad, z: 0.01 });
  }
  poly3(pts, COL.line);
}

function groundRect(x, y, w, h, lw) {
  groundLine(x, y, x + w, y, lw); groundLine(x + w, y, x + w, y + h, lw);
  groundLine(x + w, y + h, x, y + h, lw); groundLine(x, y + h, x, y, lw);
}

/* thin 3D line (net cords, goal frame edges) */
function line3(a, b, col, lw) {
  var ca = toCam(a), cb = toCam(b);
  if (ca.z < NEAR && cb.z < NEAR) return;
  if (ca.z < NEAR) { var t = (NEAR - ca.z) / (cb.z - ca.z); ca = { x: lerp(ca.x, cb.x, t), y: lerp(ca.y, cb.y, t), z: NEAR }; }
  if (cb.z < NEAR) { var u = (NEAR - cb.z) / (ca.z - cb.z); cb = { x: lerp(cb.x, ca.x, u), y: lerp(cb.y, ca.y, u), z: NEAR }; }
  var sa = toScreen(ca), sb = toScreen(cb);
  ctx.strokeStyle = col; ctx.lineWidth = lw || 1;
  ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
}

/* ------------------------------------------------------------- camera */
/* Broadcast camera state. A dead-still camera is the fastest way to look
   cheap, so there is always a slow handheld drift; strikes punch the lens in
   and settle; a goal hands over to an orbiting replay move. */
var CAM_T = 0;
var CAM_PUNCH = 0;
var CAM_GOAL_T = 0;
var CAM_BVX = 0, CAM_BVY = 0;   // smoothed ball velocity, used for camera lead
var CAM_LBX = 0, CAM_LBY = 0;   // last ball position, to spot teleports
var CAM_OFFX = 0, CAM_OFFY = 0; // shock absorber for those teleports

var CAM_PUNCH_T = 0;
function cameraPunch(amount) {
  CAM_PUNCH_T = Math.min(1.0, CAM_PUNCH_T + amount);
}

function cameraFollow(world, dt, instant) {
  CAM_T += dt || 0;
  CAM_PUNCH_T = Math.max(0, CAM_PUNCH_T - (dt || 0) * 2.4);
  CAM_PUNCH += (CAM_PUNCH_T - CAM_PUNCH) * (1 - Math.pow(0.02, (dt || 0)));
  /* counts up through any completed attempt — the goal camera and the miss
     camera both key off it */
  if (world.phase === "over") CAM_GOAL_T += dt || 0;
  else CAM_GOAL_T = 0;

  var b = world.ball;

  /* Lead the ball by a SMOOTHED velocity. Easing the lead coefficient is not
     enough: it multiplies a velocity that jumps 0 -> 30 m/s at the instant of
     contact, so the aim point still steps. Smoothing the velocity itself makes
     the lead grow from zero continuously. */
  var vk = instant ? 1 : 1 - Math.pow(0.006, (dt || 0));
  var live = world.phase === "live";
  CAM_BVX += ((live ? b.vx : 0) - CAM_BVX) * vk;
  CAM_BVY += ((live ? b.vy : 0) - CAM_BVY) * vk;
  /* Shock absorber. A first touch repositions the ball at the receiver's feet
     — an instantaneous jump of a metre or two that the camera would otherwise
     follow exactly, reading as a snap. Detect any move far larger than the
     ball's velocity allows, hold the old framing, and glide across. */
  if (instant) { CAM_LBX = b.x; CAM_LBY = b.y; CAM_OFFX = CAM_OFFY = 0; }
  var moved = Math.hypot(b.x - CAM_LBX, b.y - CAM_LBY);
  var allowed = Math.hypot(b.vx, b.vy) * (dt || 0) + 0.06;
  if (moved > allowed * 3 + 0.35) {
    CAM_OFFX += b.x - CAM_LBX;
    CAM_OFFY += b.y - CAM_LBY;
  }
  CAM_LBX = b.x; CAM_LBY = b.y;
  var decay = Math.pow(0.05, (dt || 0));
  CAM_OFFX *= decay; CAM_OFFY *= decay;

  var bx = b.x - CAM_OFFX + CAM_BVX * 0.20;
  var by = b.y - CAM_OFFY + CAM_BVY * 0.20;

  /* The camera sits behind the ball ALONG THE BALL-TO-GOAL AXIS, not simply
     up-pitch. That puts the ball and the goal on the same centre line, so a
     ball out by the corner flag still frames both — which a straight
     up-the-pitch camera cannot do on a narrow portrait screen. */
  var dGoal = Math.max(4, dist(bx, by, 0, GOAL_Y));
  /* Recompute the axis only while aiming. If it were recomputed in flight it
     would swing through 180 degrees as the ball reached the goal, throwing the
     camera around the pitch. */
  /* Only recompute while aiming. During flight it would swing through 180
     degrees as the ball arrives; once the ball is IN the goal the ball-to-goal
     vector is degenerate and rotates toward the touchline, which drags the
     replay camera round the pitch. */
  if (!Cam.axis) {
    Cam.axis = dGoal > 3 ? norm(0 - bx, GOAL_Y - by) : { x: 0, y: -1 };
  } else if (world.phase === "aim") {
    /* Ease rather than snap: a teammate receiving the ball moves the axis to a
       new carrier, and cutting straight to it lurches the frame. */
    var want = dGoal > 3 ? norm(0 - bx, GOAL_Y - by) : { x: 0, y: -1 };
    var ak = instant ? 1 : 1 - Math.pow(0.04, (dt || 0));
    Cam.axis = norm(Cam.axis.x + (want.x - Cam.axis.x) * ak,
                    Cam.axis.y + (want.y - Cam.axis.y) * ak);
  }
  var aim = Cam.axis;

  var back = clamp(9.2 + dGoal * 0.085, 9.2, 18);
  var height = clamp(5.2 + dGoal * 0.125, 5.2, 16);
  var ahead = clamp(dGoal * 0.42, 7, 23);

  /* lens punch on a strike, then settle */
  back -= CAM_PUNCH * 2.6;
  height -= CAM_PUNCH * 0.7;

  var wantPx = bx - aim.x * back, wantPy = by - aim.y * back, wantPz = height;
  var wantTx = bx + aim.x * ahead, wantTy = by + aim.y * ahead, wantTz = 0.9;

  /* slow handheld drift, sideways to the shooting axis */
  var side = { x: -aim.y, y: aim.x };
  var dA = Math.sin(CAM_T * 0.29) * 0.62;
  /* plus any cinematic drift a pass has asked for */
  if (typeof FEEL !== "undefined" && FEEL.cineDrift) dA += FEEL.cineDrift();
  var dB = Math.sin(CAM_T * 0.17 + 1.3) * 0.34;
  wantPx += side.x * dA; wantPy += side.y * dA;
  wantPz += dB * 0.5;
  wantTx += side.x * dA * 0.25; wantTy += side.y * dA * 0.25;

  /* The goal hands over to a replay orbit. Snapping the target there lurches,
     because the orbit start is metres from wherever play left the camera — so
     blend the two wants over ~0.9s instead of cutting. */
  if (world.phase === "over" && world.event === "goal") {
    /* THE GOAL CAMERA.

       The instinct is to swing round in front of the goal and look at it. In
       portrait that composition cannot work: to fit a 7.3 m goal across a
       390 px-wide frame you have to stand ~16 m back, and at 16 m a 15 m stand
       directly behind the goal fills two thirds of the screen. The result is a
       shot that is mostly crowd with the net squashed along the bottom.

       Broadcast solves it the other way round — go TIGHT and OFF-AXIS on the
       ball in the net, so the netting fills the frame diagonally and the crowd
       is only a band at the top, then pull out to the celebration. Two beats:

         A  0.00 - 0.70s   close, low, angled: the ball and the bulging net
         B  0.70 - 1.30s   pull back and up, drift onto the scorer

       The subject of beat A is the BALL, not the goal — that is the whole
       difference between a replay and a wide shot of some scenery. */
    var gt = CAM_GOAL_T;

    /* which side of the goal the ball went in — stay on that side, so the
       camera never has to cross the net and the bulge stays in view */
    var sideSign = (world.goalX || b.x) >= 0 ? 1 : -1;

    /* beat A: tight on the ball, but framed so the near post and the bulge are
       both in shot. Aiming dead at the ball pinned it to the frame edge, so the
       look-at is pulled a third of the way back toward the goal centre. */
    var gX = world.goalX || b.x;
    var aRad = 10.4, aAng = sideSign * 0.86;         // ~49 deg off the goal axis
    var aPx = gX * 0.6 + Math.sin(aAng) * aRad;
    var aPy = GOAL_Y + Math.cos(aAng) * aRad;
    var aPz = 2.85;
    var aTx = gX * 0.66, aTy = GOAL_Y - 1.35, aTz = (world.goalZ || 0.7) + 0.55;

    /* Beat B: the celebration. The subject here is the SCORER, and the camera
       has to be placed relative to THEM, not to the goal.

       The first version anchored beat B to the goal — position measured out
       from the goal line, look-at lerped most of the way back toward it. The
       scorer then sprinted 16 m up the pitch and straight out of frame, so the
       celebration shot was three seconds of the goalkeeper lying on the floor.

       So: stand off the scorer at a fixed distance on the side they ran to,
       drop low enough that the crowd fills the background rather than the
       turf, and aim at their chest. Then ease back and up as the team arrives,
       which opens the frame out to take in the group. */
    var sc = world.carrier || b;
    var cel = clamp(((world.celebT || 0) - 1.1) / 2.2, 0, 1);

    /* Stand off further while they are sprinting, and LEAD them.

       Sitting 9 m from a scorer running at 7 m/s put them off the side of the
       frame entirely: the camera eases toward its look-at, so a fast subject
       leaves a trailing aim point, and on a 390 px-wide portrait frame a few
       degrees of lag is the whole picture. Distance scales with their pace, and
       the aim point is pushed ahead along their velocity — which is what a real
       operator does, and is the "anticipation" this camera never had. */
    var scSpd = sc.speed ? sc.speed() : 0;
    var lead = Math.min(1, scSpd / 7.5);
    var bRad = 9.0 + cel * 5.0 + lead * 7.5;
    var bAng = sideSign * 1.10;
    var bPx = sc.x + Math.sin(bAng) * bRad;
    var bPy = sc.y + Math.cos(bAng) * bRad * 0.55;
    var bPz = 2.6 + cel * 2.2 + lead * 1.6;
    /* aim ahead of the runner by roughly a third of a second of travel */
    var bTx = sc.x + (sc.vx || 0) * 0.34;
    var bTy = sc.y + (sc.vy || 0) * 0.34;
    var bTz = 1.35;

    /* A -> B, and the play camera -> A. Both eased with zero slope at the join
       so neither handover reads as a cut. */
    /* Beat A holds the net for 0.7 s — long enough to read the bulge — then
       hands over across 0.6 s, complete at 1.3 s. The old 1.10 -> 2.25 s meant
       the composed celebration shot only arrived as the result card appeared,
       so most of the celebration played from a camera still in transit. */
    var w = clamp((gt - 0.70) / 0.60, 0, 1);
    w = w * w * (3 - 2 * w);
    var oPx = lerp(aPx, bPx, w), oPy = lerp(aPy, bPy, w), oPz = lerp(aPz, bPz, w);
    var oTx = lerp(aTx, bTx, w), oTy = lerp(aTy, bTy, w), oTz = lerp(aTz, bTz, w);

    /* the cut into beat A is fast — a goal should feel like the vision mixer
       punched a button, not like a slow drift */
    var u = clamp(gt / 0.34, 0, 1);
    u = u * u * (3 - 2 * u);
    wantPx = lerp(wantPx, oPx, u); wantPy = lerp(wantPy, oPy, u);
    wantPz = lerp(wantPz, oPz, u);
    wantTx = lerp(wantTx, oTx, u); wantTy = lerp(wantTy, oTy, u);
    wantTz = lerp(wantTz, oTz, u);
  }

  /* THE MISS CAMERA.

     A failed attempt used to leave the camera wherever it had chased the ball
     to, which on a wide shot meant the goal was off-screen entirely — the one
     thing the player needs to see in order to judge how close they were. The
     post-mortem overlay was drawing a caption above a goal nobody could see.

     So a miss gets its own composed frame: stand back along the goal axis far
     enough that BOTH the goal mouth and wherever the ball finished are inside
     the frame, and look at the midpoint between them. The framing distance is
     solved from the actual spread rather than fixed, so a shot 30 cm wide gets
     a tight frame and one 6 m wide gets a loose one. */
  if (world.phase === "over" && world.event !== "goal" && world.post) {
    var mt = CAM_GOAL_T;                       /* reused: counts up while over */
    var bp = world.post.ball;
    /* the two things that must be in frame */
    var midX = (bp.x + 0) * 0.5;
    var midY = (bp.y + GOAL_Y) * 0.5;
    var spread = Math.max(PITCH.goalHalf * 2.2,
                          Math.abs(bp.x) * 2.0 + 4, Math.abs(bp.y - GOAL_Y) + 8);
    /* portrait frame: horizontal extent is the binding constraint, so solve
       the distance from the viewport's own aspect */
    var hFov = 2 * Math.atan(Math.tan(FOV_Y / 2) * (VP.w / VP.h));
    var need = (spread * 0.5) / Math.tan(hFov / 2) + 6;
    need = clamp(need, 14, 46);

    var mPx = midX * 0.35;
    var mPy = GOAL_Y + need;
    var mPz = 5.0 + need * 0.16;
    var mTx = midX * 0.7, mTy = midY, mTz = 1.5;

    var mu = clamp(mt / 0.55, 0, 1);
    mu = mu * mu * (3 - 2 * mu);
    wantPx = lerp(wantPx, mPx, mu); wantPy = lerp(wantPy, mPy, mu);
    wantPz = lerp(wantPz, mPz, mu);
    wantTx = lerp(wantTx, mTx, mu); wantTy = lerp(wantTy, mTy, mu);
    wantTz = lerp(wantTz, mTz, mu);
  }

  /* the replay owns the camera outright — it is a different shot, not a nudge */
  var rc = replayCamera(world);
  if (rc) {
    wantPx = rc.px; wantPy = rc.py; wantPz = rc.pz;
    wantTx = rc.tx; wantTy = rc.ty; wantTz = rc.tz;
  }

  /* keep the camera inside the ground */
  wantPx = clamp(wantPx, -42, 42);
  wantPy = clamp(wantPy, GOAL_Y - 6, PITCH.halfL + 26);
  wantPz = Math.max(0.9, wantPz);

  /* the goal shot is a composed frame, not a follow — get onto it quickly or
     the eased handover above never actually arrives before the card shows */
  /* The goal and miss cameras are composed frames that have to ARRIVE, not
     drift. The two beats already blend smoothly into each other, so a slow
     follow on top of that just means the subject is off the side of the frame
     for the first second of the celebration — which is exactly what happened.
     1e-9 puts the convergence at ~29% per frame at 60fps. */
  var lag = world.phase === "over" ? 1e-9 : 0.02;
  var k = instant ? 1 : 1 - Math.pow(lag, dt);
  Cam.px += (wantPx - Cam.px) * k;
  Cam.py += (wantPy - Cam.py) * k;
  Cam.pz += (wantPz - Cam.pz) * k;
  Cam.tx += (wantTx - Cam.tx) * k;
  Cam.ty += (wantTy - Cam.ty) * k;
  Cam.tz += (wantTz - Cam.tz) * k;
  buildBasis();
}

/* Screen pixel -> point on the grass (z=0). Returns null if the ray points
   at or above the horizon. */
function screenToGround(sx, sy) {
  var dx = (sx - Cam.cx) / Cam.F, dy = -(sy - Cam.cy) / Cam.F;
  var d = {
    x: Cam.f.x + Cam.r.x * dx + Cam.u.x * dy,
    y: Cam.f.y + Cam.r.y * dx + Cam.u.y * dy,
    z: Cam.f.z + Cam.r.z * dx + Cam.u.z * dy
  };
  if (d.z > -0.02) return null;
  var t = -Cam.pz / d.z;
  return { x: Cam.px + d.x * t, y: Cam.py + d.y * t };
}

/* ---------------------------------------------------------------- world */
/* OVERSCAN: how far past the play area the backdrop is painted, so a shaken
   frame never reveals an unpainted edge. Must exceed the largest shake offset. */
var OVER = 46;

/* A real evening sky, not a two-stop ramp.

   Three things make the difference and all three were missing: a deep zenith
   that actually darkens upward, a warm haze band sitting on the horizon where
   the atmosphere is thickest, and a broad glow where the floodlights wash the
   air above the stand. The old gradient went light-blue to near-white over the
   top 60% of the frame and stopped, which is why the sky read as paper. */
function drawSky() {
  var x0 = VP.x - OVER, y0 = VP.y - OVER;
  var w = VP.w + OVER * 2, h = VP.h + OVER * 2;

  var C = cond(), SK = C.sky;
  var g = ctx.createLinearGradient(0, y0, 0, VP.y + VP.h * 0.72);
  g.addColorStop(0.00, SK[0]);                        // zenith
  g.addColorStop(0.26, mixHex(SK[0], SK[1], 0.55));
  g.addColorStop(0.56, SK[1]);
  g.addColorStop(0.80, mixHex(SK[1], SK[2], 0.62));
  g.addColorStop(1.00, SK[2]);                        // haze at the horizon
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);

  /* Warm sodium bounce above the far stand. Additive so it lifts the blue
     rather than washing it out — this is what ties the sky to the lighting. */
  var hz = VP.y + VP.h * 0.30;
  /* the glow above the far stand is sunlight in the day and sodium at night,
     so it follows both the warmth and the floodlight contribution */
  var glowA = 0.10 + C.warm * 0.24 + C.flood * 0.22;
  var wg = ctx.createRadialGradient(VP.x + VP.w * 0.5, hz, 0,
                                    VP.x + VP.w * 0.5, hz, VP.w * 1.15);
  wg.addColorStop(0.00, "rgba(255,214,150," + (glowA).toFixed(3) + ")");
  wg.addColorStop(0.35, "rgba(255,198,132," + (glowA * 0.4).toFixed(3) + ")");
  wg.addColorStop(1.00, "rgba(255,190,120,0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = wg;
  ctx.fillRect(x0, y0, w, h);

  /* A couple of soft cloud banks. Kept very low contrast on purpose: crisp
     clouds pull the eye off the pitch and date the look instantly. */
  var cloudA = 0.10 + (C.haze - 1) * 0.13;
  for (var i = 0; i < 3; i++) {
    var cy = VP.y + VP.h * (0.06 + i * 0.055);
    var cx = VP.x + VP.w * (0.22 + i * 0.31);
    var cr = VP.w * (0.42 + i * 0.14);
    var cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    cg.addColorStop(0, "rgba(255,246,232," + Math.max(0, cloudA - i * 0.022).toFixed(3) + ")");
    cg.addColorStop(1, "rgba(255,246,232,0)");
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cr, cr * 0.26, 0, 0, 6.2832);
    ctx.fill();
  }
  ctx.restore();
}

/* ---- turf ------------------------------------------------------------
   No texture sampling in a 2D-canvas renderer, so grass detail is built from
   three cheap layers: a directional sheen per mown band, irregular wear
   patches as ground polygons, and a screen-space grain overlay whose density
   falls off with distance. Together they stop the pitch reading as flat fill. */
var GRAIN = null;
function grainTile() {
  if (GRAIN) return GRAIN;
  var n = 128;
  var c = document.createElement("canvas");
  c.width = c.height = n;
  var g = c.getContext("2d");
  var img = g.createImageData(n, n);
  var seed = 12345;
  for (var i = 0; i < n * n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    var v = (seed >> 16) & 255;
    // bias toward blade-like vertical streaks
    var streak = ((i % n) * 7 + ((i / n) | 0) * 3) % 11 < 4 ? 26 : 0;
    var a = v > 205 ? 26 + streak : (v < 46 ? 22 : 0);
    img.data[i * 4] = v > 205 ? 255 : 0;
    img.data[i * 4 + 1] = v > 205 ? 255 : 0;
    img.data[i * 4 + 2] = v > 205 ? 235 : 0;
    img.data[i * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
  GRAIN = c;
  return c;
}

/* worn areas: goalmouths, penalty spots, centre circle */
var WEAR = [
  [0, -48.2, 9.5, 3.2, 0.075], [0, -41.5, 2.4, 1.5, 0.085],
  [0, 48.2, 9.5, 3.2, 0.075], [0, 41.5, 2.4, 1.5, 0.085],
  [0, 0, 9.0, 5.0, 0.045], [0, -36.0, 12.0, 2.2, 0.040],
  [-19, -30, 5.0, 7.0, 0.030], [19, -30, 5.0, 7.0, 0.030]
];

/* Four floodlight pools, one per corner rig, laid on the turf. Cheap, but it
   is what stops the pitch reading as evenly lit poster paint. */
function drawFloodPools() {
  var C = cond();
  var pool = 0.10 + C.flood * 0.90;      // barely there by day, doing the work at night
  var rigs = [[-30, -34], [30, -34], [-30, 34], [30, 34]];
  for (var i = 0; i < rigs.length; i++) {
    var c = toCam({ x: rigs[i][0] * 0.55, y: rigs[i][1] * 0.62, z: 0 });
    if (c.z < NEAR) continue;
    var sp = toScreen(c);
    var rad = 26 * sp.k;
    if (rad < 12) continue;
    var g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rad);
    g.addColorStop(0, "rgba(255,252,226,.075)");
    g.addColorStop(0.5, "rgba(255,250,220,.028)");
    g.addColorStop(1, "rgba(255,250,220,0)");
    ctx.save();
    ctx.beginPath();
    ctx.rect(VP.x, VP.y, VP.w, VP.h);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(sp.x - rad, sp.y - rad * 0.55, rad * 2, rad * 1.1);
    ctx.restore();
  }
}

function drawWear() {
  for (var i = 0; i < WEAR.length; i++) {
    var w = WEAR[i];
    var pts = [];
    for (var k = 0; k < 14; k++) {
      var a = k / 14 * 6.2832;
      // ragged edge, deterministic
      var wob = 0.86 + 0.28 * Math.abs(Math.sin(k * 2.4 + i));
      pts.push({ x: w[0] + Math.cos(a) * w[2] * wob,
                 y: w[1] + Math.sin(a) * w[3] * wob, z: 0.004 });
    }
    poly3(pts, "rgba(196,204,126," + w[4].toFixed(3) + ")");
  }
}

/* screen-space grain, clipped to the pitch and faded with depth */
function drawGrain() {
  var tile = grainTile();
  var horizon = w2sy_horizon();
  ctx.save();
  ctx.beginPath();
  ctx.rect(VP.x, Math.max(VP.y, horizon), VP.w, VP.y + VP.h - Math.max(VP.y, horizon));
  ctx.clip();
  var pat = ctx.createPattern(tile, "repeat");
  ctx.fillStyle = pat;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(VP.x, VP.y, VP.w, VP.h);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* approximate screen y of the pitch horizon, so grain never lands on the crowd */
function w2sy_horizon() {
  var c = toCam({ x: 0, y: GOAL_Y - SURROUND, z: 0 });
  return c.z > NEAR ? toScreen(c).y : VP.y;
}

/* A stand: a raked bank of crowd rising behind the goal or along a touchline.
   Built from a near edge and a far/high edge so one function does both ends
   and both sides. */
var CROWD = null;
var CROWD_T = 0;      // crowd animation clock
var CROWD_SURGE = 0;  // 0..1, spikes when something happens
/* A real stand is made of BLOCKS, not of evenly mixed noise. Home colours in
   most of it, a wedge of away support, a few neutral sections, and the odd
   pocket of replica shirts all together — that block structure is most of what
   makes a crowd look like a crowd rather than television static, and it costs
   one extra number per person.

   Entry: [u, v, phase, section]. Section is derived from u so that people
   standing next to each other are in the same section. */
function crowdData() {
  if (CROWD) return CROWD;

  /* Build the palette first: every colour any spectator can be, resolved once
     with the alpha already mixed into it. Each person then stores an INDEX into
     this array, which is what lets the draw loop be sorted by paint. */
  CROWD_PALETTE = [];
  for (var sec = 0; sec < CROWD_SECTION.length; sec++) {
    var pal = CROWD_SECTION[sec];
    for (var sl = 0; sl < pal.length; sl++) {
      for (var ab = 0; ab < 3; ab++) {
        CROWD_PALETTE.push(mixHex("#3c434d", pal[sl], 0.66 + ab * 0.17));
      }
    }
  }

  CROWD = [];
  for (var i = 0; i < 5200; i++) {
    var u = Math.random();
    var blk = (Math.floor(u * 8 + (Math.random() - 0.5) * 0.55) + 8) % 8;
    var slot = Math.floor(Math.random() * CROWD_SECTION[blk].length);
    var ab2 = Math.floor(Math.random() * 3);
    CROWD.push({
      u: u, v: Math.random(), ph: Math.random(),
      skin: Math.floor(Math.random() * CROWD_SKIN.length),
      col: (blk * CROWD_SECTION[blk].length + slot) * 3 + ab2
    });
  }

  /* Sorted by paint. The draw loop walks this in order and only touches
     fillStyle when the colour index changes — a couple of dozen state changes
     a frame instead of five thousand. Sorting once at startup is free. */
  CROWD.sort(function (a, b) { return a.col - b.col; });
  return CROWD;
}


/* Per-section palettes. Index 0-7 across the stand: mostly home, one away
   wedge, a couple of mixed blocks. */
var CROWD_PALETTE = null;

var CROWD_SECTION = [
  /* Block order across the stand matters as much as the colours. The away
     wedge was placed at indices 3-4 — the middle — and since the camera looks
     straight down the centre line, the most visible two thirds of the crowd
     came out blue and the ground looked like it belonged to the opposition.
     Away support now sits out at one end where a real segregated block goes,
     and the centre is home colours. */
  ["#2f3f7a", "#3d4f92", "#e8e2d6", "#2f3f7a", "#9aa6c4", "#28336b"],  // 0 away wedge
  ["#3d4f92", "#d9ab80", "#e8e2d6", "#2f3f7a", "#8d5b3b", "#c9c3b6"],  // 1 away edge, mixing
  ["#d9ab80", "#e8e2d6", "#c33b2e", "#8d5b3b", "#c33b2e", "#e2dccf"],  // 2 neutral
  ["#c33b2e", "#d9ab80", "#c33b2e", "#f3ece1", "#a82f26", "#8d5b3b"],  // 3 home
  ["#c33b2e", "#e8e2d6", "#a82f26", "#d9ab80", "#c33b2e", "#6d4831"],  // 4 home, dense
  ["#d9ab80", "#c33b2e", "#e8e2d6", "#c33b2e", "#a82f26", "#8d5b3b"],  // 5 home
  ["#d9ab80", "#e8e2d6", "#8d5b3b", "#c33b2e", "#e2dccf", "#6d4831"],  // 6 neutral
  ["#c33b2e", "#e8e2d6", "#d9ab80", "#c33b2e", "#8d5b3b", "#a82f26"]   // 7 home
];

/* Text painted onto a quad in the world, by building the affine transform that
   maps a flat rect onto the quad's projected corners. Used for hoardings. */
function quadText(bl, br, tl, txt, col, fill) {
  var cbl = toCam(bl), cbr = toCam(br), ctl = toCam(tl);
  if (cbl.z < NEAR || cbr.z < NEAR || ctl.z < NEAR) return;
  var pbl = toScreen(cbl), pbr = toScreen(cbr), ptl = toScreen(ctl);

  /* The camera basis is left-handed (facing the far goal, world +x is on the
     screen's left), so for some edges the "right" corner projects left and the
     text comes out mirrored. Re-origin on whichever end is actually leftmost. */
  if (pbr.x < pbl.x) {
    var tr = { x: tl.x + (br.x - bl.x), y: tl.y + (br.y - bl.y), z: tl.z + (br.z - bl.z) };
    var t2 = bl; bl = br; br = t2; tl = tr;
    cbl = toCam(bl); cbr = toCam(br); ctl = toCam(tl);
    if (cbl.z < NEAR || cbr.z < NEAR || ctl.z < NEAR) return;
    pbl = toScreen(cbl); pbr = toScreen(cbr); ptl = toScreen(ctl);
  }
  var W = 100, H = 34;
  var a11 = (pbr.x - pbl.x) / W, a12 = (pbr.y - pbl.y) / W;
  var a21 = (ptl.x - pbl.x) / H, a22 = (ptl.y - pbl.y) / H;
  if (!isFinite(a11) || !isFinite(a22)) return;
  /* too small on screen to bother */
  if (Math.hypot(pbr.x - pbl.x, pbr.y - pbl.y) < 26) return;
  ctx.save();
  ctx.transform(a11, a12, a21, a22, pbl.x, pbl.y);
  ctx.fillStyle = col;
  ctx.font = "900 " + (H * 0.62).toFixed(0) + "px system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.scale(1, -1);                       // the quad's "up" is screen-up
  ctx.fillText(txt, W / 2, -H * 0.52);
  ctx.restore();
}

var ADS = [
  { t: "goal.io", bg: "#f4f7fa", fg: "#12305a" },
  { t: "HERO", bg: "#e0344a", fg: "#ffffff" },
  { t: "SCORE", bg: "#12305a", fg: "#ffffff" },
  { t: "goal.io", bg: "#ffffff", fg: "#c33b2e" },
  { t: "PLAY", bg: "#2fa85f", fg: "#ffffff" }
];

/* A run of advertising boards along an edge — the thing that reads instantly
   as "football stadium". */
function hoardings(a, b, seed) {
  var len = dist(a.x, a.y, b.x, b.y);
  var n = Math.max(4, Math.round(len / 5.2));
  var H = 1.15;
  for (var i = 0; i < n; i++) {
    var t0 = i / n, t1 = (i + 1) / n;
    var p0 = { x: lerp(a.x, b.x, t0), y: lerp(a.y, b.y, t0) };
    var p1 = { x: lerp(a.x, b.x, t1), y: lerp(a.y, b.y, t1) };
    var ad = ADS[(i + seed) % ADS.length];
    poly3([{ x: p0.x, y: p0.y, z: 0 }, { x: p1.x, y: p1.y, z: 0 },
           { x: p1.x, y: p1.y, z: H }, { x: p0.x, y: p0.y, z: H }], ad.bg);
    quadText({ x: p0.x, y: p0.y, z: 0.06 }, { x: p1.x, y: p1.y, z: 0.06 },
             { x: p0.x, y: p0.y, z: H - 0.06 }, ad.t, ad.fg);
  }
  /* dark lip along the top so the boards read as solid objects */
  poly3([{ x: a.x, y: a.y, z: H }, { x: b.x, y: b.y, z: H },
         { x: b.x, y: b.y, z: H + 0.09 }, { x: a.x, y: a.y, z: H + 0.09 }], "#20262e");
}

/* ---- stadium ---------------------------------------------------------
   One grey ramp with speckles reads as a prototype. A real bowl has two tiers
   split by a facia, dark vomitory mouths punched through the lower deck, a
   cantilever roof with visible trusses, lamp banks and corner pylons. It is
   all cheap geometry; what it buys is depth and the feeling of being inside
   somewhere. */

function rakeQuad(a, b, c, d, z0, z1, col) {
  poly3([{ x: a.x, y: a.y, z: z0 }, { x: b.x, y: b.y, z: z0 },
         { x: d.x, y: d.y, z: z1 }, { x: c.x, y: c.y, z: z1 }], col);
}

function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

/* seat rows show through gaps in the crowd instead of flat concrete */
function seatGrid(a, b, c, d, z0, z1, rows, col) {
  for (var r = 0; r < rows; r++) {
    var t0 = r / rows, t1 = (r + 0.55) / rows;
    rakeQuad(lerpPt(a, c, t0), lerpPt(b, d, t0), lerpPt(a, c, t1), lerpPt(b, d, t1),
             lerp(z0, z1, t0), lerp(z0, z1, t1), col);
  }
}

function crowdOn(a, b, c, d, z0, z1, density, seed, bank) {
  /* Cost control: the crowd is by far the most expensive thing on screen, so
     skip a bank entirely when its midpoint is behind or far from the camera,
     and thin it with distance.

     History, because two attempts here were wrong. Setting fillStyle and
     globalAlpha per spectator cost 7.4 ms of a 13.9 ms frame. Batching the
     rectangles into one path per colour made it WORSE (9.7 ms): building a
     path of thousands of subpaths and filling it once is slower than thousands
     of fillRect calls, and keying the batches by string added five thousand
     string concatenations a frame on top.

     What actually works is removing the state changes without changing how the
     rectangles are drawn: the crowd list is pre-sorted by colour at startup, so
     walking it in order touches fillStyle only when the colour genuinely
     changes, and fillRect stays on its fast path. */
  var mid = toCam({ x: (a.x + b.x + c.x + d.x) / 4,
                    y: (a.y + b.y + c.y + d.y) / 4, z: (z0 + z1) / 2 });
  if (mid.z < NEAR) return;
  if (mid.z > 210) return;
  var lod = mid.z > 130 ? 0.30 : (mid.z > 85 ? 0.55 : (mid.z > 55 ? 0.78 : 1.0));
  lod *= density;

  var pts = crowdData(), len = pts.length;
  var T = CROWD_T, surge = CROWD_SURGE, detailed = 0;
  var start = (seed * 977) % len;
  var curCol = -1;
  var vx0 = VP.x - 6, vx1 = VP.x + VP.w + 6, vy0 = VP.y - 6, vy1 = VP.y + VP.h + 6;
  var flashPend = null;

  /* Thin by STRIDE rather than by rejecting people inside the loop. Rejection
     still paid the loop cost for all 5,200 entries on every bank — eight banks
     a frame — even when only 30% were wanted. Because the list is sorted by
     colour, stepping through it still visits colours in ascending order, so the
     fillStyle batching survives. */
  var stride = lod >= 0.999 ? 1 : Math.max(1, Math.round(1 / lod));
  for (var k = 0; k < len; k += stride) {
    var q = pts[(start + k) % len];

    var t = q.v;
    var wx = lerp(lerp(a.x, b.x, q.u), lerp(c.x, d.x, q.u), t);
    var wy = lerp(lerp(a.y, b.y, q.u), lerp(c.y, d.y, q.u), t);
    var ph = q.ph * 6.2832;
    var bob = Math.sin(T * 2.1 + ph) * 0.05 + surge * (0.30 + 0.26 * Math.sin(T * 9 + ph));
    var cam = toCam({ x: wx, y: wy, z: lerp(z0, z1, t) + 0.45 + bob });
    if (cam.z < NEAR) continue;
    var sp = toScreen(cam);
    if (sp.x < vx0 || sp.x > vx1 || sp.y < vy0 || sp.y > vy1) continue;
    var ww = Math.max(1, 0.26 * sp.k), hh = Math.max(1, 0.38 * sp.k);

    if ((((k * 2654435761) ^ ((T * 2.5) | 0)) >>> 0) % 1600 < 3) {
      if (!flashPend) flashPend = [];
      flashPend.push(sp.x - ww * 0.7, sp.y - hh * 1.3, ww * 1.4, hh * 1.3);
      continue;
    }

    if (hh > CROWD_DETAIL_PX && detailed++ < CROWD_DETAIL_MAX) {
      var headR = ww * 0.34;
      var torsoTop = sp.y - hh + headR * 1.7;
      ctx.fillStyle = CROWD_PALETTE[q.col];
      ctx.beginPath();
      ctx.moveTo(sp.x - ww * 0.50, sp.y);
      ctx.lineTo(sp.x - ww * 0.46, torsoTop + hh * 0.10);
      ctx.lineTo(sp.x - ww * 0.26, torsoTop);
      ctx.lineTo(sp.x + ww * 0.26, torsoTop);
      ctx.lineTo(sp.x + ww * 0.46, torsoTop + hh * 0.10);
      ctx.lineTo(sp.x + ww * 0.50, sp.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = CROWD_SKIN[q.skin];
      ctx.beginPath();
      ctx.arc(sp.x, torsoTop - headR * 0.85, headR, 0, 6.2832);
      ctx.fill();
      curCol = -1;                                 // the detail path dirtied it
      continue;
    }

    if (q.col !== curCol) { curCol = q.col; ctx.fillStyle = CROWD_PALETTE[curCol]; }
    ctx.fillRect(sp.x - ww * 0.5, sp.y - hh, ww, hh);
  }

  if (flashPend) {
    ctx.fillStyle = "#fffef0";
    for (var f = 0; f < flashPend.length; f += 4) {
      ctx.fillRect(flashPend[f], flashPend[f + 1], flashPend[f + 2], flashPend[f + 3]);
    }
  }

  drawBulbs(a, b, c, d, z0, z1, bank);
}

/* Photographers' flashes rippling across a stand. Costs a handful of additive
   blobs and does more for "there are thousands of people here reacting" than
   any amount of extra crowd geometry. */
function drawBulbs(a, b, c, d, z0, z1, bank) {
  if (typeof FEEL === "undefined" || bank == null) return;
  var list = FEEL.bulbs();
  if (!list.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (var i = 0; i < list.length; i++) {
    var B = list[i];
    if ((B.side % 4) !== (bank % 4)) continue;
    if (B.t > 0) continue;                       // not popped yet
    var age = -B.t;
    if (age > B.life) continue;
    var k = 1 - age / B.life;
    var u = B.u, t = B.v;
    var wx = lerp(lerp(a.x, b.x, u), lerp(c.x, d.x, u), t);
    var wy = lerp(lerp(a.y, b.y, u), lerp(c.y, d.y, u), t);
    var cam = toCam({ x: wx, y: wy, z: lerp(z0, z1, t) + 0.7 });
    if (cam.z < NEAR) continue;
    var sp = toScreen(cam);
    var rr = Math.max(2.2, 0.55 * sp.k) * (0.6 + k * 0.7);
    var g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rr);
    g.addColorStop(0, "rgba(255,255,252," + (0.95 * k).toFixed(3) + ")");
    g.addColorStop(0.22, "rgba(230,242,255," + (0.42 * k).toFixed(3) + ")");
    g.addColorStop(1, "rgba(210,232,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, rr, 0, 6.2832); ctx.fill();
  }
  ctx.restore();
}

/* card display held up by the home end */
function tifo(a, b, c, d, z0, z1) {
  /* Sat too high in the tier and the top rows fell outside the frame at the
     default camera pitch. Held lower and slightly shallower it reads whole. */
  for (var r = 0; r < 8; r++) {
    for (var k = 0; k < 18; k++) {
      var u0 = 0.26 + k * 0.026, u1 = u0 + 0.023;
      var t0 = 0.05 + r * 0.048, t1 = t0 + 0.042;
      var mid = (r > 2 && r < 6 && k > 4 && k < 13);
      var col = mid ? "#f4f4f0" : ((r + k) % 2 ? "#c8202a" : "#a3151d");
      var q = [];
      [[u0, t0], [u1, t0], [u1, t1], [u0, t1]].forEach(function (uv) {
        q.push({ x: lerp(lerp(a.x, b.x, uv[0]), lerp(c.x, d.x, uv[0]), uv[1]),
                 y: lerp(lerp(a.y, b.y, uv[0]), lerp(c.y, d.y, uv[0]), uv[1]),
                 z: lerp(z0, z1, uv[1]) + 0.5 });
      });
      poly3(q, col);
    }
  }
}

/* a,b = near edge on the ground; c,d = far edge */
function drawStand(a, b, c, d, height, density, seed, hA, hB, opts) {
  opts = opts || {};
  var nearMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
  if (toCam(nearMid).z < -25) return;

  var h1 = height * 0.46;
  var gap = height * 0.10;
  var h2 = height;
  var midA = lerpPt(a, c, 0.52), midB = lerpPt(b, d, 0.52);
  var upA = lerpPt(a, c, 0.60), upB = lerpPt(b, d, 0.60);

  rakeQuad(a, b, midA, midB, 0, h1, "#5b626c");
  seatGrid(a, b, midA, midB, 0, h1, 9, "#3f4650");
  crowdOn(a, b, midA, midB, 0, h1, density, 0, seed);

  if (opts.voms !== false) {
    /* AISLES, not tunnels.

       Two attempts at this were wrong. Painting a dark quad on the rake gave a
       black sticker. Building an actual recess — jambs, steps, a lit back wall
       — gave a grey chevron that read as a modelling error, because at this
       size and distance there are not enough pixels for the eye to resolve a
       hole; it just sees an odd bright shape interrupting the crowd.

       What stadium art at this scale actually does, and what reads instantly,
       is a gangway: a narrow strip of exposed steps running up the rake with
       no spectators on it. It is legible at ten pixels wide, it breaks the
       crowd into blocks the way a real stand is broken up, and it cannot be
       mistaken for a mistake. The mouth at the bottom is a single dark notch. */
    for (var v = 0; v < 6; v++) {
      var u0 = 0.10 + v * 0.161, u1 = u0 + 0.016;
      function vp(u, t, dz) {
        return { x: lerp(lerp(a.x, b.x, u), lerp(midA.x, midB.x, u), t),
                 y: lerp(lerp(a.y, b.y, u), lerp(midA.y, midB.y, u), t),
                 z: lerp(0, h1, t) + (dz || 0.05) };
      }
      /* the gangway surface: bare concrete, lighter than the seat blocks */
      poly3([vp(u0, 0.02), vp(u1, 0.02), vp(u1, 0.99), vp(u0, 0.99)], "#6e7681");

      /* step treads catching the floodlights, tighter toward the top as the
         rake steepens in projection */
      for (var st = 0; st < 12; st++) {
        var ts0 = 0.04 + st * 0.079, ts1 = ts0 + 0.034;
        if (ts1 > 0.99) break;
        poly3([vp(u0, ts0), vp(u1, ts0), vp(u1, ts1), vp(u0, ts1)], "#8d949e");
      }

      /* the vomitory mouth itself — one dark notch at the foot of the gangway,
         where it passes under the stand into the concourse */
      poly3([vp(u0 - 0.004, 0.02), vp(u1 + 0.004, 0.02),
             vp(u1 + 0.004, 0.16), vp(u0 - 0.004, 0.16)], "#181c22");
      /* a sliver of warm concourse light under the lintel */
      poly3([vp(u0 - 0.004, 0.13), vp(u1 + 0.004, 0.13),
             vp(u1 + 0.004, 0.16), vp(u0 - 0.004, 0.16)], "#5a4c39");

      /* handrails: two thin bright lines are what make it read as a stairway */
      line3(vp(u0, 0.05, 0.55), vp(u0, 0.97, 0.55), "rgba(196,208,220,.42)", 1);
      line3(vp(u1, 0.05, 0.55), vp(u1, 0.97, 0.55), "rgba(196,208,220,.30)", 1);
    }
  }

  rakeQuad(midA, midB, upA, upB, h1, h1 + gap, "#232932");
  rakeQuad(midA, midB, upA, upB, h1 + gap * 0.34, h1 + gap * 0.60, "rgba(120,200,255,.28)");

  /* Supporters' banners tied to the facia. Two or three flashes of flat colour
     with a stripe across them, at the height where a real ground puts them.
     Cheap, and they do more for "this is somebody's club" than another
     thousand spectators would. */
  var BANNERS = [
    [0.055, 0.175, "#c8202a", "#f1e6cf"],
    [0.400, 0.505, "#1d2a63", "#e8e2d6"],
    [0.760, 0.885, "#0f5c3a", "#f1e6cf"]
  ];
  for (var bi = 0; bi < BANNERS.length; bi++) {
    var B = BANNERS[bi];
    if ((seed + bi) % 3 === 2) continue;                 // not every stand, every time
    function bp(u, t) {
      return { x: lerp(lerp(midA.x, midB.x, u), lerp(upA.x, upB.x, u), t),
               y: lerp(lerp(midA.y, midB.y, u), lerp(upA.y, upB.y, u), t),
               z: lerp(h1, h1 + gap, t) + 0.03 };
    }
    poly3([bp(B[0], 0.08), bp(B[1], 0.08), bp(B[1], 0.94), bp(B[0], 0.94)], B[2]);
    poly3([bp(B[0], 0.40), bp(B[1], 0.40), bp(B[1], 0.62), bp(B[0], 0.62)], B[3]);
  }

  rakeQuad(upA, upB, c, d, h1 + gap, h2, "#525963");
  seatGrid(upA, upB, c, d, h1 + gap, h2, 7, "#393f49");
  crowdOn(upA, upB, c, d, h1 + gap, h2, density * 0.85, 977, seed);
  if (opts.tifo) tifo(upA, upB, c, d, h1 + gap, h2);

  var rz = h2 + 5.0;
  var fA = lerpPt(a, c, 0.30), fB = lerpPt(b, d, 0.30);
  /* The underside was one flat fill, which is why the roof read as a grey bar
     laid across the top of the frame. Banded from front to back so it falls
     away into shadow, which is what a cantilever actually looks like from the
     pitch and gives the stand a ceiling rather than a lid. */
  for (var rb = 0; rb < 5; rb++) {
    var q0 = rb / 5, q1 = (rb + 1) / 5;
    var s0 = lerpPt(fA, c, q0), s1 = lerpPt(fB, d, q0);
    var e0 = lerpPt(fA, c, q1), e1 = lerpPt(fB, d, q1);
    poly3([{ x: s0.x, y: s0.y, z: rz }, { x: s1.x, y: s1.y, z: rz },
           { x: e1.x, y: e1.y, z: rz }, { x: e0.x, y: e0.y, z: rz }],
          shade("#2a323c", 1 - q0 * 0.62));
  }
  poly3([{ x: fA.x, y: fA.y, z: rz }, { x: fB.x, y: fB.y, z: rz },
         { x: fB.x, y: fB.y, z: rz + 0.9 }, { x: fA.x, y: fA.y, z: rz + 0.9 }], "#2c333d");
  var t, f;
  for (t = 0; t <= 8; t++) {
    f = t / 8;
    line3({ x: lerp(fA.x, fB.x, f), y: lerp(fA.y, fB.y, f), z: rz },
          { x: lerp(c.x, d.x, f), y: lerp(c.y, d.y, f), z: rz }, "rgba(0,0,0,.45)", 2);
  }
  for (t = 1; t < 10; t++) {
    f = t / 10;
    var lp = toCam({ x: lerp(fA.x, fB.x, f), y: lerp(fA.y, fB.y, f), z: rz + 0.5 });
    if (lp.z < NEAR) continue;
    var sp = toScreen(lp);
    var lr = Math.max(1.2, 0.45 * sp.k);
    var gg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, lr * 5);
    gg.addColorStop(0, "rgba(255,250,225,.85)");
    gg.addColorStop(0.25, "rgba(255,248,215,.28)");
    gg.addColorStop(1, "rgba(255,248,215,0)");
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, lr * 5, 0, 6.2832); ctx.fill();
  }

  hoardings(hA || a, hB || b, seed || 0);
}

/* ATMOSPHERIC PERSPECTIVE.

   The single biggest reason the old frames read as flat: a stand 90 m away was
   drawn at exactly the same saturation and contrast as grass 6 m away. Real air
   washes distant things toward the horizon colour and eats their contrast, and
   the eye uses that as its primary depth cue — more than perspective.

   Doing it properly per-polygon would mean mixing a fog colour into every fill
   in the file. On this camera there is a much cheaper equivalent that is very
   nearly correct: from a pitch-level view, distance and screen height are
   almost the same thing, so one wash keyed to Y and anchored at the horizon
   gets the stands and leaves the pitch alone.

   Drawn after the stands and before the pitch, so nothing in the foreground is
   ever hazed. */
function drawDepthHaze() {
  /* where the horizon lands on screen for the current camera */
  var hy = horizonY();
  var top = VP.y - OVER;
  var span = Math.max(40, hy - top);

  var C = cond();
  /* Tinted with the sky's own horizon colour, so a floodlit night hazes toward
     dark blue instead of toward daylight grey — using a fixed pale grey here
     made night matches look foggy rather than dark. */
  var hc = parseCol(C.sky[2]);
  var rgb = hc[0] + "," + hc[1] + "," + hc[2];
  /* Stops AT the horizon. It used to run 30% of the span past it, which on the
     long-range levels laid a grey wash over most of the pitch and turned a
     night match into fog. Nothing in the foreground is behind atmosphere. */
  var a0 = clamp(0.46 * C.haze, 0, 0.52);
  var bottom = hy + span * 0.04;
  var g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0.00, "rgba(" + rgb + "," + a0.toFixed(3) + ")");
  g.addColorStop(0.62, "rgba(" + rgb + "," + (a0 * 0.55).toFixed(3) + ")");
  g.addColorStop(1.00, "rgba(" + rgb + ",0)");
  ctx.fillStyle = g;
  ctx.fillRect(VP.x - OVER, top, VP.w + OVER * 2, bottom - top);
}

/* Screen Y of the horizon: project a point far away along the view direction
   at eye height. Cheaper and more robust than solving the basis analytically. */
function horizonY() {
  var far = { x: Cam.px + Cam.f.x * 4000, y: Cam.py + Cam.f.y * 4000,
              z: Cam.pz + Cam.f.z * 4000 };
  var c = toCam(far);
  if (c.z < NEAR) return VP.y + VP.h * 0.35;
  return toScreen(c).y;
}

function drawStadium() {
  var XW = PITCH.halfW + SURROUND, YE = SURROUND, DEP = 30, H = 15;
  drawStand({ x: -XW, y: GOAL_Y - YE }, { x: XW, y: GOAL_Y - YE },
            { x: -XW, y: GOAL_Y - YE - DEP }, { x: XW, y: GOAL_Y - YE - DEP },
            H, 1, 0, null, null, { tifo: true });
  drawStand({ x: XW, y: OWN_GOAL_Y + YE }, { x: -XW, y: OWN_GOAL_Y + YE },
            { x: XW, y: OWN_GOAL_Y + YE + DEP }, { x: -XW, y: OWN_GOAL_Y + YE + DEP },
            H, 0.35, 2);
  var YS = OWN_GOAL_Y + YE + DEP, YN = GOAL_Y - YE - DEP;
  drawStand({ x: -XW, y: YS }, { x: -XW, y: YN },
            { x: -XW - DEP, y: YS }, { x: -XW - DEP, y: YN }, H, 0.6, 1,
            { x: -XW, y: OWN_GOAL_Y + YE }, { x: -XW, y: GOAL_Y - YE });
  drawStand({ x: XW, y: YN }, { x: XW, y: YS },
            { x: XW + DEP, y: YN }, { x: XW + DEP, y: YS }, H, 0.6, 3,
            { x: XW, y: GOAL_Y - YE }, { x: XW, y: OWN_GOAL_Y + YE });
  drawPylons(XW, YE, H);
}

function drawPylons(XW, YE, H) {
  var corners = [[-XW - 7, GOAL_Y - YE - 10], [XW + 7, GOAL_Y - YE - 10],
                 [-XW - 7, OWN_GOAL_Y + YE + 10], [XW + 7, OWN_GOAL_Y + YE + 10]];
  for (var i = 0; i < corners.length; i++) {
    var cx = corners[i][0], cy = corners[i][1];
    var top = H + 16;
    var base = toCam({ x: cx, y: cy, z: 0 });
    if (base.z < NEAR || base.z > 210) continue;
    poly3([{ x: cx - 0.55, y: cy, z: 0 }, { x: cx + 0.55, y: cy, z: 0 },
           { x: cx + 0.34, y: cy, z: top }, { x: cx - 0.34, y: cy, z: top }], "#232a33");
    poly3([{ x: cx - 3.6, y: cy, z: top }, { x: cx + 3.6, y: cy, z: top },
           { x: cx + 3.6, y: cy, z: top + 3.2 }, { x: cx - 3.6, y: cy, z: top + 3.2 }],
          "#2e3742");
    var lc = toCam({ x: cx, y: cy, z: top + 1.6 });
    if (lc.z < NEAR) continue;
    var sp = toScreen(lc);
    var rr = Math.max(7, 4.2 * sp.k);
    var g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rr);
    g.addColorStop(0, "rgba(255,253,235,.95)");
    g.addColorStop(0.15, "rgba(255,250,220,.40)");
    g.addColorStop(0.5, "rgba(238,245,255,.10)");
    g.addColorStop(1, "rgba(238,245,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, rr, 0, 6.2832); ctx.fill();
  }
}

/* Parse either "#rrggbb" or "rgb(r,g,b)" into a triple.

   This exists because every colour helper in this file used to assume hex, and
   they all return "rgb(...)". The moment one helper's output was fed to
   another — grading the turf and then hazing it by depth — parseInt saw
   "gb(50,189,87)", produced NaN, and canvas silently kept whatever fillStyle
   it last held. The symptom was a pitch that rendered pure black in the
   foreground and pure white in the middle distance, with no error anywhere.
   Anything that takes a colour goes through here now. */
function parseCol(c) {
  if (c.charAt(0) === "#") {
    var n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [255, 0, 255];   // magenta: visibly wrong
}

/* Mix two colours. Needed because the turf is graded by depth rather than
   being two flat fills, and canvas gradients cannot interpolate per-quad. */
var MIX_CACHE = {};
function mixHex(a, b, t) {
  var key = a + "|" + b + "|" + t.toFixed(3);
  if (MIX_CACHE[key]) return MIX_CACHE[key];
  var ca = parseCol(a), cb = parseCol(b);
  var out = "rgb(" + Math.round(lerp(ca[0], cb[0], t)) + "," +
                     Math.round(lerp(ca[1], cb[1], t)) + "," +
                     Math.round(lerp(ca[2], cb[2], t)) + ")";
  MIX_CACHE[key] = out;
  return out;
}

/* Grade a grass colour for the current condition: dim it by exposure, pull it
   toward warm or blue by colour temperature, and desaturate it when wet. */
var GRADE_CACHE = {};
function gradeGrass(hex, C) {
  var key = hex + "|" + C.light + "|" + C.warm + "|" + C.wet;
  if (GRADE_CACHE[key]) return GRADE_CACHE[key];
  var c0 = parseCol(hex);
  var r = c0[0], g = c0[1], b = c0[2];
  /* NO exposure here. Dimming only the grass gave a black pitch with brightly
     lit players standing on it — the players are drawn from fixed palette
     colours and knew nothing about the condition. Exposure is applied once to
     the whole frame in drawGrade() instead, so everything agrees. */
  /* Saturation rises as light falls. Multiplying a mid-tone green down to 76%
     and then desaturating it for wet gave grey tarmac; pushing saturation up
     first keeps a floodlit pitch unmistakably green, which is how it reads in
     life and on television. */
  var boost = 1 + (1 - C.light) * 0.85;
  var lum0 = r * 0.30 + g * 0.59 + b * 0.11;
  r = lum0 + (r - lum0) * boost;
  g = lum0 + (g - lum0) * boost;
  b = lum0 + (b - lum0) * boost;

  /* colour temperature: warm lifts red, cool lifts blue */
  var w = (C.warm - 0.5) * 0.22;
  r *= 1 + w; b *= 1 - w;
  /* wet grass is darker and less saturated */
  if (C.wet > 0) {
    var lum = (r * 0.30 + g * 0.59 + b * 0.11);
    var k = C.wet * 0.15;
    r = r + (lum - r) * k; g = g + (lum - g) * k; b = b + (lum - b) * k;
    r *= 1 - C.wet * 0.10; g *= 1 - C.wet * 0.10; b *= 1 - C.wet * 0.10;
  }
  var out = "rgb(" + clamp(Math.round(r), 0, 255) + "," +
                     clamp(Math.round(g), 0, 255) + "," +
                     clamp(Math.round(b), 0, 255) + ")";
  GRADE_CACHE[key] = out;
  return out;
}

/* THE TURF.

   Sixty per cent of every frame is grass, so this is where the whole thing is
   won or lost. The previous version was two flat greens in 7 m bands with the
   same sheen ramp on both, which produced the single most amateur thing in the
   build: even mint-coloured stripes with hard edges, identical from the six
   metre line to the far corner flag.

   Four changes, in order of how much each one buys:

   1. ALTERNATING SHEEN. Real mow stripes alternate cutting direction, so
      neighbouring bands catch and lose the light in opposite directions. Both
      bands used to ramp the same way, which is why the pattern read as painted
      on rather than mown in. Flipping every other gradient is most of the
      effect on its own.

   2. DEPTH GRADING. Every band is tinted toward the horizon haze by its own
      distance from the camera. This is the atmospheric cue the pitch was
      missing entirely — without it near grass and far grass are the same
      colour and the surface reads as a flat card.

   3. A KEY LIGHT. There is a light vector in this file that nothing used.
      Grass now takes a lambert term across the pitch's width, so one side of
      the ground is warmer than the other and the surface has a direction.

   4. FINER BANDS. 5.25 m instead of 7 m — twenty stripes across the length,
      which is what a real ground looks like from the halfway line.
*/
function drawPitch(world) {
  /* surround first: darker, cooler, and it never carries stripes */
  var gx = PITCH.halfW + SURROUND, gy = PITCH.halfL + SURROUND;
  poly3([{ x: -gx, y: gy, z: 0 }, { x: gx, y: gy, z: 0 },
         { x: gx, y: -gy, z: 0 }, { x: -gx, y: -gy, z: 0 }],
        "#24663a");

  var C = cond();
  /* Grass under floodlights is darker, cooler and glossier than grass at three
     in the afternoon. Exposure and warmth come straight off the condition, and
     the haze colour is taken from the sky so the pitch fades into the same air
     as everything else. */
  var HAZE = mixHex(C.sky[2], "#b9d6cf", 0.35);
  var band = 5.25;
  var n = Math.ceil((PITCH.halfL * 2) / band);

  for (var i = 0; i < n; i++) {
    var y0 = -PITCH.halfL + i * band;
    var y1 = Math.min(y0 + band, PITCH.halfL);
    if (y1 <= y0) continue;

    var odd = i & 1;
    var col = gradeGrass(odd ? COL.grass2 : COL.grass1, C);
    var lit = gradeGrass(odd ? COL.grass2Lit : COL.grass1Lit, C);

    /* depth of this band, used for both haze and contrast falloff */
    var mid = toCam({ x: 0, y: (y0 + y1) / 2, z: 0 });
    if (mid.z < NEAR) {
      poly3([{ x: -PITCH.halfW, y: y0, z: 0 }, { x: PITCH.halfW, y: y0, z: 0 },
             { x: PITCH.halfW, y: y1, z: 0 }, { x: -PITCH.halfW, y: y1, z: 0 }], col);
      continue;
    }
    var fog = clamp((mid.z - 18) / 95, 0, 0.46) * C.haze;
    var cNear = mixHex(col, HAZE, fog);
    var cLit  = mixHex(lit, HAZE, fog * 0.9);

    var a = toCam({ x: 0, y: y0, z: 0 }), b2 = toCam({ x: 0, y: y1, z: 0 });
    var quad = [{ x: -PITCH.halfW, y: y0, z: 0 }, { x: PITCH.halfW, y: y0, z: 0 },
                { x: PITCH.halfW, y: y1, z: 0 }, { x: -PITCH.halfW, y: y1, z: 0 }];

    if (a.z > NEAR && b2.z > NEAR) {
      var sa = toScreen(a), sb = toScreen(b2);
      var g = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
      /* The flip: adjacent bands catch the light from opposite ends. Keep most
         of the band FLAT and put the sheen in a narrow strip at one edge — a
         gradient spanning the whole band blurs into its neighbour and the
         pattern stops reading as stripes at all, which is what happened when
         both bands ramped across their full width. */
      /* The sheen sat in the last quarter of the band, which put a bright line
         hard against the next band's dark edge and read as a seam in a carpet.
         Widened and softened: still directional, no longer a stripe of its own. */
      if (odd) {
        g.addColorStop(0.00, cNear);
        g.addColorStop(0.42, cNear);
        g.addColorStop(1.00, cLit);
      } else {
        g.addColorStop(0.00, cLit);
        g.addColorStop(0.58, cNear);
        g.addColorStop(1.00, cNear);
      }
      poly3(quad, g);
    } else {
      poly3(quad, cNear);
    }
  }

  /* THE KEY LIGHT. A lateral lambert wash across the pitch, warm on the lit
     side and cool in shadow, following the light vector the rest of the file
     already shades players with. Screen-space because the surface is planar,
     so one gradient is exact rather than an approximation. */
  var lA = toCam({ x: -PITCH.halfW - SURROUND, y: 0, z: 0 });
  var lB = toCam({ x: PITCH.halfW + SURROUND, y: 0, z: 0 });
  if (lA.z > NEAR && lB.z > NEAR) {
    var pa = toScreen(lA), pb = toScreen(lB);
    var lg = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    /* LIGHT.x is negative, so the -X touchline is the lit side */
    var keyA = (0.05 + C.warm * 0.12) * C.light;
    var shadA = 0.08 + (1 - C.light) * 0.16;
    lg.addColorStop(0.00, "rgba(255,246,214," + keyA.toFixed(3) + ")");
    lg.addColorStop(0.42, "rgba(255,250,230,.03)");
    lg.addColorStop(1.00, "rgba(16,40,58," + shadA.toFixed(3) + ")");
    ctx.save();
    ctx.fillStyle = lg;
    ctx.fillRect(VP.x - OVER, VP.y - OVER, VP.w + OVER * 2, VP.h + OVER * 2);
    ctx.restore();
  }

  /* WET SHEEN. A wet pitch is defined by the long soft reflection of the
     lights running away from the camera — without it "rain" is just a darker
     green. Additive, and only when the surface is actually wet. */
  if (C.wet > 0.05) {
    var wa = toCam({ x: 0, y: GOAL_Y + 6, z: 0 });
    var wb = toCam({ x: 0, y: PITCH.halfL * 0.4, z: 0 });
    if (wa.z > NEAR && wb.z > NEAR) {
      var wsa = toScreen(wa), wsb = toScreen(wb);
      var wg2 = ctx.createLinearGradient(wsa.x, wsa.y, wsb.x, wsb.y);
      var wAmt = C.wet * (0.10 + C.flood * 0.16);
      wg2.addColorStop(0.00, "rgba(214,236,255," + (wAmt * 1.1).toFixed(3) + ")");
      wg2.addColorStop(0.45, "rgba(206,230,252," + (wAmt * 0.45).toFixed(3) + ")");
      wg2.addColorStop(1.00, "rgba(200,226,250,0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = wg2;
      ctx.fillRect(VP.x - OVER, VP.y - OVER, VP.w + OVER * 2, VP.h + OVER * 2);
      ctx.restore();
    }
  }

  drawWear();

  /* markings */
  groundRect(-PITCH.halfW, -PITCH.halfL, PITCH.halfW * 2, PITCH.halfL * 2, 0.12);
  groundLine(-PITCH.halfW, 0, PITCH.halfW, 0, 0.12);
  groundArc(0, 0, PITCH.centreR, 0, 6.2832, 0.12);

  markBoxes(GOAL_Y, 1);
  markBoxes(OWN_GOAL_Y, -1);
}

function markBoxes(baseY, dir) {
  var d = dir;
  groundLine(-PITCH.boxHalf, baseY, -PITCH.boxHalf, baseY + d * PITCH.boxDepth, 0.12);
  groundLine(PITCH.boxHalf, baseY, PITCH.boxHalf, baseY + d * PITCH.boxDepth, 0.12);
  groundLine(-PITCH.boxHalf, baseY + d * PITCH.boxDepth, PITCH.boxHalf, baseY + d * PITCH.boxDepth, 0.12);
  groundLine(-PITCH.sixHalf, baseY, -PITCH.sixHalf, baseY + d * PITCH.sixDepth, 0.12);
  groundLine(PITCH.sixHalf, baseY, PITCH.sixHalf, baseY + d * PITCH.sixDepth, 0.12);
  groundLine(-PITCH.sixHalf, baseY + d * PITCH.sixDepth, PITCH.sixHalf, baseY + d * PITCH.sixDepth, 0.12);

  var spot = baseY + d * PITCH.penSpot;
  groundDot(0, spot, 0.13);

  var edge = baseY + d * PITCH.boxDepth;
  var dy = Math.abs(edge - spot);
  if (dy < PITCH.arcR) {
    var a = Math.acos(dy / PITCH.arcR);
    var base = d > 0 ? Math.PI / 2 : -Math.PI / 2;
    groundArc(0, spot, PITCH.arcR, base - a, base + a, 0.12);
  }
}

function drawGoal(baseY, dir) {
  var post = PITCH.goalHalf, bar = PITCH.crossbar;
  var depth = 2.0 * dir;
  var backY = baseY - depth;
  var flare = 0.75;
  var i, t;

  /* THE NET.

     Was a flat white grid at one opacity, which is the thing the eye reads as
     "3D game from 2010" — real netting is a translucent volume, and volume
     means the panels cannot all be the same value. Three changes:

       - the back panel is darker than the side panels, because you are looking
         through two thicknesses of mesh to reach it and through one to reach
         the sides
       - the roof is lighter, because it is the panel actually facing the sky
       - the cords fade with depth for the same reason

     It matters more than it sounds: this is the surface the ball ends up in,
     and the goal camera now sits ten metres from it. */
  var C0 = cond();
  var netA = 0.30 + C0.flood * 0.14;
  var netFill = "rgba(240,248,255," + (netA * 0.72).toFixed(3) + ")";
  var netBack = "rgba(214,228,242," + (netA * 1.34).toFixed(3) + ")";
  var netRoof = "rgba(248,252,255," + (netA * 0.52).toFixed(3) + ")";
  var cord = "rgba(255,255,255,.80)";
  var cordFar = "rgba(226,238,250,.44)";

  /* back panel — the deepest, so the densest */
  poly3([{ x: -post - flare, y: backY, z: 0 }, { x: post + flare, y: backY, z: 0 },
         { x: post + flare, y: backY, z: bar * 0.92 }, { x: -post - flare, y: backY, z: bar * 0.92 }],
        netBack);
  /* roof — faces up, catches the most light */
  poly3([{ x: -post, y: baseY, z: bar }, { x: post, y: baseY, z: bar },
         { x: post + flare, y: backY, z: bar * 0.92 }, { x: -post - flare, y: backY, z: bar * 0.92 }],
        netRoof);
  /* sides */
  poly3([{ x: -post, y: baseY, z: 0 }, { x: -post - flare, y: backY, z: 0 },
         { x: -post - flare, y: backY, z: bar * 0.92 }, { x: -post, y: baseY, z: bar }], netFill);
  poly3([{ x: post, y: baseY, z: 0 }, { x: post + flare, y: backY, z: 0 },
         { x: post + flare, y: backY, z: bar * 0.92 }, { x: post, y: baseY, z: bar }], netFill);

  /* net cords */
  for (i = 0; i <= 18; i++) {
    t = i / 18;
    var nx = lerp(-post - flare, post + flare, t);
    var d0 = dir > 0 ? -netOffset(nx, 0) : 0;
    var d1 = dir > 0 ? -netOffset(nx, bar * 0.5) : 0;
    line3({ x: nx, y: backY + d0, z: 0 },
          { x: nx, y: backY + d1, z: bar * 0.92 }, cordFar, 1);
    line3({ x: lerp(-post, post, t), y: baseY, z: bar },
          { x: lerp(-post - flare, post + flare, t), y: backY, z: bar * 0.92 }, cord, 1);
  }
  for (i = 0; i <= 8; i++) {
    t = i / 8;
    var cz = bar * 0.92 * t;
    var e0 = dir > 0 ? -netOffset(-post, cz) : 0;
    var e1 = dir > 0 ? -netOffset(post, cz) : 0;
    /* Sag. Netting is hung, not stretched — the horizontal runs bow downward
       between the posts, most at mid-height where the mesh is least supported.
       Drawn as three segments so the bow is visible without a curve solver. */
    var sag = 0.16 * Math.sin(t * Math.PI);
    var mid = dir > 0 ? -netOffset(0, cz) : 0;
    line3({ x: -post - flare, y: backY + e0, z: cz },
          { x: -post * 0.4, y: backY + mid * 0.7, z: cz - sag * 0.7 }, cordFar, 1);
    line3({ x: -post * 0.4, y: backY + mid * 0.7, z: cz - sag * 0.7 },
          { x: post * 0.4, y: backY + mid * 0.7, z: cz - sag }, cordFar, 1);
    line3({ x: post * 0.4, y: backY + mid * 0.7, z: cz - sag },
          { x: post + flare, y: backY + e1, z: cz }, cordFar, 1);
  }
  for (i = 1; i <= 3; i++) {
    t = i / 4;
    line3({ x: lerp(-post, -post - flare, t), y: lerp(baseY, backY, t), z: lerp(bar, bar * 0.92, t) },
          { x: lerp(-post, -post - flare, t), y: lerp(baseY, backY, t), z: 0 }, cord, 1);
    line3({ x: lerp(post, post + flare, t), y: lerp(baseY, backY, t), z: lerp(bar, bar * 0.92, t) },
          { x: lerp(post, post + flare, t), y: lerp(baseY, backY, t), z: 0 }, cord, 1);
  }

  /* the frame — solid posts and bar with real thickness */
  /* Posts. A single pure-white flat has no roundness at all; splitting each
     into a lit face and a narrower shaded face costs one extra quad and makes
     them read as tubes. */
  var tk = 0.11;
  function bar3(ax, ay, az, bx, by, bz) {
    poly3([{ x: ax - tk, y: ay, z: az }, { x: bx - tk, y: by, z: bz },
           { x: bx + tk * 0.15, y: by, z: bz }, { x: ax + tk * 0.15, y: ay, z: az }], "#ffffff");
    poly3([{ x: ax + tk * 0.15, y: ay, z: az }, { x: bx + tk * 0.15, y: by, z: bz },
           { x: bx + tk, y: by, z: bz }, { x: ax + tk, y: ay, z: az }], "#c9d4de");
  }
  bar3(-post, baseY, 0, -post, baseY, bar);
  bar3(post, baseY, 0, post, baseY, bar);
  poly3([{ x: -post - tk, y: baseY, z: bar + tk }, { x: post + tk, y: baseY, z: bar + tk },
         { x: post + tk, y: baseY, z: bar + tk * 0.1 }, { x: -post - tk, y: baseY, z: bar + tk * 0.1 }],
        "#ffffff");
  poly3([{ x: -post - tk, y: baseY, z: bar + tk * 0.1 }, { x: post + tk, y: baseY, z: bar + tk * 0.1 },
         { x: post + tk, y: baseY, z: bar - tk }, { x: -post - tk, y: baseY, z: bar - tk }],
        "#cdd8e2");
}

function drawCornerFlags() {
  var xs = [-PITCH.halfW, PITCH.halfW], ys = [-PITCH.halfL, PITCH.halfL];
  for (var a = 0; a < 2; a++) {
    for (var b = 0; b < 2; b++) {
      var x = xs[a], y = ys[b];
      var c = toCam({ x: x, y: y, z: 0.7 });
      if (c.z < NEAR || c.z > 95) continue;
      line3({ x: x, y: y, z: 0 }, { x: x, y: y, z: 1.5 }, "#e8eef4", Math.max(1, 0.05 * toScreen(c).k));
      poly3([{ x: x, y: y, z: 1.5 }, { x: x, y: y, z: 1.16 },
             { x: x + (a ? -0.42 : 0.42), y: y, z: 1.26 }], "#ffd23d");
    }
  }
}

/* ---------------------------------------------------------------- actors */
function drawShadow(x, y, r, z, mul) {
  var s = scaleAt({ x: x, y: y, z: 0 });
  if (!s) return;
  /* offset the contact shadow away from the light, and soften it with height */
  var off = 0.16 + (z || 0) * 0.05;
  var p = project({ x: x - LIGHT.x * off, y: y - LIGHT.y * off, z: 0 });
  var spread = 1 + (z || 0) * 0.13;
  var rx = r * s * spread, ry = r * s * 0.42 * spread;
  if (rx < 0.6) return;
  var alpha = clamp(0.40 - (z || 0) * 0.035, 0.06, 0.40) * (mul === undefined ? 1 : mul);
  var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rx);
  g.addColorStop(0, "rgba(0,0,0," + (alpha * 1.15).toFixed(3) + ")");
  g.addColorStop(0.45, "rgba(0,0,0," + (alpha * 0.80).toFixed(3) + ")");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(1, ry / rx);
  ctx.translate(-p.x, -p.y);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p.x, p.y, rx, 0, 6.2832); ctx.fill();
  ctx.restore();
}

/* ---- rounded primitives ---------------------------------------------- */
var SHADE_CACHE = {};
function shade(hex, f) {
  var key = hex + "|" + f.toFixed(2);
  if (SHADE_CACHE[key]) return SHADE_CACHE[key];
  /* Accepts its own output as input — see parseCol. prism() shades whatever
     colour it is handed, per face, so this has to survive being called twice. */
  var c0 = parseCol(hex);
  var r = clamp(Math.round(c0[0] * f), 0, 255);
  var g = clamp(Math.round(c0[1] * f), 0, 255);
  var b = clamp(Math.round(c0[2] * f), 0, 255);
  var out = "rgb(" + r + "," + g + "," + b + ")";
  SHADE_CACHE[key] = out;
  return out;
}

/* When a face buffer is open, primitives queue into it instead of drawing, so
   an entire player can be depth-sorted as one object. Without this the far arm
   paints over the torso, because parts are drawn in call order. */
var FACE_BUF = null;
var SMOOTH = false;   // gouraud-style face gradients; only worth it up close
var SEAL = false;     // stroke fills to close antialiased seams between faces
var BIAS = 0;         // metres of depth bias: garments must beat the limb beneath

function openFaceBuf() { FACE_BUF = []; SEAL = true; }

function flushFaceBuf() {
  var buf = FACE_BUF;
  FACE_BUF = null;
  if (!buf) return;
  buf.sort(function (a, b) { return b.d - a.d; });
  for (var i = 0; i < buf.length; i++) {
    var e = buf[i];
    if (e.blob) { e.blob(); continue; }
    if (e.ga) {
      var ca = toCam(e.pa), cb = toCam(e.pb);
      if (ca.z > NEAR && cb.z > NEAR) {
        var sa = toScreen(ca), sb = toScreen(cb);
        if (Math.abs(sa.x - sb.x) + Math.abs(sa.y - sb.y) > 0.6) {
          var g = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
          g.addColorStop(0, e.ga); g.addColorStop(1, e.gb);
          poly3(e.p, g);
          continue;
        }
      }
    }
    poly3(e.p, e.col);
  }
  SEAL = false;
}

/* Sort, cull and shade a set of world-space faces. */
function drawFaces(faces, colour) {
  var i, f;
  for (i = 0; i < faces.length; i++) {
    f = faces[i];
    var q = f.p;
    var c = { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2, z: (q[0].z + q[2].z) / 2 };
    f.d = toCam(c).z;
    var toEye = unit3({ x: Cam.px - c.x, y: Cam.py - c.y, z: Cam.pz - c.z });
    f.vis = dot3(f.n, toEye) > 0.0;
  }
  if (FACE_BUF) {
    for (i = 0; i < faces.length; i++) {
      f = faces[i];
      if (!f.vis) continue;
      var e = { p: f.p, d: f.d - BIAS,
                col: shade(colour, 0.60 + 0.42 * clamp(dot3(f.n, LIGHT), 0, 1)) };
      if (SMOOTH && f.na) {
        var la = 0.60 + 0.42 * clamp(dot3(f.na, LIGHT), 0, 1);
        var lb = 0.60 + 0.42 * clamp(dot3(f.nb, LIGHT), 0, 1);
        if (Math.abs(la - lb) > 0.035) {
          e.ga = shade(colour, la); e.gb = shade(colour, lb);
          e.pa = f.ea; e.pb = f.eb;
        }
      }
      FACE_BUF.push(e);
    }
    return;
  }
  faces.sort(function (m, n) { return n.d - m.d; });
  for (i = 0; i < faces.length; i++) {
    f = faces[i];
    if (!f.vis) continue;
    poly3(f.p, shade(colour, 0.60 + 0.42 * clamp(dot3(f.n, LIGHT), 0, 1)));
  }
}

var SECT_CACHE = {};
function section(n) {
  if (SECT_CACHE[n]) return SECT_CACHE[n];
  var a = [];
  for (var i = 0; i < n; i++) {
    var t = (i + 0.5) / n * 6.2832;
    a.push({ x: Math.cos(t), y: Math.sin(t) });
  }
  SECT_CACHE[n] = a;
  return a;
}

/* A tapered elliptical prism: the workhorse for limbs and torsos. Round enough
   at eight sides to read as a cylinder, cheap enough to draw a squad of them. */
function prism(O, R, F, U, hw, hd, a, b, taperA, taperB, colour, sides, capTop, capBot) {
  var sect = section(sides || 8), n = sect.length, i;
  var lo = [], hi = [];
  function pt(sx, sy, u) {
    return { x: O.x + R.x * sx + F.x * sy + U.x * u,
             y: O.y + R.y * sx + F.y * sy + U.y * u,
             z: O.z + R.z * sx + F.z * sy + U.z * u };
  }
  for (i = 0; i < n; i++) {
    lo.push(pt(sect[i].x * hw * taperA, sect[i].y * hd * taperA, a));
    hi.push(pt(sect[i].x * hw * taperB, sect[i].y * hd * taperB, b));
  }
  var faces = [];
  for (i = 0; i < n; i++) {
    var j = (i + 1) % n;
    var mx = (sect[i].x + sect[j].x) / 2, my = (sect[i].y + sect[j].y) / 2;
    /* the true surface normal at each side edge — interpolating between them
       across the face is what turns a faceted prism into a smooth cylinder */
    var na = unit3({ x: R.x * sect[i].x + F.x * sect[i].y,
                     y: R.y * sect[i].x + F.y * sect[i].y,
                     z: R.z * sect[i].x + F.z * sect[i].y });
    var nb = unit3({ x: R.x * sect[j].x + F.x * sect[j].y,
                     y: R.y * sect[j].x + F.y * sect[j].y,
                     z: R.z * sect[j].x + F.z * sect[j].y });
    faces.push({
      p: [lo[i], lo[j], hi[j], hi[i]],
      n: unit3({ x: R.x * mx + F.x * my, y: R.y * mx + F.y * my, z: R.z * mx + F.z * my }),
      na: na, nb: nb,
      ea: { x: (lo[i].x + hi[i].x) / 2, y: (lo[i].y + hi[i].y) / 2, z: (lo[i].z + hi[i].z) / 2 },
      eb: { x: (lo[j].x + hi[j].x) / 2, y: (lo[j].y + hi[j].y) / 2, z: (lo[j].z + hi[j].z) / 2 }
    });
  }
  if (capTop) faces.push({ p: hi.slice().reverse(), n: U });
  if (capBot) faces.push({ p: lo, n: { x: -U.x, y: -U.y, z: -U.z } });
  drawFaces(faces, colour);
}

/* A sphere, drawn as a lit billboard — correct from every angle and one fill. */
function sphere(c, radius, colour, hairCol, up) {
  var cam = toCam(c);
  if (cam.z < NEAR) return null;
  var sp = toScreen(cam);
  var r = radius * sp.k;
  if (r < 0.7) return sp;
  if (FACE_BUF) {
    FACE_BUF.push({ d: cam.z, blob: function () {
      var was = FACE_BUF; FACE_BUF = null;
      sphere(c, radius, colour, hairCol, up);
      FACE_BUF = was;
    } });
    return sp;
  }
  var g = ctx.createRadialGradient(sp.x - r * 0.34, sp.y - r * 0.40, r * 0.06, sp.x, sp.y, r * 1.02);
  g.addColorStop(0, shade(colour, 1.16));
  g.addColorStop(0.62, shade(colour, 0.98));
  g.addColorStop(1, shade(colour, 0.58));
  ctx.save();
  ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, 6.2832);
  ctx.fillStyle = g; ctx.fill();
  if (hairCol && up && r > 2.2) {
    ctx.clip();
    ctx.beginPath();
    ctx.arc(sp.x + up.x * r * 0.62, sp.y + up.y * r * 0.62, r * 0.97, 0, 6.2832);
    ctx.fillStyle = shade(hairCol, 1.0);
    ctx.fill();
  }
  ctx.restore();
  return sp;
}

/* Eyes, drawn only when the head is actually turned toward the camera. At
   gameplay distance they are a few pixels, but they stop close-ups reading
   as mannequins. */
/* THE FACE.

   Was two dark ellipses for eyes and nothing else, which at close range read
   as a mannequin with holes in it. A face is legible from very few marks, but
   they have to be the right ones and in the right order: the brow carries the
   most identity, then the eye line, then the jaw shadow. Lips and nose bridge
   are almost irrelevant at this scale and are drawn as single soft strokes.

   Everything is placed in the head's OWN screen-projected right/up axes, so it
   tracks head rotation rather than sliding around the sphere — getting that
   wrong is how the face ended up painted on the ear in an earlier pass.

   Skips entirely below 46 px of head height: below that these marks turn into
   noise and cost frame time for nothing. */
function drawFace(centre, hd, r, hpx, ident) {
  /* 46 px was too low a bar. At that size the brow bar and the two eyes merge
     into one dark band across the head and the player reads as if wearing
     sunglasses — worse than no face at all. Nothing is drawn until there are
     enough pixels for the marks to stay separate. */
  if (hpx < 74) return;
  var toEye = unit3({ x: Cam.px - centre.x, y: Cam.py - centre.y, z: Cam.pz - centre.z });
  var facing = dot3(hd.F, toEye);
  if (facing < 0.25) return;
  var cam = toCam(centre);
  if (cam.z < NEAR) return;
  var sp = toScreen(cam);
  var rp = r * sp.k;
  if (rp < 5) return;

  function dirOf(ax) {
    var a = toScreen(toCam({ x: centre.x + ax.x * r, y: centre.y + ax.y * r,
                             z: centre.z + ax.z * r }));
    var dx = a.x - sp.x, dy = a.y - sp.y, m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  }
  var rr = dirOf(hd.R), uu = dirOf(hd.U);
  var fade = clamp((facing - 0.25) / 0.3, 0, 1);
  var id = ident || { brow: 0.5, jaw: 0.5, eye: 0.5 };

  /* place a point in head-local screen space: a = along right, b = along up */
  function P(a, b) {
    return { x: sp.x + rr.x * rp * a + uu.x * rp * b,
             y: sp.y + rr.y * rp * a + uu.y * rp * b };
  }

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.lineCap = "round";

  /* jaw and cheek shadow — only once there is room for it to read as bone
     structure rather than as a smudge */
  if (rp > 15) {
    var jaw = 0.10 + id.jaw * 0.09;
    ctx.strokeStyle = "rgba(58,38,24," + (0.16 + id.jaw * 0.10).toFixed(2) + ")";
    ctx.lineWidth = Math.max(0.8, rp * 0.07);
    ctx.beginPath();
    var j0 = P(-0.62, -0.30), j1 = P(0, -0.62 - jaw), j2 = P(0.62, -0.30);
    ctx.moveTo(j0.x, j0.y);
    ctx.quadraticCurveTo(j1.x, j1.y, j2.x, j2.y);
    ctx.stroke();
  }

  /* brow: the most identifying mark, but kept light. At full strength it joins
     up with the eyes into a single dark bar. */
  ctx.strokeStyle = "rgba(46,30,18,.30)";
  ctx.lineWidth = Math.max(0.8, rp * (0.055 + id.brow * 0.035));
  [-1, 1].forEach(function (sg) {
    var a = P(sg * 0.20, 0.30), b = P(sg * 0.52, 0.24 + id.brow * 0.05);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  });

  /* eyes: a dark almond with a light catch, not a flat dot */
  var eyeR = Math.max(0.8, rp * (0.075 + id.eye * 0.022));
  [-1, 1].forEach(function (sg) {
    var e = P(sg * 0.34, 0.10);
    ctx.fillStyle = "rgba(32,24,15,.82)";
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, eyeR * 1.05, eyeR * 1.25, 0, 0, 6.2832);
    ctx.fill();
    if (rp > 14) {
      ctx.fillStyle = "rgba(255,255,255,.60)";
      ctx.beginPath();
      ctx.arc(e.x - rr.x * eyeR * 0.34 + uu.x * eyeR * 0.36,
              e.y - rr.y * eyeR * 0.34 + uu.y * eyeR * 0.36, eyeR * 0.34, 0, 6.2832);
      ctx.fill();
    }
  });

  if (rp > 16) {
    /* nose: one short stroke down the centre line */
    ctx.strokeStyle = "rgba(74,48,30,.34)";
    ctx.lineWidth = Math.max(0.7, rp * 0.075);
    var n0 = P(0.02, 0.06), n1 = P(0.05, -0.16);
    ctx.beginPath(); ctx.moveTo(n0.x, n0.y); ctx.lineTo(n1.x, n1.y); ctx.stroke();

    /* mouth: a slight downward set, because a neutral straight line reads
       cheerful and a footballer mid-match is not */
    ctx.strokeStyle = "rgba(96,52,44,.46)";
    ctx.lineWidth = Math.max(0.8, rp * 0.085);
    var m0 = P(-0.20, -0.34), mc = P(0, -0.40), m1 = P(0.20, -0.34);
    ctx.beginPath(); ctx.moveTo(m0.x, m0.y);
    ctx.quadraticCurveTo(mc.x, mc.y, m1.x, m1.y); ctx.stroke();
  }
  ctx.restore();
}

/* HAIRSTYLES.

   One dark cap on every head made a squad of clones. Four silhouettes, chosen
   per player from their own seed, drawn in the head's projected axes on top of
   the head sphere: a low fade, a fuller crop, a topknot, and shaved. They read
   in silhouette, which is all that matters at gameplay distance, and they are
   the cheapest way to give eleven identical bodies distinct identities. */
function drawHair(centre, hd, r, hpx, style, colour) {
  if (hpx < 26) return;
  var cam = toCam(centre);
  if (cam.z < NEAR) return;
  var sp = toScreen(cam);
  var rp = r * sp.k;
  if (rp < 3.5) return;

  function dirOf(ax) {
    var a = toScreen(toCam({ x: centre.x + ax.x * r, y: centre.y + ax.y * r,
                             z: centre.z + ax.z * r }));
    var dx = a.x - sp.x, dy = a.y - sp.y, m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  }
  var rr = dirOf(hd.R), uu = dirOf(hd.U), ff = dirOf(hd.F);
  function P(a, b, c) {
    c = c || 0;
    return { x: sp.x + rr.x * rp * a + uu.x * rp * b + ff.x * rp * c,
             y: sp.y + rr.y * rp * a + uu.y * rp * b + ff.y * rp * c };
  }

  ctx.save();
  ctx.fillStyle = colour;

  if (style === 3) {
    /* shaved: a thin dark skullcap only */
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    var a0 = P(-0.96, 0.10), a1 = P(0, 1.02), a2 = P(0.96, 0.10);
    ctx.moveTo(a0.x, a0.y);
    ctx.quadraticCurveTo(a1.x, a1.y, a2.x, a2.y);
    ctx.quadraticCurveTo(P(0, 0.34).x, P(0, 0.34).y, a0.x, a0.y);
    ctx.fill();
    ctx.restore();
    return;
  }

  /* the cap, common to the remaining styles */
  ctx.beginPath();
  var c0 = P(-1.00, 0.02), c1 = P(0, 1.30), c2 = P(1.00, 0.02);
  ctx.moveTo(c0.x, c0.y);
  ctx.quadraticCurveTo(c1.x, c1.y, c2.x, c2.y);
  ctx.quadraticCurveTo(P(0, 0.18).x, P(0, 0.18).y, c0.x, c0.y);
  ctx.fill();

  if (style === 1) {
    /* fuller crop: a wider brim that overhangs the sides */
    ctx.beginPath();
    var d0 = P(-1.12, 0.16), d1 = P(0, 1.14), d2 = P(1.12, 0.16);
    ctx.moveTo(d0.x, d0.y);
    ctx.quadraticCurveTo(d1.x, d1.y, d2.x, d2.y);
    ctx.quadraticCurveTo(P(0, 0.52).x, P(0, 0.52).y, d0.x, d0.y);
    ctx.fill();
  } else if (style === 2) {
    /* topknot, sitting behind the crown so it reads from the front too */
    var k = P(0.02, 1.16, -0.30);
    ctx.beginPath();
    ctx.ellipse(k.x, k.y, rp * 0.30, rp * 0.26, 0, 0, 6.2832);
    ctx.fill();
  }
  ctx.restore();
}

/* screen-space direction of the player's own "up", for hair and kit details */
function screenUp(O, U) {
  var a = toCam(O), b = toCam({ x: O.x + U.x, y: O.y + U.y, z: O.z + U.z });
  if (a.z < NEAR || b.z < NEAR) return { x: 0, y: -1 };
  var pa = toScreen(a), pb = toScreen(b);
  var dx = pb.x - pa.x, dy = pb.y - pa.y;
  var m = Math.hypot(dx, dy) || 1;
  return { x: dx / m, y: dy / m };
}

/* Draw a limb along a joint's own -U axis (bones hang downward from a joint). */
function limb(j, hw, hd, from, to, taperA, taperB, colour, sides) {
  prism(j.o, j.R, j.F, j.U, hw, hd, -to, -from, taperA, taperB, colour, sides, false, false);
}

/* Choose the clip that matches what this player is doing right now. */
function pickClip(p, world) {
  /* two dive clips, picked by which way the keeper went — see anim.js for why
     a single symmetrical dive can only ever look like a starfish */
  if (p.role === "gk" && p.dive > 0.02) return p.diveDir < 0 ? "diveL" : "diveR";
  /* a keeper on their line is never idle — they are set, and bouncing */
  if (p.role === "gk") return "keeperSet";
  if (p.receiveT > 0) return "receive";
  if (p.kickT > 0) {
    if (p.kickMode === 2) return "chip";            /* a chip is its own shape */
    return p.kickIsPass ? "pass" : "strike";
  }
  if (world && world.phase === "over" && world.event === "goal" && p.team === "us") {
    /* stable per-player celebration, so a given player always celebrates the
       same way — that is what makes them read as a character rather than a
       random animation picker */
    var c = ["celebrate", "celebrate2", "celebrate3"][(p.num || 1) % 3];
    /* but while still sprinting away, run — arms aloft while sliding along the
       ground is the worst-looking frame in a celebration */
    return p.speed() > 2.2 ? "run" : c;
  }
  if (p.speed() > 0.8) return "run";
  if (p.team === "them") return "brace";
  return "idle";
}

/* ---- projected shadows ------------------------------------------------
   A blob ellipse reads as a decal. Casting the actual skeleton onto the pitch
   along the light direction gives a silhouette that stretches, skews and
   changes shape with the pose — which is what sells the figure as 3D.
   All limbs go into ONE path and are filled once, so overlaps do not stack
   into a black core. */
function groundProject(p) {
  var k = p.z / LIGHT.z;
  return { x: p.x - LIGHT.x * k, y: p.y - LIGHT.y * k };
}

function shadowSeg(path, a, b, wa, wb) {
  var ga = groundProject(a), gb = groundProject(b);
  var dx = gb.x - ga.x, dy = gb.y - ga.y;
  var m = Math.hypot(dx, dy) || 1e-6;
  var nx = -dy / m, ny = dx / m;
  var quad = [
    { x: ga.x + nx * wa, y: ga.y + ny * wa, z: 0.006 },
    { x: gb.x + nx * wb, y: gb.y + ny * wb, z: 0.006 },
    { x: gb.x - nx * wb, y: gb.y - ny * wb, z: 0.006 },
    { x: ga.x - nx * wa, y: ga.y - ny * wa, z: 0.006 }
  ];
  var first = true;
  for (var i = 0; i < 4; i++) {
    var c = toCam(quad[i]);
    if (c.z < NEAR) return;
    var sp = toScreen(c);
    if (first) { path.moveTo(sp.x, sp.y); first = false; }
    else path.lineTo(sp.x, sp.y);
  }
  path.closePath();
}

/* SHADOWS.

   The skeleton projection alone read as a dark smear across the turf, because a
   real shadow is two things and it only had one of them: a soft AMBIENT
   OCCLUSION pool tight under the body, and a sharper CAST silhouette stretched
   along the light. Drawing the silhouette without the pool leaves the figure
   looking like it is hovering with a stain nearby.

   Both are now drawn, the cast shadow softens and fades with the length of the
   throw (long shadows in low light are diffuse), and it is graded by the
   condition so a floodlit night has several faint shadows' worth of softness
   rather than one hard one. */
function drawRigShadow(J, s, alpha) {
  if (!ctx.roundRect && typeof Path2D === "undefined") return;
  var C = cond();
  /* a hard sun casts a crisp shadow; floodlights cast a soft one from several
     directions at once, which reads as a wide faint pool */
  var soft = 0.35 + C.flood * 0.55;
  alpha = alpha * (1 - soft * 0.45) * (0.55 + C.light * 0.55);
  var path = new Path2D();
  var W = s * 0.5;
  [["hipL", "knL", 0.085, 0.070], ["knL", "anL", 0.070, 0.055],
   ["hipR", "knR", 0.085, 0.070], ["knR", "anR", 0.070, 0.055],
   ["shL", "elL", 0.062, 0.050], ["elL", "haL", 0.050, 0.042],
   ["shR", "elR", 0.062, 0.050], ["elR", "haR", 0.050, 0.042],
   ["pelvis", "chest", 0.150, 0.165], ["chest", "head", 0.120, 0.095]
  ].forEach(function (b) {
    var a = J[b[0]], c = J[b[1]];
    if (a && c) shadowSeg(path, a.o, c.o, b[2] * W * 2, b[3] * W * 2);
  });
  ctx.save();
  ctx.fillStyle = "rgba(10,28,18," + alpha.toFixed(3) + ")";
  /* blur scales with softness — a crisp afternoon shadow at 1.5px, a floodlit
     one at 5px, which is the difference between "cast" and "ambient" */
  ctx.filter = "blur(" + (1.4 + soft * 3.8).toFixed(1) + "px)";
  ctx.fill(path);
  ctx.filter = "none";
  ctx.restore();
}

/* Ambient occlusion under the feet: the dark contact patch that grounds a
   figure. Tight, dark at the centre, and it does NOT move with the light —
   contact darkening is about proximity, not direction, and offsetting it is
   what makes a character look like a sticker on the grass. */
function drawContactAO(x, y, z, spread) {
  var sc = scaleAt({ x: x, y: y, z: 0 });
  if (!sc) return;
  var p = project({ x: x, y: y, z: 0 });
  var lift = clamp(1 - (z || 0) * 0.55, 0.15, 1);
  var rx = (0.30 * spread) * sc * (1 + (z || 0) * 0.5);
  if (rx < 0.7) return;
  var a = 0.42 * lift * (0.6 + cond().light * 0.5);
  var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rx);
  g.addColorStop(0, "rgba(6,20,12," + a.toFixed(3) + ")");
  g.addColorStop(0.5, "rgba(8,24,14," + (a * 0.5).toFixed(3) + ")");
  g.addColorStop(1, "rgba(8,24,14,0)");
  ctx.save();
  ctx.translate(p.x, p.y); ctx.scale(1, 0.40); ctx.translate(-p.x, -p.y);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p.x, p.y, rx, 0, 6.2832); ctx.fill();
  ctx.restore();
}

function drawPlayer(p, isCarrier, ball, dt, world) {
  var foot = toCam({ x: p.x, y: p.y, z: 0 });
  if (foot.z < NEAR || foot.z > 140) return;

  var hpx = Math.abs(toScreen(foot).y - toScreen(toCam({ x: p.x, y: p.y, z: 1.8 })).y);
  if (hpx < 9) return;
  var SD = hpx > 90 ? 10 : (hpx > 40 ? 7 : 4);
  SMOOTH = hpx > 34;

  var kit  = p.role === "gk" ? COL.gk     : (p.team === "us" ? COL.us     : COL.them);
  var alt  = p.role === "gk" ? COL.gkAlt  : (p.team === "us" ? COL.usAlt  : COL.themAlt);
  var sock = p.role === "gk" ? COL.gkSock : (p.team === "us" ? COL.usSock : COL.themSock);
  var seed = (p.num * 7 + (p.team === "us" ? 3 : 11) + (p.role === "gk" ? 5 : 0));
  /* sleeves in the shirt colour: a contrasting sleeve re-introduces exactly
     the hard vertical break the kit rework removed */
  var sleeve = kit;
  var skin = COL.skins[seed % COL.skins.length];
  var hair = COL.hairs[(seed * 3) % COL.hairs.length];

  /* PLAYER IDENTITY. Derived from the squad number so it is stable for a given
     player across every frame and every level, and so no two team-mates get the
     same combination. Eleven bodies from one rig only stop reading as clones if
     the head does the work. */
  if (!p._id) {
    p._id = {
      hair: (seed * 5) % 4,                       /* 0 fade 1 crop 2 knot 3 shaved */
      brow: ((seed * 7) % 100) / 100,
      jaw:  ((seed * 11) % 100) / 100,
      eye:  ((seed * 13) % 100) / 100,
      /* build: shoulder width and height multipliers, +-6% */
      broad: 0.94 + ((seed * 17) % 13) / 100,
      tall:  0.97 + ((seed * 19) % 7) / 100,
      /* boot flash colour, so a boot is a choice rather than a black block */
      boot: COL.bootFlash[(seed * 23) % COL.bootFlash.length]
    };
  }
  var ID = p._id;

  /* ---- animation state lives on the player, driven from game state ---- */
  if (!p._an) { p._an = new Animator(); p._rig = {}; p._an.cur = pickClip(p, world); }
  var an = p._an;
  var want = pickClip(p, world);
  an.play(want, false);
  /* step always — this is what advances the crossfade. The run cycle then has
     its clock overridden by stride phase so the feet do not skate. */
  /* Amplitude: a tap and a rocket now play the same clip at different sizes.
     Only the striking clips are scaled — scaling an idle or a run would just
     make the player smaller. */
  if (an.cur === "strike" || an.cur === "chip" || an.cur === "pass") {
    an.amp = 0.66 + (p.kickPower == null ? 0.7 : p.kickPower) * 0.42;
  } else {
    an.amp = 1;
  }

  an.step(dt || 0);
  if (an.cur === "run") an.t = p.anim * 0.115;
  if (an.prev === "run") an.prevT = p.anim * 0.115;
  /* Idle phase offset per player. Eleven players breathing in perfect unison is
     the clearest "these are clones" tell there is, and it costs one add. */
  if (an.cur === "idle" || an.cur === "brace") {
    an.t += (p.num || 1) * 0.37;
  }
  var pose = an.pose();

  /* ---- body frame ---- */
  var fa = p.face;
  if (ball && (p.speed() < 0.6 || (p.role === "gk" && p.dive > 0.05))) {
    fa = Math.atan2(ball.y - p.y, ball.x - p.x);
  }
  var F = { x: Math.cos(fa), y: Math.sin(fa), z: 0 };
  var R = { x: F.y, y: -F.x, z: 0 };
  var U = { x: 0, y: 0, z: 1 };

  var roll = (p.role === "gk" ? p.dive : 0) * p.diveDir * 1.45;
  if (roll) {
    var cs = Math.cos(roll), sn = Math.sin(roll);
    var R2 = { x: R.x * cs + U.x * sn, y: R.y * cs + U.y * sn, z: R.z * cs + U.z * sn };
    var U2 = { x: U.x * cs - R.x * sn, y: U.y * cs - R.y * sn, z: U.z * cs - R.z * sn };
    R = R2; U = U2;
  }

  var lift = (p.role === "gk" ? p.dive : 0) * 0.52;
  var run = Math.min(1, p.speed() / 6.5);
  /* Two rises per stride cycle — one per step — which is what the body does.
     Tied to the same distance-based phase as the legs, so it stays in step with
     them at any speed. The 0.72 puts exactly one sine period in the 8.7 units
     of phase that make up a cycle, and |sin| doubles that to two. */
  var bob = Math.abs(Math.sin(p.anim * 0.72)) * run * 0.045;

  /* the rig's own pelvis offset does the 0.92m lift — root is the ground point */
  var root = { x: p.x + U.x * bob, y: p.y + U.y * bob, z: lift + U.z * bob };

  var J = solveRig(pose, root, R, F, U, p._rig);

  drawContactAO(p.x, p.y, lift * 2, 1.0);       // grounds the figure
  drawRigShadow(J, 1.0, 0.40);                  // the cast silhouette

  openFaceBuf();

  /* ---- legs ---- */
  var LTH = boneLen("knL"), SHN = boneLen("anL");
  [["hipL", "knL", "anL"], ["hipR", "knR", "anR"]].forEach(function (t) {
    var hip = J[t[0]], kn = J[t[1]], an2 = J[t[2]];
    BIAS = 0;
    limb(hip, 0.091, 0.095, 0.16, LTH, 0.94, 0.78, skin, SD);    // thigh (below the hem)
    limb(kn, 0.074, 0.078, 0.0, SHN * 0.30, 1.0, 0.96, skin, SD); // knee/upper shin
    BIAS = 0.010;
    limb(kn, 0.078, 0.082, SHN * 0.26, SHN * 0.88, 0.98, 0.88, sock, SD);// sock
    /* boot sits on the foot joint, projecting forward along its own F */
    var bo = { x: an2.o.x + an2.F.x * 0.05, y: an2.o.y + an2.F.y * 0.05,
               z: an2.o.z + an2.F.z * 0.05 };
    BIAS = 0.035;
    var wasSmooth = SMOOTH; SMOOTH = false;
    /* Three parts instead of one block: a pale sole, a dark upper, and a flash
       stripe along the outside. At 90 px tall the sole is what makes it read as
       footwear rather than as a dark foot. */
    prism(bo, an2.R, an2.F, an2.U, 0.072, 0.126, -0.02, 0.050, 0.86, 1.0,
          COL.boot, 8, false, false);
    prism(bo, an2.R, an2.F, an2.U, 0.074, 0.128, -0.028, -0.008, 0.84, 0.96,
          "#e8eef4", 8, false, false);                       /* sole */
    if (hpx > 70) {
      prism(bo, an2.R, an2.F, an2.U, 0.075, 0.100, 0.004, 0.024, 0.88, 0.98,
            ID.boot, 8, false, false);                       /* flash stripe */
    }
    SMOOTH = wasSmooth; BIAS = 0;
    /* caps at the joints — without these a sharply bent knee opens a wedge */
    sphere(kn.o, 0.075, skin, null, null);
    BIAS = 0.012; sphere(hip.o, 0.092, alt, null, null); BIAS = 0;
  });

  /* ---- pelvis / torso ---- */
  var pel = J.pelvis, ch = J.chest;
  BIAS = 0.022;
  /* Shorts. The old cut ran to -0.25, which on this rig is most of the way down
     the thigh and read as a skirt under a bright white fill. */
  prism(pel.o, pel.R, pel.F, pel.U, 0.178, 0.128, -0.175, 0.17, 1.13, 1.02,
        p.team === "us" ? "#e4eaf0" : alt, SD, false, true);
  var TOR = boneLen("chest") + boneLen("spine");
  /* Athletic taper: narrow at the waist, broad across the chest. The old
     1.00 -> 1.34 was already tapered; the per-player build multiplier is what
     stops every torso being identical. A footballer's silhouette is a V. */
  prism(J.spine.o, J.spine.R, J.spine.F, J.spine.U, 0.166 * ID.broad, 0.108,
        -0.05, TOR, 0.96, 1.40 * ID.broad, kit, SD, true, false);

  /* THE KIT NEEDS A DESIGN.

     A white shirt with red sleeves is a real strip, but drawn as one flat
     maximum-contrast slab between two red arms it read as a sheet of paper
     taped to the player's back — the single most amateur thing left on the
     model. What was missing is any internal structure: a real shirt has a
     yoke across the shoulders, a hem, and a collar, and those three horizontal
     breaks are what stop the torso being one rectangle.

     Drawn as stacked bands on the same prism axis rather than as overlapping
     geometry, so nothing can sort against the torso and flicker. */
  /* Collar and hem only. A shoulder yoke was tried and removed: widening the
     top of the prism to carry it put a visible step in the shoulder line, and
     the darker collar it needed read as a black bar across the chest. */
  prism(J.spine.o, J.spine.R, J.spine.F, J.spine.U, 0.166, 0.108,
        -0.05, 0.030, 1.00, 1.02, alt, SD, true, false);                 // hem
  prism(J.spine.o, J.spine.R, J.spine.F, J.spine.U, 0.166, 0.108,
        TOR - 0.010, TOR, 1.335, 1.35, alt, SD, true, false);            // collar
  BIAS = 0;

  /* ---- arms ---- */
  var UA = boneLen("elL"), FA = boneLen("haL");
  [["shL", "elL", "haL"], ["shR", "elR", "haR"]].forEach(function (t) {
    var sh = J[t[0]], el = J[t[1]], ha = J[t[2]];
    /* Garment bias stays BELOW the torso's 0.022. The far arm gets the same
       bias as the near one, so pushing sleeves further forward makes the far
       sleeve win against the chest — which is the exact "far arm paints over
       the torso" failure this buffer exists to prevent. */
    BIAS = 0;
    limb(el, 0.053, 0.056, -UA * 0.16, FA, 1.02, 0.86, skin, SD);    // forearm
    sphere(el.o, 0.055, skin, null, null);                           // elbow cap
    BIAS = 0.012;
    limb(sh, 0.066 * ID.broad, 0.069, 0.0, UA * 0.86, 1.06, 0.92, sleeve, SD); // sleeve
    limb(sh, 0.064, 0.067, UA * 0.80, UA * 0.90, 0.94, 0.90, alt, SD); // cuff
    /* smaller shoulder cap — at 0.070 it stood proud of the sleeve as a ball */
    sphere(sh.o, 0.062, sleeve, null, null);
    BIAS = 0;
    sphere(ha.o, 0.057, p.role === "gk" ? "#f2f4f7" : skin, null, null);
  });

  /* ---- neck and head ---- */
  prism(J.neck.o, J.neck.R, J.neck.F, J.neck.U, 0.068, 0.066,
        -0.06, boneLen("head") + 0.01, 1.05, 0.86, skin, SD, false, false);
  var hd = J.head;
  var up = screenUp(hd.o, hd.U);
  var hc = { x: hd.o.x + hd.U.x * 0.068, y: hd.o.y + hd.U.y * 0.068, z: hd.o.z + hd.U.z * 0.068 };
  /* the sphere's own hair cap is suppressed for the styled hair below */
  sphere(hc, 0.127, skin, null, up);

  flushFaceBuf();
  /* after the flush — the head sphere is queued and would paint over these */
  drawHair(hc, hd, 0.127, hpx, ID.hair, hair);
  drawFace(hc, hd, 0.127, hpx, ID);

  /* squad number on the back of the shirt */
  if (p.num) {
    var bc = { x: ch.o.x - ch.F.x * 0.115 + ch.U.x * 0.02,
               y: ch.o.y - ch.F.y * 0.115 + ch.U.y * 0.02,
               z: ch.o.z - ch.F.z * 0.115 + ch.U.z * 0.02 };
    var cam = toCam(bc);
    var toEye = unit3({ x: Cam.px - bc.x, y: Cam.py - bc.y, z: Cam.pz - bc.z });
    if (cam.z > NEAR && dot3({ x: -ch.F.x, y: -ch.F.y, z: -ch.F.z }, toEye) > 0.25) {
      var sp3 = toScreen(cam);
      var fs = 0.25 * sp3.k;
      if (fs > 7) {
        ctx.save();
        ctx.fillStyle = alt;
        ctx.font = "900 " + fs.toFixed(1) + "px system-ui,sans-serif";
        ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = fs * 0.10;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.num, sp3.x, sp3.y);
        ctx.restore();
      }
    }
  }

  if (isCarrier) {
    /* SELECTION MARKER.

       Was a single hard lime ellipse — one flat aliased stroke sitting on the
       grass, which is the look of a debug gizmo and was the cheapest-looking
       thing in the aim frame. What a premium game puts under the active player
       is a light, and a light has three parts: a soft pool bleeding onto the
       turf, a bright rim, and something moving so the eye knows it is live.

       The sweep is deliberately slow. A fast spinner reads as a loading
       indicator; a slow one reads as a spotlight. */
    var sc = scaleAt({ x: p.x, y: p.y, z: 0 });
    var g2 = toScreen(foot);
    var rx = 1.05 * sc, ry = rx * 0.42;
    var pulse = 0.5 + 0.5 * Math.sin(CROWD_T * 2.2);

    ctx.save();

    /* the pool: an elliptical gradient, additive so it lifts the turf */
    ctx.globalCompositeOperation = "screen";
    ctx.translate(g2.x, g2.y);
    ctx.scale(1, 0.42);
    var pg = ctx.createRadialGradient(0, 0, rx * 0.18, 0, 0, rx * 1.24);
    pg.addColorStop(0.00, "rgba(120,255,190," + (0.20 + pulse * 0.07).toFixed(3) + ")");
    pg.addColorStop(0.62, "rgba(80,240,170,.10)");
    pg.addColorStop(1.00, "rgba(60,220,150,0)");
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(0, 0, rx * 1.24, 0, 6.2832); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.lineCap = "round";

    /* the rim, thin and bright */
    ctx.strokeStyle = "rgba(150,255,205,.78)";
    ctx.lineWidth = Math.max(1.2, 0.045 * sc);
    ctx.beginPath();
    ctx.ellipse(g2.x, g2.y, rx, ry, 0, 0, 6.2832);
    ctx.stroke();

    /* a brighter arc sweeping round it */
    var a0 = (CROWD_T * 1.15) % 6.2832;
    var grd = ctx.createLinearGradient(g2.x - rx, g2.y, g2.x + rx, g2.y);
    grd.addColorStop(0, "rgba(200,255,46,0)");
    grd.addColorStop(0.5, "rgba(220,255,120,.95)");
    grd.addColorStop(1, "rgba(200,255,46,0)");
    ctx.strokeStyle = grd;
    ctx.lineWidth = Math.max(1.8, 0.075 * sc);
    ctx.beginPath();
    ctx.ellipse(g2.x, g2.y, rx, ry, 0, a0, a0 + 1.5);
    ctx.stroke();

    /* No direction chevrons here. They were tried on the grass in front of the
       player and had to come out: the camera sits BEHIND the carrier looking
       down the pitch, so ground in front of them projects into the same screen
       area as their body, and since the marker is drawn after the figure the
       chevrons painted straight over the shirt as a chain of amber diamonds.
       Any facing indicator has to go under the feet or above the head. */
    ctx.restore();
  }
}

/* Twelve patch centres on a unit sphere — an icosahedron's vertices, which is
   close enough to a real ball's panel layout to read correctly while rolling. */
var BALL_PTS = null;
function ballPts() {
  if (BALL_PTS) return BALL_PTS;
  var t = (1 + Math.sqrt(5)) / 2;
  var v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
           [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  BALL_PTS = v.map(function (a) {
    var m = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / m, a[1] / m, a[2] / m];
  });
  return BALL_PTS;
}

function drawBall(b) {
  /* AO under the ball plus a stretched cast shadow. A ball in flight with one
     fixed round shadow reads as a cursor; the cast shadow has to travel away
     from it along the light as it climbs. */
  drawContactAO(b.x, b.y, b.z, 0.75);
  drawShadow(b.x, b.y, 0.22 + b.z * 0.010, b.z, 0.50);

  var cam = toCam({ x: b.x, y: b.y, z: b.z + 0.12 });
  if (cam.z < NEAR) return;
  var sp = toScreen(cam);
  var r = Math.max(2.2, 0.145 * sp.k);

  var speed = b.speed ? b.speed() : Math.hypot(b.vx || 0, b.vy || 0);

  /* Motion trail. Opacity and width now scale with pace, so a tap leaves
     almost nothing and a rocket leaves a comet — a fixed trail makes every
     kick look identically hard, which flattens the whole game's feel. */
  if (b.trail.length > 2) {
    var pace = clamp(speed / 30, 0, 1);
    ctx.save();
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "screen";
    for (var i = 1; i < b.trail.length; i++) {
      var t0 = b.trail[i - 1], t1 = b.trail[i];
      var c0 = toCam({ x: t0.x, y: t0.y, z: t0.z + 0.12 });
      var c1 = toCam({ x: t1.x, y: t1.y, z: t1.z + 0.12 });
      if (c0.z < NEAR || c1.z < NEAR) continue;
      var a = i / b.trail.length;
      var p0 = toScreen(c0), p1 = toScreen(c1);
      var al = a * a * (0.10 + pace * 0.34);
      ctx.strokeStyle = "rgba(214,236,255," + al.toFixed(3) + ")";
      ctx.lineWidth = clamp(0.13 * p1.k * a * (1 + pace * 1.4), 0.8, 16);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    ctx.restore();
  }

  /* Squash. The ball deforms along the axis it was hit on and recovers with a
     wobble. Projected to screen space as a rotated ellipse — a perfectly round
     ball through every impact is the clearest tell of a toy renderer. */
  var sq = (typeof FEEL !== "undefined") ? FEEL.ballSquash() : null;
  var sqx = 1, sqy = 1, sqRot = 0;
  if (sq) {
    var amt = clamp(sq.amount, 0, 0.8);
    /* screen-space direction of the squash axis */
    var tip = toCam({ x: b.x + sq.axis.x * 0.4, y: b.y + sq.axis.y * 0.4,
                      z: b.z + 0.12 + sq.axis.z * 0.4 });
    if (tip.z > NEAR) {
      var ts = toScreen(tip);
      sqRot = Math.atan2(ts.y - sp.y, ts.x - sp.x);
    }
    sqx = 1 - amt * 0.55;              // flattened along the impact axis
    sqy = 1 + amt * 0.38;              // and bulging across it
  }

  ctx.save();
  if (sq) {
    ctx.translate(sp.x, sp.y);
    ctx.rotate(sqRot);
    ctx.scale(sqx, sqy);
    ctx.rotate(-sqRot);
    ctx.translate(-sp.x, -sp.y);
  }
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = Math.min(10, r * 1.2);

  /* lit sphere */
  var g = ctx.createRadialGradient(sp.x - r * 0.36, sp.y - r * 0.40, r * 0.05, sp.x, sp.y, r * 1.04);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.55, "#f2f5f8");
  g.addColorStop(1, "#9aa8b4");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, 6.2832); ctx.fill();
  ctx.shadowBlur = 0;

  /* panels, rotated so the ball visibly rolls */
  if (r > 3.2) {
    ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, 6.2832); ctx.clip();
    var pts = ballPts(), ang = b.rot;
    var ca = Math.cos(ang), sa = Math.sin(ang);
    for (var k = 0; k < pts.length; k++) {
      var px = pts[k][0];
      var py = pts[k][1] * ca - pts[k][2] * sa;
      var pz = pts[k][1] * sa + pts[k][2] * ca;
      if (pz <= 0.06) continue;                     // far side of the ball
      var pr = r * 0.185 * (0.5 + 0.5 * pz);
      ctx.fillStyle = "rgba(30,38,46," + (0.30 + 0.42 * pz).toFixed(2) + ")";
      ctx.beginPath();
      ctx.ellipse(sp.x + px * r * 0.68, sp.y + py * r * 0.68,
                  pr, pr * (0.5 + 0.5 * pz), 0, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------- aim path */
function drawAim(drag, world) {
  if (!drag || !drag.pts.length) return;
  var pts = drag.pts, i;

  /* faint guide showing the stroke your thumb actually drew */
  for (i = 1; i < pts.length; i++) {
    groundLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, 0.16, "rgba(255,255,255,.10)");
  }

  /* The aim line proper: the TRUE predicted flight, as a run of white dots
     that shrink with distance because they are sized in metres. */
  if (drag.preview && drag.preview.length > 3) {
    var pv = drag.preview, show = Math.floor(pv.length * 0.62);
    ctx.save();
    for (i = 1; i < show; i += 2) {
      var q = pv[i];
      var c = toCam({ x: q.x, y: q.y, z: q.z + 0.08 });
      if (c.z < NEAR) continue;
      var sp = toScreen(c);
      var rr = Math.max(1.3, 0.115 * sp.k);
      var a = 0.95 - 0.5 * (i / show);
      ctx.fillStyle = "rgba(255,255,255," + a.toFixed(2) + ")";
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rr, 0, 6.2832); ctx.fill();
      /* a fainter dot on the grass beneath a lofted ball, so you can read height */
      if (q.z > 0.35) {
        var cg = toCam({ x: q.x, y: q.y, z: 0.02 });
        if (cg.z > NEAR) {
          var sg = toScreen(cg);
          ctx.fillStyle = "rgba(0,0,0,.20)";
          ctx.beginPath(); ctx.arc(sg.x, sg.y, Math.max(1, 0.10 * sg.k), 0, 6.2832); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /* dashed target ring on the grass */
  var last = pts[pts.length - 1];
  var rad = drag.targetMate ? 1.35 : 0.8;
  var col = drag.targetMate ? "rgba(70,255,150,.95)" : "rgba(255,255,255,.85)";
  for (i = 0; i < 12; i += 2) {
    groundArc(last.x, last.y, rad, i / 12 * 6.2832, (i + 1) / 12 * 6.2832, 0.14, col);
  }

  /* power arc floating above the ball */
  var b = world.ball;
  var sp2 = project({ x: b.x, y: b.y, z: 0 });
  var sc = scaleAt({ x: b.x, y: b.y, z: 0 });
  var rr2 = Math.max(14, 0.85 * sc);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,.22)";
  ctx.lineWidth = Math.max(3, 0.1 * sc);
  ctx.beginPath(); ctx.arc(sp2.x, sp2.y, rr2, -Math.PI * 0.86, -Math.PI * 0.14); ctx.stroke();
  var pw = clamp(drag.power, 0, 1);
  ctx.strokeStyle = pw > 0.86 ? "#ffd23d" : "#ffffff";
  ctx.beginPath();
  ctx.arc(sp2.x, sp2.y, rr2, -Math.PI * 0.86, -Math.PI * 0.86 + Math.PI * 0.72 * pw);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------- off-screen indicators */
function edgeMark(wx, wy, label, colour, dim) {
  var c = toCam({ x: wx, y: wy, z: 0 });
  var pad = 26;
  var l = VP.x + pad, r = VP.x + VP.w - pad, t = VP.y + pad + 96, bot = VP.y + VP.h - pad - 120;
  var sx, sy;
  if (c.z < NEAR) { sx = Cam.cx; sy = VP.y + VP.h; }     // behind the camera
  else { var s = toScreen(c); sx = s.x; sy = s.y; }
  if (sx >= l && sx <= r && sy >= t && sy <= bot) return false;

  var cx = clamp(sx, l, r), cy = clamp(sy, t, bot);
  var ang = Math.atan2(sy - cy, sx - cx);

  ctx.save();
  ctx.globalAlpha = dim ? 0.6 : 0.95;
  ctx.translate(cx, cy);
  ctx.fillStyle = colour;
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(11, 0); ctx.lineTo(1, -6.5); ctx.lineTo(1, 6.5);
  ctx.closePath(); ctx.fill();
  ctx.rotate(-ang);
  ctx.font = "800 10px system-ui,sans-serif";
  var wTxt = ctx.measureText(label).width;
  var pillW = Math.max(20, wTxt + 12);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-pillW / 2, -10, pillW, 20, 10);
  else ctx.arc(0, 0, 10, 0, 6.2832);
  ctx.fillStyle = "rgba(4,14,9,.92)"; ctx.fill();
  ctx.strokeStyle = colour; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.fillStyle = colour;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 0.5);
  ctx.restore();
  return true;
}

function drawOffscreen(world) {
  /* teammate arrows and the range read-out are aiming aids. Leaving them on
     through a goal put a "4m" badge over the celebration. */
  if (world.phase !== "aim") return;

  var b = world.ball, i;
  for (i = 0; i < world.us.length; i++) {
    var p = world.us[i];
    if (p === world.carrier) continue;
    edgeMark(p.x, p.y, String(p.num), "#3dff9e", false);
  }
  edgeMark(0, GOAL_Y - 1, Math.round(dist(b.x, b.y, 0, GOAL_Y)) + "m", "#ffffff", true);
}

/* ---- effects ----------------------------------------------------------
   Short-lived, purely presentational particles. The simulation never reads
   them, so they cannot affect gameplay. */
var FX = [];

function fxBurst(x, y, z, count, opts) {
  opts = opts || {};
  for (var i = 0; i < count; i++) {
    var a = Math.random() * 6.2832;
    var sp = (opts.speed || 3) * (0.35 + Math.random() * 0.65);
    FX.push({
      x: x, y: y, z: z,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      vz: (opts.up || 2.2) * (0.3 + Math.random()),
      life: 0, max: opts.life || 0.55,
      r: opts.r || 0.09, col: opts.col || "255,255,255",
      grav: opts.grav === undefined ? 7.5 : opts.grav,
      /* a ribbon tumbles and draws as a streak, so confetti reads as paper
         rather than as a shower of identical dots */
      ribbon: opts.ribbon ? 1 : 0,
      spin: (Math.random() * 2 - 1) * 9,
      ang: Math.random() * 6.2832,
      glow: opts.glow ? 1 : 0
    });
  }
}

function fxStep(dt) {
  for (var i = FX.length - 1; i >= 0; i--) {
    var f = FX[i];
    f.life += dt;
    if (f.life >= f.max) { FX.splice(i, 1); continue; }
    f.vz -= f.grav * dt;
    if (f.ribbon) {
      /* paper has drag and flutters — without it confetti falls like gravel */
      f.vx *= (1 - 2.1 * dt); f.vy *= (1 - 2.1 * dt); f.vz *= (1 - 1.5 * dt);
      f.vx += Math.sin(f.life * 7 + f.ang) * 1.4 * dt;
      f.ang += f.spin * dt;
    }
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (f.z < 0) { f.z = 0; f.vz *= -0.35; f.vx *= 0.7; f.vy *= 0.7; }
  }
}

function drawFX() {
  ctx.save();
  for (var i = 0; i < FX.length; i++) {
    var f = FX[i];
    var c = toCam({ x: f.x, y: f.y, z: f.z });
    if (c.z < NEAR) continue;
    var sp = toScreen(c);
    var t = 1 - f.life / f.max;
    var rr = Math.max(0.6, f.r * sp.k * (0.5 + t * 0.9));

    if (f.ribbon) {
      /* a flat strip seen edge-on: width collapses as it tumbles */
      rr = Math.min(rr, 7);
      var w = Math.abs(Math.cos(f.ang)) * rr * 0.9 + rr * 0.14;
      ctx.globalAlpha = Math.min(1, t * 1.4);
      ctx.fillStyle = "rgb(" + f.col + ")";
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(f.ang * 0.5);
      ctx.fillRect(-w, -rr * 2.1, w * 2, rr * 4.2);
      ctx.restore();
      continue;
    }

    /* Cap the on-screen size. Particle radius is specified in metres, which is
       correct in the world but means the goal camera — now 7 m from the net
       rather than 30 m up the pitch — inflated every spark into a soft pale
       disc. Perfect translucent circles read as lens bokeh, and that is
       precisely what they looked like. */
    rr = Math.min(rr, 5.2);

    /* Draw a spark as a streak along its own velocity rather than as a dot.
       A moving light source photographs as a line; drawing it as a circle is
       the single thing that made these read as confetti instead of sparks. */
    var vsp = Math.hypot(f.vx, f.vy, f.vz);
    if (f.glow && vsp > 2.5) {
      var tail = toCam({ x: f.x - f.vx * 0.030, y: f.y - f.vy * 0.030,
                         z: Math.max(0, f.z - f.vz * 0.030) });
      if (tail.z > NEAR) {
        var tp = toScreen(tail);
        var lg = ctx.createLinearGradient(tp.x, tp.y, sp.x, sp.y);
        lg.addColorStop(0, "rgba(" + f.col + ",0)");
        lg.addColorStop(1, "rgba(" + f.col + "," + (t * 0.95).toFixed(3) + ")");
        ctx.globalCompositeOperation = "screen";
        ctx.strokeStyle = lg;
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(0.8, rr * 0.95);
        ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
        /* hot head on the leading end */
        ctx.fillStyle = "rgba(255,255,250," + (t * 0.9).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(sp.x, sp.y, rr * 0.42, 0, 6.2832); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        continue;
      }
    }

    ctx.globalAlpha = 1;
    if (f.glow) {
      ctx.globalCompositeOperation = "screen";
      var g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rr * 2.0);
      g.addColorStop(0, "rgba(" + f.col + "," + (t * 0.8).toFixed(3) + ")");
      g.addColorStop(1, "rgba(" + f.col + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rr * 2.0, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.fillStyle = "rgba(" + f.col + "," + (t * 0.72).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, rr * 0.8, 0, 6.2832);
    ctx.fill();
  }
  ctx.restore();
}

/* ---- ground rings ------------------------------------------------------
   An expanding ring on the turf at the point of contact. Sold entirely by
   easing: it must leave fast and stop dead, or it reads as a ripple in water
   rather than as a shockwave. */
var RINGS = [];

function impactRing(x, y, power) {
  RINGS.push({ x: x, y: y, t: 0, max: 0.46 + power * 0.20,
               r0: 0.35, r1: 2.2 + power * 3.4, w: 1 + power * 2.4 });
}

function ringStep(dt) {
  for (var i = RINGS.length - 1; i >= 0; i--) {
    RINGS[i].t += dt;
    if (RINGS[i].t >= RINGS[i].max) RINGS.splice(i, 1);
  }
}

function drawRings() {
  for (var i = 0; i < RINGS.length; i++) {
    var R = RINGS[i];
    var p = R.t / R.max;
    var e = 1 - Math.pow(1 - p, 3);                 // out-cubic: fast then still
    var r = R.r0 + (R.r1 - R.r0) * e;
    var a = (1 - p) * (1 - p) * 0.7;
    if (a < 0.01) continue;
    var pts = [], n = 26;
    for (var k = 0; k <= n; k++) {
      var th = k / n * 6.2832;
      var c = toCam({ x: R.x + Math.cos(th) * r, y: R.y + Math.sin(th) * r, z: 0.012 });
      if (c.z < NEAR) { pts = null; break; }
      pts.push(toScreen(c));
    }
    if (!pts) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,255,255," + a.toFixed(3) + ")";
    ctx.lineWidth = Math.max(0.7, R.w * (1 - p) * 2.4);
    ctx.stroke();
  }
}

/* net ripple — the mesh pushes back where the ball hit it */
var NET = { t: 0, x: 0, z: 0 };

function netHit(x, z) { NET.t = 0.85; NET.x = x; NET.z = z; }

function netOffset(x, z) {
  if (NET.t <= 0) return 0;
  var d = Math.hypot(x - NET.x, z - NET.z);
  var wave = Math.sin(d * 3.4 - (0.85 - NET.t) * 22) * Math.exp(-d * 1.1);
  return wave * NET.t * 0.30;
}

/* ---- rain -------------------------------------------------------------
   Screen-space streaks, not world particles. Rain is close to the lens and
   effectively parallel at this scale, so simulating drops in metres buys
   nothing and costs a great deal; what sells it is the LAYERS — a fast bright
   near layer, a slow dim far layer, and splashes picking out the turf. */
var RAIN = null;
var RAIN_T = 0;

function rainData(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      x: Math.random(), y: Math.random(),
      /* three depth layers: near drops are longer, faster and brighter */
      layer: i % 3,
      sp: 0.7 + Math.random() * 0.6,
      len: 0.5 + Math.random() * 0.9
    });
  }
  return out;
}

function drawRain(dt) {
  var C = cond();
  if (!C.rain) return;
  RAIN_T += dt;
  if (!RAIN) RAIN = rainData(230);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  var lean = VP.w * 0.10;                       // wind
  for (var i = 0; i < RAIN.length; i++) {
    var d = RAIN[i];
    var L = [1.0, 0.62, 0.36][d.layer];
    var speed = (1.35 + d.layer * -0.35) * d.sp;
    var yy = ((d.y + RAIN_T * speed) % 1);
    var x = VP.x + d.x * VP.w + yy * lean * (0.3 + L);
    var y = VP.y - OVER + yy * (VP.h + OVER * 2);
    var len = (VP.h * 0.030) * d.len * L;
    ctx.strokeStyle = "rgba(214,232,250," + (0.30 * L * C.rain).toFixed(3) + ")";
    ctx.lineWidth = 0.7 + L * 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - lean * 0.055 * (0.3 + L), y + len);
    ctx.stroke();
  }
  ctx.restore();
}

/* Splashes on the turf. Drawn in world space on the ground plane so they sit
   in perspective and get smaller with distance, which is what stops rain from
   looking like an overlay pasted on top of the picture. */
var SPLASH = null;
function drawSplashes(dt) {
  var C = cond();
  if (!C.rain) return;
  if (!SPLASH) {
    SPLASH = [];
    for (var i = 0; i < 90; i++) {
      SPLASH.push({ x: rnd(-34, 34), y: rnd(GOAL_Y, PITCH.halfL * 0.5),
                    t: Math.random() * 0.6, dur: 0.34 + Math.random() * 0.3 });
    }
  }
  ctx.save();
  for (var k = 0; k < SPLASH.length; k++) {
    var s2 = SPLASH[k];
    s2.t += dt;
    if (s2.t > s2.dur) {
      s2.t = 0;
      s2.x = rnd(-34, 34);
      s2.y = rnd(GOAL_Y, PITCH.halfL * 0.5);
      continue;
    }
    var p = s2.t / s2.dur;
    var c = toCam({ x: s2.x, y: s2.y, z: 0.01 });
    if (c.z < NEAR || c.z > 60) continue;
    var sp = toScreen(c);
    var r = (0.05 + p * 0.16) * sp.k;
    if (r < 0.6) continue;
    ctx.strokeStyle = "rgba(224,240,255," + ((1 - p) * 0.34).toFixed(3) + ")";
    ctx.lineWidth = Math.max(0.6, 0.02 * sp.k);
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, r, r * 0.40, 0, 0, 6.2832);
    ctx.stroke();
  }
  ctx.restore();
}

/* THE GOAL REPLAY.

   A goal used to cut straight to a result card. The replay is the moment a
   player screenshots and the moment the goal gets to land twice, and it is the
   only natural share beat the game has — its absence was the biggest single
   hole left in match presentation.

   How it works: sim.js keeps a tape of the whole attempt (ball plus every
   player's position, facing, velocity and stride phase). Playback writes those
   values straight back onto the live player objects and renders normally, which
   means the replay gets the real animation system, the real kit, the real
   lighting — everything — for the cost of an array.

   That is safe here and only here: the level is already decided, the tape is
   discarded on the next attempt, and starting a level rebuilds the world. It
   would not be safe mid-play.

   The replay runs slightly slow (0.72x) from a low angle behind the near post,
   because that is the shot that makes a finish look hard. */
var REPLAY = {
  on: false, t: 0, dur: 0, tape: null, from: 0,
  saved: null, angle: 0, world: null, play: 0, hold: 0
};

function replayStart(world) {
  var tape = world.tape;
  if (!tape || tape.length < 8) return false;

  /* The whole attempt, not a tail of it. A single-touch level only produces
     about 0.9 s of flight — roughly 25 taped frames — so there is nothing to
     trim, and playing a fragment of that would be over before the eye settled.
     Run it at 0.45x and hold the final frame, which is the one worth seeing. */
  REPLAY.tape = tape;
  REPLAY.from = 0;
  REPLAY.t = 0;
  REPLAY.play = tape.length * 0.035 / 0.45;      // 0.45x speed
  REPLAY.hold = 0.72;                            // freeze on the ball in the net
  REPLAY.dur = REPLAY.play + REPLAY.hold;
  REPLAY.on = true;
  /* pick the side to shoot from based on where the goal went, so the camera is
     never looking through the net */
  REPLAY.angle = (world.goalX || 0) >= 0 ? 1 : -1;

  /* remember live state so the celebration can resume if the replay is cut */
  var all = world.us.concat(world.them), sv = [];
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    sv.push(p.x, p.y, p.face, p.vx, p.vy, p.anim);
  }
  REPLAY.saved = { p: sv, bx: world.ball.x, by: world.ball.y, bz: world.ball.z };
  REPLAY.world = world;
  return true;
}

function replayStop(world) {
  if (!REPLAY.on) { REPLAY.saved = null; REPLAY.world = null; return; }
  REPLAY.on = false;
  var sv = REPLAY.saved;
  /* Only restore into the world the tape was captured from. startLevel() calls
     this after building a NEW world, and writing the old world's positions onto
     the new one would teleport the whole squad. */
  if (!sv || !world || REPLAY.world !== world) {
    REPLAY.saved = null; REPLAY.world = null; return;
  }
  var all = world.us.concat(world.them);
  for (var i = 0; i < all.length; i++) {
    var p = all[i], o = i * 6;
    p.x = sv.p[o]; p.y = sv.p[o + 1]; p.face = sv.p[o + 2];
    p.vx = sv.p[o + 3]; p.vy = sv.p[o + 4]; p.anim = sv.p[o + 5];
  }
  world.ball.x = sv.bx; world.ball.y = sv.by; world.ball.z = sv.bz;
  REPLAY.saved = null;
  REPLAY.world = null;
}

/* Advance playback and write the taped frame onto the live objects. Called
   before anything is drawn, so the whole renderer sees the replayed state. */
function replayStep(world, dt) {
  if (!REPLAY.on) return;
  REPLAY.t += dt;
  if (REPLAY.t >= REPLAY.dur) { replayStop(world); return; }

  var tape = REPLAY.tape;
  var span = tape.length - REPLAY.from;
  /* clamp at 1 through the hold, so the last frame freezes rather than looping */
  var prog = clamp(REPLAY.t / Math.max(0.001, REPLAY.play), 0, 1);
  var u = prog * (span - 1);
  var i0 = REPLAY.from + Math.floor(u);
  var i1 = Math.min(tape.length - 1, i0 + 1);
  var f = u - Math.floor(u);
  var a = tape[i0], b2 = tape[i1];
  if (!a || !b2) return;

  world.ball.x = lerp(a.bx, b2.bx, f);
  world.ball.y = lerp(a.by, b2.by, f);
  world.ball.z = lerp(a.bz, b2.bz, f);
  world.ball.rot = lerp(a.rot, b2.rot, f);

  var all = world.us.concat(world.them);
  for (var k = 0; k < all.length; k++) {
    var p = all[k], o = k * 6;
    if (o + 5 >= a.p.length) break;
    p.x = lerp(a.p[o], b2.p[o], f);
    p.y = lerp(a.p[o + 1], b2.p[o + 1], f);
    p.face = a.p[o + 2];
    p.vx = lerp(a.p[o + 3], b2.p[o + 3], f);
    p.vy = lerp(a.p[o + 4], b2.p[o + 4], f);
    p.anim = lerp(a.p[o + 5], b2.p[o + 5], f);
  }
}

/* The replay camera: low, behind the near post, tracking the ball with a slow
   creep inward. Deliberately a different shot from the live camera — a replay
   from the same angle is not a replay, it is a rewind. */
function replayCamera(world) {
  if (!REPLAY.on) return null;
  var b = world.ball;
  var p = clamp(REPLAY.t / Math.max(0.001, REPLAY.dur), 0, 1);
  var side = REPLAY.angle;
  var rad = 13.5 - p * 3.2;
  return {
    px: side * rad, py: GOAL_Y + 5.5 + p * 2.0, pz: 1.35 + p * 0.5,
    tx: b.x * 0.6, ty: lerp(b.y, GOAL_Y, 0.45), tz: Math.max(0.7, b.z * 0.7 + 0.5)
  };
}

/* the broadcast banner, drawn in screen space over the replay */
function drawReplayBanner() {
  if (!REPLAY.on) return;
  var p = REPLAY.t / Math.max(0.001, REPLAY.dur);
  var a = clamp(Math.min(p / 0.10, (1 - p) / 0.14), 0, 1);
  if (a <= 0.01) return;

  var h = Math.max(22, VP.h * 0.036);
  var y = VP.y + VP.h * 0.115;

  ctx.save();
  /* a slim bar across the frame, dark navy with a blue spine */
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(8,17,31,.82)";
  ctx.fillRect(VP.x, y, VP.w, h);
  ctx.fillStyle = "rgba(0,144,255,.95)";
  ctx.fillRect(VP.x, y, 4, h);

  var fs = h * 0.44;
  ctx.font = "800 " + fs.toFixed(1) + "px " + BODY_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(242,247,252,.96)";
  ctx.fillText("REPLAY", VP.x + 14, y + h / 2);

  /* a live progress rule, so it reads as a broadcast machine and not a label */
  ctx.fillStyle = "rgba(255,194,51,.85)";
  ctx.fillRect(VP.x, y + h - 2, VP.w * clamp(p, 0, 1), 2);

  /* blinking record dot */
  if ((REPLAY.t * 2.2) % 1 < 0.62) {
    ctx.fillStyle = "rgba(255,71,99,.95)";
    ctx.beginPath();
    ctx.arc(VP.x + VP.w - 18, y + h / 2, fs * 0.26, 0, 6.2832);
    ctx.fill();
  }
  ctx.restore();
}

/* THE GUIDED FIRST TOUCH.

   Onboarding used to be seven bullets of text behind a button on the main menu,
   and then level 1 dropped the player straight into a live shot. The whole game
   is one gesture, and the shape of that gesture — that the CURVE of the line
   becomes the curve of the ball — is not discoverable by being told. A player
   who does not work it out reads the game as random.

   So: a ghost hand draws the stroke, on a loop, over the real pitch, until the
   player touches the screen. It is drawn in world space on the grass so it sits
   in the same perspective as the line they are about to draw themselves, which
   is the point — a UI diagram in screen space teaches the wrong thing.

   Runs once, on the first match, and never again. */
var TUTOR = { on: false, t: 0 };

function tutorBegin() { TUTOR.on = true; TUTOR.t = 0; }
function tutorEnd() { TUTOR.on = false; }

function drawTutorGhost(world, dt) {
  if (!TUTOR.on || !world || world.phase !== "aim") return;
  TUTOR.t += dt;

  var b = world.ball;
  var cyc = 2.6;
  var lt = TUTOR.t % cyc;
  /* draw over the first 1.5s, hold, fade out */
  var draw = clamp(lt / 1.5, 0, 1);
  var fade = lt < 1.5 ? 1 : clamp(1 - (lt - 1.5) / 0.7, 0, 1);
  if (fade <= 0.01) return;

  /* a bowed stroke from the ball toward the far corner of the goal — the same
     shape a player would draw to bend one in */
  var pts = [], N = 26;
  var endX = -PITCH.goalHalf * 0.62, endY = GOAL_Y + 1.5;
  for (var i = 0; i <= N; i++) {
    var u = i / N;
    var x = lerp(b.x, endX, u);
    var y = lerp(b.y, endY, u);
    /* bow it sideways, strongest in the middle */
    x += Math.sin(u * Math.PI) * 5.2;
    pts.push({ x: x, y: y });
  }

  var shown = Math.max(2, Math.floor(pts.length * draw));
  ctx.save();
  ctx.lineCap = "round";

  for (i = 1; i < shown; i++) {
    var c0 = toCam({ x: pts[i - 1].x, y: pts[i - 1].y, z: 0.04 });
    var c1 = toCam({ x: pts[i].x, y: pts[i].y, z: 0.04 });
    if (c0.z < NEAR || c1.z < NEAR) continue;
    var s0 = toScreen(c0), s1 = toScreen(c1);
    var t = i / pts.length;
    ctx.strokeStyle = "rgba(120,205,255," + (fade * (0.24 + t * 0.5)).toFixed(3) + ")";
    ctx.lineWidth = Math.max(1.6, 0.11 * s1.k);
    ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();
  }

  /* the ghost fingertip at the head of the stroke */
  var hp = pts[Math.min(shown, pts.length - 1)];
  var hc = toCam({ x: hp.x, y: hp.y, z: 0.05 });
  if (hc.z > NEAR) {
    var hs = toScreen(hc);
    var rr = Math.max(5, 0.30 * hs.k);
    var g = ctx.createRadialGradient(hs.x, hs.y, 0, hs.x, hs.y, rr);
    g.addColorStop(0, "rgba(255,255,255," + (fade * 0.92).toFixed(3) + ")");
    g.addColorStop(0.45, "rgba(140,215,255," + (fade * 0.42).toFixed(3) + ")");
    g.addColorStop(1, "rgba(120,205,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(hs.x, hs.y, rr, 0, 6.2832); ctx.fill();
    /* a ring that pulses out of it, so it reads as a touch */
    var pr = rr * (1 + (lt % 0.8) / 0.8 * 1.5);
    ctx.strokeStyle = "rgba(200,235,255," +
      (fade * 0.34 * (1 - (lt % 0.8) / 0.8)).toFixed(3) + ")";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hs.x, hs.y, pr, 0, 6.2832); ctx.stroke();
  }
  ctx.restore();
}

/* THE POST-MORTEM OVERLAY.

   Drawn over the frozen frame after a failed attempt. Three marks, and each
   answers a question the player was actually asking:

     the flight line   "where did my ball go?"
     the keeper arc    "did they read me, or did I hit it at them?"
     the miss caption  "how close was that?"

   The old build printed a sentence on the result card and nothing else, so a
   player could fail ten times without ever forming a theory about why. A hard
   game is only motivating when the failure is legible.

   Fades in over the second half of the hold before the result card, so it does
   not fight the moment of impact. */
function drawPostMortem(world, dt) {
  var P = world.post;
  if (!P || world.event === "goal") return;

  POST_T += dt;
  var a = clamp((POST_T - 0.30) / 0.45, 0, 1);
  if (a <= 0.01) return;

  ctx.save();

  /* --- the flight, as a tapering line with the ball's own trail colour --- */
  var f = P.flight;
  if (f && f.length > 3) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 1; i < f.length; i++) {
      var c0 = toCam(f[i - 1]), c1 = toCam(f[i]);
      if (c0.z < NEAR || c1.z < NEAR) continue;
      var s0 = toScreen(c0), s1 = toScreen(c1);
      var t = i / f.length;
      ctx.strokeStyle = "rgba(120,205,255," + (a * (0.16 + t * 0.52)).toFixed(3) + ")";
      ctx.lineWidth = Math.max(1, 0.045 * s1.k * (0.5 + t));
      ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();
    }
    /* a marker where it finished */
    var ce = toCam(P.ball);
    if (ce.z > NEAR) {
      var se = toScreen(ce);
      var rr = Math.max(3, 0.16 * se.k);
      ctx.strokeStyle = "rgba(255,71,99," + (a * 0.9).toFixed(3) + ")";
      ctx.lineWidth = Math.max(1.4, rr * 0.22);
      ctx.beginPath(); ctx.arc(se.x, se.y, rr, 0, 6.2832); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(se.x - rr * 0.55, se.y - rr * 0.55);
      ctx.lineTo(se.x + rr * 0.55, se.y + rr * 0.55);
      ctx.moveTo(se.x + rr * 0.55, se.y - rr * 0.55);
      ctx.lineTo(se.x - rr * 0.55, se.y + rr * 0.55);
      ctx.stroke();
    }
  }

  /* --- the keeper's committed direction, as an arc on the goal line --- */
  if (P.gk && P.gk.dive > 0.05) {
    var gx = P.gk.x, gy = P.gk.y;
    var reach = 1.7 * P.gk.dir;
    var pts = [], n = 12;
    for (var k = 0; k <= n; k++) {
      var u = k / n;
      var c = toCam({ x: gx + reach * u, y: gy, z: 0.35 + Math.sin(u * Math.PI) * 0.8 });
      if (c.z < NEAR) { pts = null; break; }
      pts.push(toScreen(c));
    }
    if (pts) {
      ctx.strokeStyle = "rgba(255,194,51," + (a * 0.68).toFixed(3) + ")";
      ctx.lineWidth = 2.2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* --- how close, in plain numbers, pinned to the goal --- */
  var cap = null;
  if (P.ev === "wide") {
    if (P.overBy > 0) cap = (P.overBy * 100).toFixed(0) + " CM OVER";
    else if (P.wideBy > 0) cap = (P.wideBy * 100).toFixed(0) + " CM WIDE";
  } else if (P.ev === "save") {
    cap = P.gk && P.gk.dive > 0.4 ? "KEEPER READ IT" : "STRAIGHT AT THEM";
  } else if (P.ev === "blocked") {
    cap = "BLOCKED ON THE WAY";
  }
  if (cap) {
    var cc = toCam({ x: 0, y: GOAL_Y - 0.4, z: PITCH.crossbar + 1.15 });
    if (cc.z > NEAR) {
      var cs = toScreen(cc);
      var fs = clamp(0.42 * cs.k, 11, 26);
      ctx.font = "800 " + fs.toFixed(1) + "px " + BODY_FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      var w = ctx.measureText(cap).width;
      ctx.fillStyle = "rgba(5,11,22," + (a * 0.80).toFixed(3) + ")";
      roundRectPath(cs.x - w / 2 - fs * 0.5, cs.y - fs * 0.78,
                    w + fs, fs * 1.56, fs * 0.34);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255," + (a * 0.16).toFixed(3) + ")";
      ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "rgba(242,247,252," + a.toFixed(3) + ")";
      ctx.fillText(cap, cs.x, cs.y);
    }
  }
  ctx.restore();
}

var POST_T = 0;
function resetPostMortem() { POST_T = 0; }

var BODY_FONT = '"Bahnschrift SemiCondensed","Roboto Condensed",system-ui,sans-serif';

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ------------------------------------------------------------ full frame */

/* The camera's focal length for this frame only. FEEL's zoom punch multiplies
   it, which is a real lens change — scaling the finished bitmap instead would
   soften every edge and read as a cheap zoom. */
var F_BASE = 0;

function renderWorld(world, drag, dt) {
  dt = dt || 0;
  /* playback writes the taped frame onto the live objects before anything is
     drawn, so the entire renderer sees the replayed state */
  replayStep(world, dt);
  CROWD_T += dt;
  CROWD_SURGE = Math.max(0, CROWD_SURGE - dt * 1.6);
  if (NET.t > 0) NET.t = Math.max(0, NET.t - dt * 1.15);
  fxStep(dt);
  ringStep(dt);

  /* apply the punch to the lens, then put it back at the end of the frame so
     it never accumulates */
  if (!F_BASE) F_BASE = Cam.F;
  var zm = (typeof FEEL !== "undefined") ? FEEL.zoomMul() : 1;
  /* the cinematic push is a second, slower lens move layered on the punch */
  if (typeof FEEL !== "undefined" && FEEL.cinePush) zm *= 1 + FEEL.cinePush();
  var fSaved = Cam.F;
  Cam.F = fSaved * zm;

  ctx.save();
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, cvs.width / DPR, cvs.height / DPR);

  /* Clip to the play area FIRST, then shake inside it. Shaking before clipping
     rotates the clip region itself, which walks the visible frame off the
     drawn area and shows bare canvas in the corners. The window has to stay
     still; only the picture inside it moves. */
  ctx.save();
  ctx.beginPath(); ctx.rect(VP.x, VP.y, VP.w, VP.h); ctx.clip();

  var sh = (typeof FEEL !== "undefined") ? FEEL.shakeOffset() : { x: 0, y: 0, rot: 0 };
  if (sh.x || sh.y || sh.rot) {
    ctx.translate(VP.x + VP.w / 2, VP.y + VP.h / 2);
    ctx.rotate(sh.rot);
    ctx.translate(-(VP.x + VP.w / 2), -(VP.y + VP.h / 2));
    ctx.translate(sh.x, sh.y);
  }

  drawSky();

  /* stands first — they are the furthest thing away */
  drawStadium();
  drawDepthHaze();

  drawPitch(world);
  drawFloodPools();
  drawSplashes(dt);
  drawGrain();

  /* the far goal, then the actors, then the near goal, so depth reads right */
  drawRings();

  drawGoal(GOAL_Y, 1);
  drawGoal(OWN_GOAL_Y, -1);
  drawCornerFlags();

  if (world.phase === "aim") { drawAim(drag, world); drawTutorGhost(world, dt); }

  /* painter's algorithm over players AND the ball, so a ball in front of a
     player is not painted onto his chest */
  var all = world.us.concat(world.them).map(function (p) {
    return { d: toCam(p).z, draw: function () {
      drawPlayer(p, p === world.carrier && world.phase === "aim", world.ball, dt, world);
    } };
  });
  all.push({ d: toCam(world.ball).z, draw: function () { drawBall(world.ball); } });
  all.sort(function (a, b) { return b.d - a.d; });
  for (var i = 0; i < all.length; i++) all[i].draw();
  /* soft floodlight falloff — stops the turf reading as one flat fill */
  var vg = ctx.createRadialGradient(VP.x + VP.w * 0.5, VP.y + VP.h * 0.52, VP.w * 0.18,
                                    VP.x + VP.w * 0.5, VP.y + VP.h * 0.52, VP.w * 1.25);
  vg.addColorStop(0, "rgba(255,255,240,.055)");
  vg.addColorStop(0.55, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,10,5,.32)");
  ctx.fillStyle = vg;
  ctx.fillRect(VP.x, VP.y, VP.w, VP.h);

  drawFX();
  drawPostMortem(world, dt);
  drawGrade();
  drawReplayBanner();
  drawSpeedlines(world);
  drawRain(dt);
  drawOffscreen(world);

  ctx.restore();
  ctx.restore();

  Cam.F = fSaved;
  syncPostDOM();
}

/* Radial streaks from the frame centre while the ball is travelling fast.
   Drawn in screen space on purpose — this is a camera artefact, not something
   in the world, and it is what gives a struck ball its sense of pace. */
function drawSpeedlines(world) {
  if (typeof FEEL === "undefined") return;
  var s = FEEL.speedlines();
  if (s <= 0.02) return;
  var cx = VP.x + VP.w / 2, cy = VP.y + VP.h * 0.52;
  var n = 26;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (var i = 0; i < n; i++) {
    var a = (i / n) * 6.2832 + CROWD_T * 0.5;
    var r0 = VP.w * (0.42 + (i % 3) * 0.06);
    var len = VP.w * (0.10 + 0.22 * s) * (0.6 + (i % 5) / 7);
    var x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0 * 1.5;
    var x1 = cx + Math.cos(a) * (r0 + len), y1 = cy + Math.sin(a) * (r0 + len) * 1.5;
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(235,245,255," + (0.16 * s).toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6 + s * 2.2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}

/* COLOUR GRADE.

   One pass over the finished frame that puts everything — turf, players,
   stands, crowd, ball — into the same light. Grading the turf alone produced
   the giveaway that made night matches look broken: a black pitch with
   daylit players on it.

   Two operations, in this order:
     multiply   drops exposure and pushes colour temperature
     screen     adds the floodlights back as a broad warm wash over the pitch

   A floodlit ground is not dark. It is dimmer and cooler than an afternoon in
   the shadows, and much brighter than it in the lit centre — which is exactly
   what a multiply followed by a centred screen gives you. */
function drawGrade() {
  var C = cond();
  if (C.light >= 0.999 && C.flood <= 0.10) return;      // bright day, nothing to do

  var x0 = VP.x - OVER, y0 = VP.y - OVER;
  var w = VP.w + OVER * 2, h = VP.h + OVER * 2;

  /* exposure and temperature. Warm conditions keep red, cool ones keep blue. */
  var e = C.light;
  var wr = e * (1 + (C.warm - 0.5) * 0.20);
  var wg = e * (1 + (C.warm - 0.5) * 0.04);
  var wb = e * (1 - (C.warm - 0.5) * 0.26);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "rgb(" + clamp(Math.round(wr * 255), 0, 255) + "," +
                            clamp(Math.round(wg * 255), 0, 255) + "," +
                            clamp(Math.round(wb * 255), 0, 255) + ")";
  ctx.fillRect(x0, y0, w, h);
  ctx.restore();

  /* the floodlights putting light back into the middle of the pitch */
  if (C.flood > 0.12) {
    var cx = VP.x + VP.w * 0.5, cy = VP.y + VP.h * 0.58;
    var g = ctx.createRadialGradient(cx, cy, VP.w * 0.05, cx, cy, VP.w * 1.60);
    var a = C.flood * 0.26;
    g.addColorStop(0.00, "rgba(255,248,226," + a.toFixed(3) + ")");
    g.addColorStop(0.45, "rgba(240,246,255," + (a * 0.45).toFixed(3) + ")");
    g.addColorStop(1.00, "rgba(220,236,255,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, h);
    ctx.restore();
  }
}

/* The vignette is a DOM layer rather than a canvas fill so it composites on the
   GPU and costs nothing per frame. Driven from here to keep it in step. */
var _vigEl = null;
function syncPostDOM() {
  if (typeof FEEL === "undefined") return;
  if (!_vigEl) _vigEl = document.getElementById("vignette");
  if (_vigEl) _vigEl.style.opacity = FEEL.vignette().toFixed(3);
}
