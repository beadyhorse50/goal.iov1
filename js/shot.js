/* goal.io — headless capture harness. NOT loaded by index.html.

   Why this exists: the embedded dev browser runs the page in a hidden tab, so
   requestAnimationFrame never fires and the game loop never runs. Nothing is
   broken — the canvas rasterises fine without a compositor. This file drives
   the loop by hand so a frame can be rendered and POSTed to devserver.py.

   Inject it, then:
     SHOT.grab("name.png", {level:0, t:1.2})            // aim frame, level 1
     SHOT.grab("kick.png", {level:0, kick:{power:.9}})   // strike and fly 1.2s
     SHOT.seq("goal", {level:0, kick:{power:.95}, at:[0,.3,.8,1.6]})
*/
"use strict";

var SHOT = (function () {

  /* the page sized its canvas before the pane had a size — do it again now */
  function fit(w, h) {
    if (w) {
      /* resize() reads window.innerWidth; override for a deterministic frame */
      Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
    }
    resize();
    return { w: cvs.width, h: cvs.height, vp: { w: VP.w, h: VP.h, x: VP.x, y: VP.y } };
  }

  /* advance sim + camera + render exactly as frame() would, without rAF */
  function step(secs, dt) {
    dt = dt || 1 / 60;
    var STEPH = 1 / 120, acc = 0, n = Math.max(1, Math.round(secs / dt));
    for (var i = 0; i < n; i++) {
      var scale = 1;
      if (world.slowmo > 0) { world.slowmo -= dt; scale = 0.3; }
      acc += dt * scale;
      var guard = 0;
      while (acc >= STEPH && guard++ < 12) {
        var before = world.phase;
        world.update(STEPH);
        acc -= STEPH;
        if (before !== "over" && world.phase === "over" &&
            typeof onLevelOver === "function") onLevelOver();
      }
      cameraFollow(world, dt, false);
      renderWorld(world, null, dt);
    }
  }

  /* aim at a point on the goal line and strike, mirroring endDrag() */
  function strike(o) {
    o = o || {};
    var b = world.ball;
    var m = o.mode == null ? 1 : o.mode;
    var M = MODES[m];
    var power = o.power == null ? 0.9 : o.power;
    var speed = PHYS.MIN_SPEED + (PHYS.MAX_SPEED - PHYS.MIN_SPEED) * power;
    var aimX = o.aimX == null ? 0 : o.aimX;          // metres either side of centre
    var dx = aimX - b.x, dy = GOAL_Y - b.y;
    var L = Math.sqrt(dx * dx + dy * dy) || 1;
    world.kick(dx / L, dy / L, speed, M.angle, o.curve || 0, m);
    /* the presentation endDrag() fires — without it a captured strike has no juice */
    if (typeof cameraPunch === "function") cameraPunch(0.30 + power * 0.45);
    if (typeof CROWD_SURGE !== "undefined") {
      CROWD_SURGE = Math.max(CROWD_SURGE, 0.22 + power * 0.3);
    }
  }

  function post(name, note) {
    var d = cvs.toDataURL("image/png");
    return fetch("/", {
      method: "POST",
      body: JSON.stringify({ name: name, png: d })
    }).then(function (r) { return r.json(); })
      .then(function (j) { j.note = note || ""; return j; });
  }

  return {
    fit: fit,
    step: step,

    /* one frame: set up the level, optionally strike, run t seconds, capture */
    grab: function (name, o) {
      o = o || {};
      fit(o.w || 390, o.h || 844);
      if (o.screen === "menu") { showMenu(); return post(name, "menu"); }
      startLevel(o.level || 0);
      /* one render so the camera settles on its target before anything moves */
      cameraFollow(world, 0, true);
      renderWorld(world, null, 0);
      if (o.kick) { strike(o.kick); }
      if (o.t) step(o.t);
      return post(name, "phase=" + world.phase + " event=" + (world.event || "-"));
    },

    /* a burst of frames across a single flight — the whole goal moment */
    seq: function (base, o) {
      o = o || {};
      fit(o.w || 390, o.h || 844);
      startLevel(o.level || 0);
      cameraFollow(world, 0, true);
      renderWorld(world, null, 0);
      if (o.kick) strike(o.kick);
      var at = o.at || [0, 0.4, 0.9, 1.5], out = [], prev = 0;
      var chain = Promise.resolve();
      at.forEach(function (t, i) {
        chain = chain.then(function () {
          step(Math.max(0, t - prev)); prev = t;
          return post(base + "-" + i + ".png",
                      "t=" + t + " phase=" + world.phase + " ev=" + (world.event || "-"))
            .then(function (r) { out.push(r); });
        });
      });
      return chain.then(function () { return out; });
    },

    /* what the sim thinks is going on — cheap text probe, no image */
    probe: function () {
      return {
        phase: world.phase, event: world.event || null,
        ball: { x: +world.ball.x.toFixed(2), y: +world.ball.y.toFixed(2), z: +world.ball.z.toFixed(2) },
        cam: { px: +Cam.px.toFixed(2), py: +Cam.py.toFixed(2), pz: +Cam.pz.toFixed(2) },
        touches: world.touchesUsed, slowmo: +(world.slowmo || 0).toFixed(2)
      };
    }
  };
})();
