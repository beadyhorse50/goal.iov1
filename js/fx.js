/* goal.io — the feel layer.

   Everything in this file exists to make an action land. It owns three things
   that used to be scattered or missing:

   1. TIME. One director decides how fast the world runs. Hit-stop, the goal
      slow-motion ramp and normal play all come from timeScale(), so they can
      never fight each other. The old build stepped straight to 0.3x on a goal;
      a hard step reads as a stutter, an eased ramp reads as drama.

   2. CAMERA IMPACT. Trauma-based shake — store a single trauma value, shake by
      its square, decay it. Squaring is the trick: it makes a big hit feel
      violent and a small one feel like nothing, where linear shake makes
      everything feel the same. Plus a zoom punch on the same trauma.

   3. CUES. sim.js reports what happened (a bounce, a post, a net) with no idea
      what it sounds or looks like. This drains that queue and turns each one
      into sound, particles, shake and text.

   Nothing here is allowed to write to the simulation. If a function in this
   file needs to change the ball, it is in the wrong file.
*/
"use strict";

var FEEL = (function () {

  /* ------------------------------------------------------------------ time */

  var hitstopT = 0;          // hard freeze, seconds remaining
  var slowT = 0, slowDur = 0, slowDepth = 1;
  var lastScale = 1;

  /* A freeze on contact. 60–90 ms is the window: shorter is invisible, longer
     reads as a dropped frame. The renderer keeps drawing through it, so the
     frame the player is staring at is the frame of impact. */
  function hitstop(secs) {
    hitstopT = Math.max(hitstopT, secs);
  }

  /* Eased slow-motion. depth 0.25 means quarter speed at the deepest point. */
  function slowmo(secs, depth) {
    slowT = secs; slowDur = secs; slowDepth = depth == null ? 0.3 : depth;
  }

  function timeScale() { return lastScale; }

  function stepTime(dt) {
    if (hitstopT > 0) { hitstopT -= dt; lastScale = 0; return 0; }
    if (slowT > 0) {
      slowT -= dt;
      var p = 1 - slowT / slowDur;                 // 0 at start, 1 at end
      /* in fast, hold, out slow — the shape of every replay you have seen */
      var k = p < 0.12 ? p / 0.12
            : p > 0.62 ? 1 - (p - 0.62) / 0.38
            : 1;
      k = k * k * (3 - 2 * k);                     // smoothstep the ramp itself
      lastScale = 1 + (slowDepth - 1) * k;
      return lastScale;
    }
    lastScale = 1;
    return 1;
  }

  /* ---------------------------------------------------------------- camera */

  var trauma = 0;            // 0..1
  var shakeSeed = Math.random() * 1000;
  var zoomT = 0, zoomAmt = 0, zoomDur = 0.36;
  var rollT = 0, rollAmt = 0;

  function shake(amount) { trauma = Math.min(1, trauma + amount); }

  function zoom(amount, dur) {
    zoomAmt = amount; zoomT = dur || 0.36; zoomDur = zoomT;
  }

  /* a tiny camera roll makes an impact feel like it moved the operator */
  function roll(amount) { rollAmt = amount; rollT = 0.5; }

  function stepCamera(dt) {
    trauma = Math.max(0, trauma - dt * 1.9);
    if (zoomT > 0) zoomT -= dt;
    if (rollT > 0) rollT -= dt;
    shakeSeed += dt * 47;
  }

  /* Perlin-ish smooth noise so the shake drifts instead of jittering per pixel.
     Random-per-frame offsets read as film grain, not as a camera being hit. */
  function n1(t) {
    var i = Math.floor(t), f = t - i;
    var a = Math.sin(i * 127.1) * 43758.5453; a -= Math.floor(a);
    var b = Math.sin((i + 1) * 127.1) * 43758.5453; b -= Math.floor(b);
    var u = f * f * (3 - 2 * f);
    return (a + (b - a) * u) * 2 - 1;
  }

  function shakeOffset() {
    if (trauma <= 0.001) return { x: 0, y: 0, rot: 0 };
    var s = trauma * trauma;                       // square = punchy, not mushy
    return {
      x: n1(shakeSeed * 0.9) * 26 * s,
      y: n1(shakeSeed * 0.9 + 31.7) * 20 * s,
      rot: n1(shakeSeed * 0.6 + 77.3) * 0.020 * s + rollOffset()
    };
  }

  function rollOffset() {
    if (rollT <= 0) return 0;
    var p = rollT / 0.5;
    return rollAmt * p * p * Math.sin(p * 11);
  }

  /* focal-length multiplier — a real punch-in, not a scale of the bitmap */
  function zoomMul() {
    if (zoomT <= 0) return 1;
    var p = 1 - zoomT / zoomDur;
    /* snap out, ease back: overshoot at the start is what sells the hit */
    var k = p < 0.18 ? p / 0.18 : Math.pow(1 - (p - 0.18) / 0.82, 2);
    return 1 + zoomAmt * k;
  }

  /* ---------------------------------------------------------- post effects */

  var vig = 0, vigT = 0;                    // vignette pulse
  var chroma = 0;                           // colour split on impact
  var bulbs = [];                           // camera flashes in the crowd
  var speedline = 0;                        // radial streaks at high ball pace

  function pulseVignette(amount, dur) { vig = amount; vigT = dur || 0.5; }
  function pulseChroma(amount) { chroma = Math.max(chroma, amount); }

  /* Photographers' flashes. The single cheapest trick in sports games: a few
     dozen white pinpricks popping in the dark of the stand and the crowd
     instantly reads as thousands of people reacting to something. */
  function flashBulbs(count, secs) {
    for (var i = 0; i < count; i++) {
      bulbs.push({
        u: Math.random(),                    // across the stand
        v: Math.random(),                     // up the stand
        side: Math.floor(Math.random() * 3),  // which stand
        t: Math.random() * secs,              // stagger the pops
        life: 0.10 + Math.random() * 0.09
      });
    }
  }

  function stepPost(dt) {
    if (vigT > 0) { vigT -= dt; if (vigT <= 0) vig = 0; }
    chroma = Math.max(0, chroma - dt * 3.2);
    speedline = Math.max(0, speedline - dt * 3.0);
    for (var i = bulbs.length - 1; i >= 0; i--) {
      var b = bulbs[i];
      b.t -= dt;
      if (b.t < -b.life) bulbs.splice(i, 1);
    }
  }

  function vignette() { return vigT > 0 ? vig * Math.pow(vigT / 0.5, 0.6) : 0; }

  /* ------------------------------------------------------------ ball state */

  /* Squash on contact and on every bounce. Returned as a scale triple the
     renderer applies to the ball sphere — a ball that never deforms reads as a
     billiard ball, and it is the single clearest tell of a cheap 3D game. */
  var squash = 0, squashAxis = { x: 0, y: 0, z: 1 };

  function squashBall(amount, axis) {
    squash = Math.max(squash, amount);
    if (axis) squashAxis = axis;
  }

  function stepBall(dt, world) {
    squash = Math.max(0, squash - dt * 6.5);
    if (world && world.ball) {
      var sp = world.ball.speed();
      if (sp > 22) speedline = Math.max(speedline, Math.min(1, (sp - 22) / 20));
    }
  }

  function ballSquash() {
    if (squash <= 0.001) return null;
    /* recovery wobble: overshoot past round once, like a real inflated ball */
    var s = squash;
    var w = Math.sin(s * 9) * 0.35 + 1;
    return { amount: s * w, axis: squashAxis };
  }

  /* --------------------------------------------------------------- the cues */

  /* One place that decides what every simulation event feels like. */
  var CUE = {
    bounce: function (a) {
      SFX.bounce(a);
      shake(0.05 + a * 0.10);
      squashBall(0.16 + a * 0.30, { x: 0, y: 0, z: 1 });
      if (a > 0.35 && typeof fxBurst === "function" && world) {
        fxBurst(world.ball.x, world.ball.y, 0.04, 3 + Math.round(a * 6),
                { speed: 1.2 + a * 2.0, up: 1.1, life: 0.32, r: 0.045,
                  col: "180,205,140", grav: 9 });
      }
    },
    post: function () {
      SFX.post();
      hitstop(0.055);
      shake(0.62);
      zoom(0.10, 0.42);
      roll(0.016);
      pulseChroma(0.7);
      pulseVignette(0.34, 0.5);
      squashBall(0.55, { x: 1, y: 0, z: 0 });
      buzz([12, 30, 12]);
      bigWord("WOODWORK", "#ffd23d", 0.7);
      flashBulbs(14, 0.5);
    },
    save: function (spectacular) {
      SFX.save();
      hitstop(0.04);
      shake(0.30 + spectacular * 0.18);
      zoom(0.07, 0.4);
      squashBall(0.42, { x: 0, y: 1, z: 0 });
      pulseVignette(0.28, 0.6);
      buzz(35);
    },
    block: function () {
      SFX.block();
      hitstop(0.035);
      shake(0.34);
      squashBall(0.40, { x: 0, y: 1, z: 0 });
      buzz(30);
    },
    deflect: function () {
      SFX.block();
      shake(0.22);
      squashBall(0.30, { x: 0, y: 1, z: 0 });
      buzz(18);
    },
    net: function () {
      /* the goal sequence owns the presentation — this is only the fabric */
      SFX.net();
    },
    /* a first touch: a soft thud and the smallest of nudges, so a pass arriving
       is felt as an event without competing with a strike */
    receive: function () {
      SFX.pass(0.28);
      shake(0.08);
      squashBall(0.22, { x: 0, y: 1, z: 0 });
      buzz(8);
    }
  };

  function drainCues(w) {
    if (!w || !w.cues || !w.cues.length) return;
    for (var i = 0; i < w.cues.length; i++) {
      var c = w.cues[i];
      if (CUE[c.n]) CUE[c.n](c.a == null ? 1 : c.a);
    }
    w.cues.length = 0;
  }

  /* ------------------------------------------------------- the goal moment */

  /* A timeline, not a single flash. Beats, in seconds from the ball crossing:
       0.00  freeze on the net bulge, hard shake, white bloom, roar starts
       0.08  release into slow motion, camera punches in
       0.34  GOAL lands, letter by letter
       0.55  flash bulbs across all three stands
       0.90  confetti from the stand fronts
       1.60  ease back to real time
     Doing it as a timeline is what separates a celebration from a text flash. */
  var goalT = -1;

  function goal(world) {
    goalT = 0;
    hitstop(0.085);
    shake(1.0);
    zoom(0.16, 1.5);
    roll(0.02);
    pulseChroma(1.0);
    pulseVignette(0.55, 1.2);
    squashBall(0.65, { x: 0, y: 1, z: 0 });
    if (typeof flashScreen === "function") flashScreen(0.85, 0.5);
    buzz([30, 40, 30, 40, 120]);
    flashBulbs(46, 1.1);
    if (typeof CROWD_SURGE !== "undefined") CROWD_SURGE = 1.0;
  }

  var goalBeats = [
    { t: 0.085, done: 0, run: function () { slowmo(1.5, 0.26); } },
    { t: 0.34,  done: 0, run: function () { goalWord(); } },
    { t: 0.55,  done: 0, run: function () { flashBulbs(60, 1.6); } },
    { t: 0.90,  done: 0, run: function () { confetti(); } },
    { t: 1.45,  done: 0, run: function () { flashBulbs(40, 1.4); } }
  ];

  function stepGoal(dt) {
    if (goalT < 0) return;
    goalT += dt;
    for (var i = 0; i < goalBeats.length; i++) {
      var b = goalBeats[i];
      if (!b.done && goalT >= b.t) { b.done = 1; b.run(); }
    }
    if (goalT > 3.2) { goalT = -1; for (i = 0; i < goalBeats.length; i++) goalBeats[i].done = 0; }
  }

  function goalWord() {
    if (typeof kineticWord === "function") kineticWord("GOAL");
  }

  /* Streamers thrown from the front of the stands, which is where they would
     actually come from — spawning them at the goal looks like a UI particle. */
  function confetti() {
    if (typeof fxBurst !== "function") return;
    for (var i = 0; i < 5; i++) {
      var x = -22 + i * 11 + (Math.random() * 6 - 3);
      fxBurst(x, GOAL_Y - 2.5, 5.0 + Math.random() * 3, 16,
              { speed: 3.0, up: 2.2, life: 2.6, r: 0.085, grav: 2.4,
                col: i % 2 ? "255,240,180" : "200,255,120", ribbon: 1 });
    }
  }

  /* --------------------------------------------------------- cinematic beats */

  /* A brief lens move on an event, independent of the follow camera. This is
     what separates "the camera happens to be pointing at the action" from
     "someone chose this shot": a fast push in on a strike, a slower drift on a
     pass, both easing out so the follow camera takes over without a seam.

     Returned as a focal multiplier and a lateral offset that render.js applies
     on top of whatever cameraFollow() decided. */
  var cineT = 0, cineDur = 0, cinePush = 0, cineDrift = 0;

  function cine(dur, push, drift) {
    cineT = dur; cineDur = dur; cinePush = push; cineDrift = drift || 0;
  }

  function stepCine(dt) { if (cineT > 0) cineT -= dt; }

  function cinePushAmount() {
    if (cineT <= 0) return 0;
    var p = 1 - cineT / cineDur;
    /* in fast, hold, ease out — the shape of a rack focus */
    var k = p < 0.16 ? p / 0.16 : Math.pow(1 - (p - 0.16) / 0.84, 1.7);
    return cinePush * k;
  }

  function cineDriftAmount() {
    if (cineT <= 0) return 0;
    var p = 1 - cineT / cineDur;
    return cineDrift * Math.sin(p * Math.PI) ;
  }

  /* A pass is a quieter beat than a shot and needs its own language: no shake,
     no hit-stop, a slower push and a sideways drift so the frame opens toward
     the receiver. */
  function pass(power) {
    var p = Math.max(0, Math.min(1, power));
    cine(0.85, 0.055 + p * 0.05, 0.5 + p * 0.6);
    squashBall(0.20 + p * 0.20, { x: 0, y: 1, z: 0 });
    shake(0.10 + p * 0.12);
    speedline = Math.max(speedline, p * 0.30);
    buzz(8 + Math.round(p * 10));
  }

  /* ------------------------------------------------------------- the strike */

  function strike(power) {
    var p = Math.max(0, Math.min(1, power));
    hitstop(0.03 + p * 0.035);
    shake(0.30 + p * 0.42);
    zoom(0.05 + p * 0.07, 0.34);
    roll(p * 0.010);
    squashBall(0.35 + p * 0.35, { x: 0, y: 1, z: 0 });
    pulseChroma(0.35 + p * 0.4);
    speedline = Math.max(speedline, p * 0.7);
    cine(0.62, 0.10 + p * 0.09, 0);
    buzz(10 + Math.round(p * 22));
  }

  /* ------------------------------------------------------------------- step */

  function step(dt, world) {
    stepCamera(dt);
    stepCine(dt);
    stepPost(dt);
    stepBall(dt, world);
    stepGoal(dt);
  }

  function reset() {
    hitstopT = 0; slowT = 0; trauma = 0; zoomT = 0; rollT = 0; cineT = 0;
    vig = 0; vigT = 0; chroma = 0; speedline = 0; squash = 0;
    bulbs.length = 0; goalT = -1;
    for (var i = 0; i < goalBeats.length; i++) goalBeats[i].done = 0;
  }

  return {
    stepTime: stepTime, timeScale: timeScale,
    hitstop: hitstop, slowmo: slowmo,
    shake: shake, zoom: zoom, roll: roll,
    cine: cine, cinePush: cinePushAmount, cineDrift: cineDriftAmount,
    pass: pass,
    shakeOffset: shakeOffset, zoomMul: zoomMul,
    pulseVignette: pulseVignette, vignette: vignette,
    pulseChroma: pulseChroma, chroma: function () { return chroma; },
    speedlines: function () { return speedline; },
    bulbs: function () { return bulbs; },
    squashBall: squashBall, ballSquash: ballSquash,
    drainCues: drainCues,
    goal: goal, strike: strike, confetti: confetti,
    step: step, reset: reset,
    trauma: function () { return trauma; }
  };
})();
