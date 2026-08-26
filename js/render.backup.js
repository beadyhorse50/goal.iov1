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
  grass1: "#51c069", grass2: "#3b9950",
  grass1Lit: "#5fd177", grass2Lit: "#47ab5d",       // vivid, clearly striped turf
  line: "rgba(255,255,255,.95)",
  us: "#fbfdff", usAlt: "#e0344a", usSock: "#e0344a",   // white shirt, red shorts
  them: "#5566d8", themAlt: "#2b3492", themSock: "#2b3492",
  gk: "#25b596", gkAlt: "#12705c", gkSock: "#12705c",
  skin: "#d59b70", hair: "#39291d", boot: "#212429",
  skins: ["#f0c9a4", "#dda87c", "#c08a5c", "#96613c", "#6d4227"],
  hairs: ["#2a1d14", "#4a3220", "#1b1512", "#6b4a28", "#2f2320"]
};

/* a warm, mixed crowd rather than a field of green dots */
var CROWD_COLS = [
  "#d9ab80", "#f3ece1", "#c33b2e", "#8d5b3b", "#e7e0d3", "#6d4831",
  "#3a4170", "#d2603a", "#f5f5f5", "#a43c3c", "#e8c98a", "#4d4f57"
];

/* fixed key light, used for lambert shading and for shadow offset direction */
var LIGHT = (function () { var m = Math.hypot(-0.32, 0.42, 0.85); return { x: -0.32 / m, y: 0.42 / m, z: 0.85 / m }; })();

function initRender() {
  cvs = document.getElementById("game");
  ctx = cvs.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () { setTimeout(resize, 250); });
}

function checkResize() {
  var w = window.innerWidth || document.documentElement.clientWidth;
  var h = window.innerHeight || document.documentElement.clientHeight;
  if (w !== Cam.lastW || h !== Cam.lastH) resize();
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
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
  if (world.phase === "over" && world.event === "goal") CAM_GOAL_T += dt || 0;
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
  var dB = Math.sin(CAM_T * 0.17 + 1.3) * 0.34;
  wantPx += side.x * dA; wantPy += side.y * dA;
  wantPz += dB * 0.5;
  wantTx += side.x * dA * 0.25; wantTy += side.y * dA * 0.25;

  /* The goal hands over to a replay orbit. Snapping the target there lurches,
     because the orbit start is metres from wherever play left the camera — so
     blend the two wants over ~0.9s instead of cutting. */
  if (world.phase === "over" && world.event === "goal") {
    var gt = CAM_GOAL_T;
    var ang = -0.55 + gt * 0.40;
    var rad = 15.0 + Math.min(1, gt / 2.4) * 8.5;
    var hgt = 3.4 + Math.min(1, gt / 2.0) * 4.0;
    var oPx = Math.sin(ang) * rad + b.x * 0.25;
    var oPy = GOAL_Y + Math.cos(ang) * rad;
    var oPz = hgt;
    var oTx = b.x * 0.30, oTy = GOAL_Y - 0.6, oTz = 1.25;

    var u = clamp(gt / 0.9, 0, 1);
    u = u * u * (3 - 2 * u);                       // smoothstep, zero slope at 0
    wantPx = lerp(wantPx, oPx, u); wantPy = lerp(wantPy, oPy, u);
    wantPz = lerp(wantPz, oPz, u);
    wantTx = lerp(wantTx, oTx, u); wantTy = lerp(wantTy, oTy, u);
    wantTz = lerp(wantTz, oTz, u);
  }

  /* keep the camera inside the ground */
  wantPx = clamp(wantPx, -42, 42);
  wantPy = clamp(wantPy, GOAL_Y - 6, PITCH.halfL + 26);

  var k = instant ? 1 : 1 - Math.pow(0.02, dt);
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
function drawSky() {
  var g = ctx.createLinearGradient(0, VP.y, 0, VP.y + VP.h * 0.6);
  g.addColorStop(0, "#8fc3e6");
  g.addColorStop(1, "#d7ecf7");
  ctx.fillStyle = g;
  ctx.fillRect(VP.x, VP.y, VP.w, VP.h);
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
function crowdData() {
  if (CROWD) return CROWD;
  CROWD = [];
  for (var i = 0; i < 5200; i++) CROWD.push([Math.random(), Math.random(), Math.random()]);
  return CROWD;
}

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

/* a,b = near edge (ground); c,d = far edge (raised to `height`) */
function drawStand(a, b, c, d, height, density, seed, hA, hB) {
  var i, t, u;
  var nearMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
  if (toCam(nearMid).z < -20) return;

  /* concrete rake */
  poly3([{ x: a.x, y: a.y, z: 0 }, { x: b.x, y: b.y, z: 0 },
         { x: d.x, y: d.y, z: height }, { x: c.x, y: c.y, z: height }], "#4d525b");

  /* tier steps */
  for (i = 1; i < 8; i++) {
    t = i / 8;
    line3({ x: lerp(a.x, c.x, t), y: lerp(a.y, c.y, t), z: height * t },
          { x: lerp(b.x, d.x, t), y: lerp(b.y, d.y, t), z: height * t },
          "rgba(0,0,0,.22)", 2);
  }

  /* the crowd — each person bobs on their own phase so the bank shimmers
     instead of sitting frozen, and a few camera flashes pop each second */
  var pts = crowdData(), n = Math.floor(pts.length * (density || 1));
  var T = CROWD_T, surge = CROWD_SURGE;
  for (i = 0; i < n; i++) {
    u = pts[i][0]; t = pts[i][1];
    var wx = lerp(lerp(a.x, b.x, u), lerp(c.x, d.x, u), t);
    var wy = lerp(lerp(a.y, b.y, u), lerp(c.y, d.y, u), t);
    var ph = pts[i][2] * 6.2832;
    var bob = Math.sin(T * 2.1 + ph) * 0.055 + surge * (0.34 + 0.30 * Math.sin(T * 9 + ph));
    var wz = height * t + 0.55 + bob;
    var cam = toCam({ x: wx, y: wy, z: wz });
    if (cam.z < NEAR) continue;
    var sp = toScreen(cam);
    if (sp.x < VP.x - 6 || sp.x > VP.x + VP.w + 6 || sp.y < VP.y - 6 || sp.y > VP.y + VP.h + 6) continue;
    var ww = Math.max(1, 0.24 * sp.k), hh = Math.max(1, 0.34 * sp.k);
    var flash = ((((i * 2654435761) ^ ((T * 2.5) | 0)) >>> 0) % 1600) < 3;
    if (flash) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fffef0";
      ctx.fillRect(sp.x - ww * 0.7, sp.y - hh * 1.3, ww * 1.4, hh * 1.3);
    } else {
      ctx.fillStyle = CROWD_COLS[(i * 7) % CROWD_COLS.length];
      ctx.globalAlpha = 0.55 + pts[i][2] * 0.45;
      ctx.fillRect(sp.x - ww / 2, sp.y - hh, ww, hh);
    }
  }
  ctx.globalAlpha = 1;

  /* a few banners draped over the tiers */
  for (i = 0; i < 7; i++) {
    var bu = ((i * 137) % 100) / 100, bt = 0.25 + ((i * 61) % 55) / 100 * 0.6;
    var bw = 0.035;
    var p0 = { x: lerp(lerp(a.x, b.x, bu), lerp(c.x, d.x, bu), bt),
               y: lerp(lerp(a.y, b.y, bu), lerp(c.y, d.y, bu), bt), z: height * bt + 0.5 };
    var p1 = { x: lerp(lerp(a.x, b.x, bu + bw), lerp(c.x, d.x, bu + bw), bt),
               y: lerp(lerp(a.y, b.y, bu + bw), lerp(c.y, d.y, bu + bw), bt), z: height * bt + 0.5 };
    var bh = 0.8;
    poly3([p0, p1, { x: p1.x, y: p1.y, z: p1.z + bh }, { x: p0.x, y: p0.y, z: p0.z + bh }],
          ["#e8e2d6", "#c9342c", "#1f3f8a", "#f0c53a"][i % 4]);
    poly3([{ x: p0.x, y: p0.y, z: p0.z + bh * 0.42 }, { x: p1.x, y: p1.y, z: p1.z + bh * 0.42 },
           { x: p1.x, y: p1.y, z: p1.z + bh * 0.60 }, { x: p0.x, y: p0.y, z: p0.z + bh * 0.60 }],
          ["#c9342c", "#e8e2d6", "#e8e2d6", "#1f3f8a"][i % 4]);
  }

  /* roof */
  var rz = height + 2.2;
  poly3([{ x: c.x, y: c.y, z: height }, { x: d.x, y: d.y, z: height },
         { x: d.x, y: d.y, z: rz }, { x: c.x, y: c.y, z: rz }], "#2c333c");
  poly3([{ x: c.x, y: c.y, z: rz }, { x: d.x, y: d.y, z: rz },
         { x: d.x, y: d.y, z: rz + 0.35 }, { x: c.x, y: c.y, z: rz + 0.35 }], "#171c22");

  hoardings(hA || a, hB || b, seed || 0);
}

function drawStadium() {
  var XW = PITCH.halfW + SURROUND, YE = SURROUND, DEP = 26, H = 14;
  drawStand({ x: -XW, y: GOAL_Y - YE }, { x: XW, y: GOAL_Y - YE },
            { x: -XW, y: GOAL_Y - YE - DEP }, { x: XW, y: GOAL_Y - YE - DEP }, H, 1, 0);
  drawStand({ x: XW, y: OWN_GOAL_Y + YE }, { x: -XW, y: OWN_GOAL_Y + YE },
            { x: XW, y: OWN_GOAL_Y + YE + DEP }, { x: -XW, y: OWN_GOAL_Y + YE + DEP }, H, 0.35, 2);
  /* the side stands run past both ends so the four corners meet instead of
     leaving a wedge of sky */
  var YS = OWN_GOAL_Y + YE + DEP, YN = GOAL_Y - YE - DEP;
  /* the side stands run past both ends so the corners meet, but their boards
     only run alongside the pitch — otherwise they hang in mid-air behind the
     goal-end stand */
  drawStand({ x: -XW, y: YS }, { x: -XW, y: YN },
            { x: -XW - DEP, y: YS }, { x: -XW - DEP, y: YN }, H, 0.6, 1,
            { x: -XW, y: OWN_GOAL_Y + YE }, { x: -XW, y: GOAL_Y - YE });
  drawStand({ x: XW, y: YN }, { x: XW, y: YS },
            { x: XW + DEP, y: YN }, { x: XW + DEP, y: YS }, H, 0.6, 3,
            { x: XW, y: GOAL_Y - YE }, { x: XW, y: OWN_GOAL_Y + YE });
}

function drawPitch(world) {
  /* grass base — one big quad covering the playing surface and its surround */
  var gx = PITCH.halfW + SURROUND, gy = PITCH.halfL + SURROUND;
  poly3([{ x: -gx, y: gy, z: 0 }, { x: gx, y: gy, z: 0 },
         { x: gx, y: -gy, z: 0 }, { x: -gx, y: -gy, z: 0 }],
        "#2c7a43");

  /* mown stripes across the pitch */
  var band = 7, y, i;
  for (i = 0; i < 2; i++) {
    var col = i ? COL.grass2 : COL.grass1;
    var lit = i ? COL.grass2Lit : COL.grass1Lit;
    for (y = -PITCH.halfL + i * band; y < PITCH.halfL; y += band * 2) {
      var y1 = Math.min(y + band, PITCH.halfL);
      var quad = [{ x: -PITCH.halfW, y: y, z: 0 }, { x: PITCH.halfW, y: y, z: 0 },
                  { x: PITCH.halfW, y: y1, z: 0 }, { x: -PITCH.halfW, y: y1, z: 0 }];
      /* sheen across the band: mown grass catches light on one side */
      var a = toCam({ x: 0, y: y, z: 0 }), b = toCam({ x: 0, y: y1, z: 0 });
      if (a.z > NEAR && b.z > NEAR) {
        var sa = toScreen(a), sb = toScreen(b);
        var g = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
        g.addColorStop(0, lit);
        g.addColorStop(0.55, col);
        g.addColorStop(1, col);
        poly3(quad, g);
      } else {
        poly3(quad, col);
      }
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

  var netFill = "rgba(244,251,255,.46)";
  var cord = "rgba(255,255,255,.85)";

  /* back panel */
  poly3([{ x: -post - flare, y: backY, z: 0 }, { x: post + flare, y: backY, z: 0 },
         { x: post + flare, y: backY, z: bar * 0.92 }, { x: -post - flare, y: backY, z: bar * 0.92 }],
        netFill);
  /* roof */
  poly3([{ x: -post, y: baseY, z: bar }, { x: post, y: baseY, z: bar },
         { x: post + flare, y: backY, z: bar * 0.92 }, { x: -post - flare, y: backY, z: bar * 0.92 }],
        netFill);
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
          { x: nx, y: backY + d1, z: bar * 0.92 }, cord, 1);
    line3({ x: lerp(-post, post, t), y: baseY, z: bar },
          { x: lerp(-post - flare, post + flare, t), y: backY, z: bar * 0.92 }, cord, 1);
  }
  for (i = 0; i <= 8; i++) {
    t = i / 8;
    var cz = bar * 0.92 * t;
    var e0 = dir > 0 ? -netOffset(-post, cz) : 0;
    var e1 = dir > 0 ? -netOffset(post, cz) : 0;
    line3({ x: -post - flare, y: backY + e0, z: cz },
          { x: post + flare, y: backY + e1, z: cz }, cord, 1);
  }
  for (i = 1; i <= 3; i++) {
    t = i / 4;
    line3({ x: lerp(-post, -post - flare, t), y: lerp(baseY, backY, t), z: lerp(bar, bar * 0.92, t) },
          { x: lerp(-post, -post - flare, t), y: lerp(baseY, backY, t), z: 0 }, cord, 1);
    line3({ x: lerp(post, post + flare, t), y: lerp(baseY, backY, t), z: lerp(bar, bar * 0.92, t) },
          { x: lerp(post, post + flare, t), y: lerp(baseY, backY, t), z: 0 }, cord, 1);
  }

  /* the frame — solid posts and bar with real thickness */
  var tk = 0.11;
  function bar3(ax, ay, az, bx, by, bz) {
    poly3([{ x: ax - tk, y: ay, z: az }, { x: bx - tk, y: by, z: bz },
           { x: bx + tk, y: by, z: bz }, { x: ax + tk, y: ay, z: az }], "#ffffff");
  }
  bar3(-post, baseY, 0, -post, baseY, bar);
  bar3(post, baseY, 0, post, baseY, bar);
  poly3([{ x: -post - tk, y: baseY, z: bar + tk }, { x: post + tk, y: baseY, z: bar + tk },
         { x: post + tk, y: baseY, z: bar - tk }, { x: -post - tk, y: baseY, z: bar - tk }],
        "#ffffff");
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
  var n = parseInt(hex.slice(1), 16);
  var r = clamp(Math.round(((n >> 16) & 255) * f), 0, 255);
  var g = clamp(Math.round(((n >> 8) & 255) * f), 0, 255);
  var b = clamp(Math.round((n & 255) * f), 0, 255);
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
function drawFace(centre, hd, r, hpx) {
  if (hpx < 46) return;
  var toEye = unit3({ x: Cam.px - centre.x, y: Cam.py - centre.y, z: Cam.pz - centre.z });
  var facing = dot3(hd.F, toEye);
  if (facing < 0.25) return;
  var cam = toCam(centre);
  if (cam.z < NEAR) return;
  var sp = toScreen(cam);
  var rp = r * sp.k;
  if (rp < 5) return;

  /* screen directions of the head's own right and up axes */
  function dirOf(ax) {
    var a = toScreen(toCam({ x: centre.x + ax.x * r, y: centre.y + ax.y * r, z: centre.z + ax.z * r }));
    var dx = a.x - sp.x, dy = a.y - sp.y, m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  }
  var rr = dirOf(hd.R), uu = dirOf(hd.U);
  var eyeR = Math.max(0.9, rp * 0.115);
  var off = rp * 0.34, up2 = rp * 0.12;
  var fade = clamp((facing - 0.25) / 0.3, 0, 1);
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.fillStyle = "#241b14";
  [-1, 1].forEach(function (sgn) {
    var ex = sp.x + rr.x * off * sgn + uu.x * up2;
    var ey = sp.y + rr.y * off * sgn + uu.y * up2;
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeR, eyeR * 1.25, 0, 0, 6.2832);
    ctx.fill();
  });
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
  if (p.role === "gk" && p.dive > 0.02) return "dive";
  if (p.kickT > 0) return p.kickIsPass ? "pass" : "strike";
  if (world && world.phase === "over" && world.event === "goal" && p.team === "us") return "celebrate";
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

function drawRigShadow(J, s, alpha) {
  if (!ctx.roundRect && typeof Path2D === "undefined") return;
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
  ctx.fillStyle = "rgba(12,34,20," + alpha.toFixed(3) + ")";
  ctx.filter = "blur(2px)";
  ctx.fill(path);
  ctx.filter = "none";
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
  var sleeve = p.role === "gk" ? COL.gk : (p.team === "us" ? COL.usAlt : COL.them);
  var skin = COL.skins[seed % COL.skins.length];
  var hair = COL.hairs[(seed * 3) % COL.hairs.length];

  /* ---- animation state lives on the player, driven from game state ---- */
  if (!p._an) { p._an = new Animator(); p._rig = {}; p._an.cur = pickClip(p, world); }
  var an = p._an;
  var want = pickClip(p, world);
  an.play(want, false);
  /* step always — this is what advances the crossfade. The run cycle then has
     its clock overridden by stride phase so the feet do not skate. */
  an.step(dt || 0);
  if (an.cur === "run") an.t = p.anim * 0.115;
  if (an.prev === "run") an.prevT = p.anim * 0.115;
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
  var bob = Math.abs(Math.sin(p.anim * 1.1)) * run * 0.045;

  /* the rig's own pelvis offset does the 0.92m lift — root is the ground point */
  var root = { x: p.x + U.x * bob, y: p.y + U.y * bob, z: lift + U.z * bob };

  var J = solveRig(pose, root, R, F, U, p._rig);

  drawShadow(p.x, p.y, 0.30, lift * 2, 0.55);   // tight contact darkening
  drawRigShadow(J, 1.0, 0.34);
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
    prism(bo, an2.R, an2.F, an2.U, 0.072, 0.126, -0.02, 0.050, 0.86, 1.0, COL.boot, 8, false, false);
    SMOOTH = wasSmooth; BIAS = 0;
    /* caps at the joints — without these a sharply bent knee opens a wedge */
    sphere(kn.o, 0.075, skin, null, null);
    BIAS = 0.012; sphere(hip.o, 0.092, alt, null, null); BIAS = 0;
  });

  /* ---- pelvis / torso ---- */
  var pel = J.pelvis, ch = J.chest;
  BIAS = 0.022;
  prism(pel.o, pel.R, pel.F, pel.U, 0.178, 0.128, -0.25, 0.17, 1.16, 1.02, alt, SD, false, true);
  var TOR = boneLen("chest") + boneLen("spine");
  prism(J.spine.o, J.spine.R, J.spine.F, J.spine.U, 0.166, 0.108, -0.05, TOR, 1.00, 1.34, kit, SD, true, false);

  prism(J.spine.o, J.spine.R, J.spine.F, J.spine.U, 0.166, 0.108, TOR - 0.03, TOR, 1.33, 1.35, alt, SD, true, false);
  BIAS = 0;

  /* ---- arms ---- */
  var UA = boneLen("elL"), FA = boneLen("haL");
  [["shL", "elL", "haL"], ["shR", "elR", "haR"]].forEach(function (t) {
    var sh = J[t[0]], el = J[t[1]], ha = J[t[2]];
    BIAS = 0;
    limb(el, 0.053, 0.056, -UA * 0.16, FA, 1.02, 0.86, skin, SD);    // forearm
    sphere(el.o, 0.055, skin, null, null);                           // elbow cap
    BIAS = 0.012;
    limb(sh, 0.066, 0.069, 0.0, UA * 0.86, 1.06, 0.92, sleeve, SD);  // sleeve
    limb(sh, 0.064, 0.067, UA * 0.80, UA * 0.90, 0.94, 0.90, alt, SD); // cuff
    sphere(sh.o, 0.070, sleeve, null, null);                          // shoulder cap
    BIAS = 0;
    sphere(ha.o, 0.057, p.role === "gk" ? "#f2f4f7" : skin, null, null);
  });

  /* ---- neck and head ---- */
  prism(J.neck.o, J.neck.R, J.neck.F, J.neck.U, 0.068, 0.066,
        -0.06, boneLen("head") + 0.01, 1.05, 0.86, skin, SD, false, false);
  var hd = J.head;
  var up = screenUp(hd.o, hd.U);
  var hc = { x: hd.o.x + hd.U.x * 0.068, y: hd.o.y + hd.U.y * 0.068, z: hd.o.z + hd.U.z * 0.068 };
  sphere(hc, 0.127, skin, hair, up);

  flushFaceBuf();
  /* after the flush — the head sphere is queued, and would paint over these */
  drawFace(hc, hd, 0.127, hpx);

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
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.num, sp3.x, sp3.y);
        ctx.restore();
      }
    }
  }

  if (isCarrier) {
    var sc = scaleAt({ x: p.x, y: p.y, z: 0 });
    var g2 = toScreen(foot);
    ctx.save();
    ctx.strokeStyle = "rgba(61,255,158,.95)";
    ctx.lineWidth = Math.max(1.6, 0.08 * sc);
    ctx.beginPath();
    ctx.ellipse(g2.x, g2.y, 0.95 * sc, 0.95 * sc * 0.42, 0, 0, 6.2832);
    ctx.stroke();
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
  drawShadow(b.x, b.y, 0.26 + b.z * 0.012, b.z, 0.62);

  var cam = toCam({ x: b.x, y: b.y, z: b.z + 0.12 });
  if (cam.z < NEAR) return;
  var sp = toScreen(cam);
  var r = Math.max(2.2, 0.145 * sp.k);

  /* motion trail */
  if (b.trail.length > 2) {
    ctx.save();
    ctx.lineCap = "round";
    for (var i = 1; i < b.trail.length; i++) {
      var t0 = b.trail[i - 1], t1 = b.trail[i];
      var c0 = toCam({ x: t0.x, y: t0.y, z: t0.z + 0.12 });
      var c1 = toCam({ x: t1.x, y: t1.y, z: t1.z + 0.12 });
      if (c0.z < NEAR || c1.z < NEAR) continue;
      var a = i / b.trail.length;
      var p0 = toScreen(c0), p1 = toScreen(c1);
      ctx.strokeStyle = "rgba(255,255,255," + (a * 0.16).toFixed(3) + ")";
      ctx.lineWidth = clamp(0.14 * p1.k * a * 1.5, 1, 10);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
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
      grav: opts.grav === undefined ? 7.5 : opts.grav
    });
  }
}

function fxStep(dt) {
  for (var i = FX.length - 1; i >= 0; i--) {
    var f = FX[i];
    f.life += dt;
    if (f.life >= f.max) { FX.splice(i, 1); continue; }
    f.vz -= f.grav * dt;
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (f.z < 0) { f.z = 0; f.vz *= -0.35; f.vx *= 0.7; f.vy *= 0.7; }
  }
}

function drawFX() {
  for (var i = 0; i < FX.length; i++) {
    var f = FX[i];
    var c = toCam({ x: f.x, y: f.y, z: f.z });
    if (c.z < NEAR) continue;
    var sp = toScreen(c);
    var t = 1 - f.life / f.max;
    var rr = Math.max(0.6, f.r * sp.k * (0.5 + t * 0.9));
    ctx.fillStyle = "rgba(" + f.col + "," + (t * 0.85).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, rr, 0, 6.2832);
    ctx.fill();
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

/* ------------------------------------------------------------ full frame */
function renderWorld(world, drag, dt) {
  dt = dt || 0;
  CROWD_T += dt;
  CROWD_SURGE = Math.max(0, CROWD_SURGE - dt * 1.6);
  if (NET.t > 0) NET.t = Math.max(0, NET.t - dt * 1.15);
  fxStep(dt);

  ctx.save();
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, cvs.width / DPR, cvs.height / DPR);

  var shake = world.shakeT > 0 ? world.shakeT * 22 : 0;
  if (shake > 0) ctx.translate(rnd(-shake, shake), rnd(-shake, shake));

  ctx.save();
  ctx.beginPath(); ctx.rect(VP.x, VP.y, VP.w, VP.h); ctx.clip();

  drawSky();

  /* stands first — they are the furthest thing away */
  drawStadium();

  drawPitch(world);
  drawFloodPools();
  drawGrain();

  /* the far goal, then the actors, then the near goal, so depth reads right */
  drawGoal(GOAL_Y, 1);
  drawGoal(OWN_GOAL_Y, -1);
  drawCornerFlags();

  if (world.phase === "aim") drawAim(drag, world);

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
  drawOffscreen(world);

  ctx.restore();
  ctx.restore();
}
