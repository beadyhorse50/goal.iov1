/* goal.io — capture harness for the WebGL renderer. NOT loaded by index.html.

   js/shot.js POSTs cvs.toDataURL(), which only ever sees the 2D canvas. With
   the GL renderer on, the picture is two layers — #gamegl underneath and #game
   on top — so a capture has to composite them in the same order the browser
   would. That is all this file is.

   It also matters more here than it looks. The dev browser never composites,
   so a WebGL frame cannot be screenshotted at all; but readback works whether
   or not anything is on screen, which makes this renderer *easier* to verify
   in this environment than the canvas one, not harder.

   Inject js/shot.js first (this uses its stepper), then:
     GSHOT.boot()                       // turn GL on for this page, no reload
     GSHOT.grab("gl-aim.png", {level:0})
     GSHOT.seq("gl-goal", {level:0, kick:{power:.95, aimX:2.2}, at:[0,.4,.9]})
     GSHOT.zoom("gl-net.png", {level:0, rect:[0.3,0.3,0.4,0.3], scale:3})
*/
"use strict";

var GSHOT = (function () {

  /* shot.js keeps its strike() private, so this is the same aim-and-kick,
     including the presentation endDrag() fires — without the punch and the
     crowd surge a captured strike has no juice and the camera never moves. */
  function strike(o) {
    o = o || {};
    var b = world.ball;
    var m = o.mode == null ? 1 : o.mode;
    var M = MODES[m];
    var power = o.power == null ? 0.9 : o.power;
    var speed = PHYS.MIN_SPEED + (PHYS.MAX_SPEED - PHYS.MIN_SPEED) * power;
    var aimX = o.aimX == null ? 0 : o.aimX;
    var dx = aimX - b.x, dy = GOAL_Y - b.y;
    var L = Math.sqrt(dx * dx + dy * dy) || 1;
    world.kick(dx / L, dy / L, speed, M.angle, o.curve || 0, m);
    if (typeof cameraPunch === "function") cameraPunch(0.30 + power * 0.45);
    if (typeof CROWD_SURGE !== "undefined") {
      CROWD_SURGE = Math.max(CROWD_SURGE, 0.22 + power * 0.3);
    }
  }

  function comp() {
    var g = document.getElementById("gamegl");
    var c = document.getElementById("game");
    var out = document.createElement("canvas");
    out.width = c.width; out.height = c.height;
    var o = out.getContext("2d");
    /* the page background shows through wherever neither layer painted */
    o.fillStyle = "#05070c";
    o.fillRect(0, 0, out.width, out.height);
    if (g) o.drawImage(g, 0, 0, out.width, out.height);
    o.drawImage(c, 0, 0);
    return out;
  }

  function post(canvas, name, note) {
    return fetch("/", {
      method: "POST",
      body: JSON.stringify({ name: name, png: canvas.toDataURL("image/png") })
    }).then(function (r) { return r.json(); })
      .then(function (j) { j.note = note || ""; return j; });
  }

  function note() {
    return "phase=" + world.phase + " ev=" + (world.event || "-") +
           " gl=" + (GLR.live ? "live" : "off");
  }

  return {
    /* Turn the renderer on for a page that is already running. The flag is
       normally read at load, so this is the only way to A/B the two renderers
       without a reload — and a reload loses the level state. */
    boot: function () {
      try { localStorage.setItem("goalio_gl", "1"); } catch (e) {}
      var ok = GLR.boot();
      return { live: GLR.live, ok: ok };
    },

    /* Every error the GL layer can report, in one call. Worth running before
       believing any picture: a shader that failed to compile leaves a black
       frame that looks exactly like a camera pointing at the sky at night. */
    check: function () {
      var g = GLR.gl();
      if (!g) return { gl: false };
      var out = { gl: true, live: GLR.live, progs: {}, err: g.getError() };
      for (var k in GLR.progs) {
        if (GLR.progs.hasOwnProperty(k)) out.progs[k] = !!(GLR.progs[k] && GLR.progs[k].p);
      }
      var c = GLR.canvas();
      out.size = [c.width, c.height];
      out.vp = [Math.round(VP.x), Math.round(VP.y), Math.round(VP.w), Math.round(VP.h)];
      out.cam = [+Cam.px.toFixed(2), +Cam.py.toFixed(2), +Cam.pz.toFixed(2)];
      return out;
    },

    /* Is anything actually there? Reads the centre of the play area straight
       out of the GL drawing buffer — no compositor involved. */
    peek: function (n) {
      var g = GLR.gl(), c = GLR.canvas();
      n = n || 5;
      var px = new Uint8Array(4 * n * n);
      var x = Math.round((VP.x + VP.w / 2) * (c.width / window.innerWidth));
      var y = Math.round(c.height - (VP.y + VP.h * 0.75) * (c.height / window.innerHeight));
      g.readPixels(x, y, n, n, g.RGBA, g.UNSIGNED_BYTE, px);
      var out = [];
      for (var i = 0; i < n * n; i++) {
        out.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]]);
      }
      return out;
    },

    /* Capture whatever is on screen RIGHT NOW, without touching the world.

       grab() and seq() both call startLevel() first, which is what you want
       when you are describing a shot declaratively — and exactly what you do
       not want when you have driven the sim to an interesting moment by hand.
       Using grab() to photograph a celebration silently restarts the level and
       hands back the aim frame, which looks like the renderer failing rather
       than the harness resetting. */
    snap: function (name) {
      renderWorld(world, null, 0);
      return post(comp(), name, note());
    },

    grab: function (name, o) {
      o = o || {};
      SHOT.fit(o.w || 390, o.h || 844);
      startLevel(o.level || 0);
      cameraFollow(world, 0, true);
      renderWorld(world, null, 0);
      if (o.kick) strike(o.kick);
      if (o.t) SHOT.step(o.t);
      return post(comp(), name, note());
    },

    seq: function (base, o) {
      o = o || {};
      SHOT.fit(o.w || 390, o.h || 844);
      startLevel(o.level || 0);
      cameraFollow(world, 0, true);
      renderWorld(world, null, 0);
      var at = o.at || [0, 0.4, 0.9, 1.5], prev = 0, out = [];
      var chain = Promise.resolve();
      at.forEach(function (t, i) {
        chain = chain.then(function () {
          if (i === 0 && o.kick) strike(o.kick);
          SHOT.step(Math.max(0, t - prev)); prev = t;
          return post(comp(), base + "-" + i + ".png", "t=" + t + " " + note())
            .then(function (r) { out.push(r); });
        });
      });
      return chain.then(function () { return out; });
    },

    /* A crop, magnified with smoothing off. Reading a whole 2 MP frame
       downscales it and hides exactly the artefact worth looking for — the
       net cord, the shadow edge, the line antialiasing. rect is fractional. */
    zoom: function (name, o) {
      o = o || {};
      if (o.level != null) {
        SHOT.fit(o.w || 390, o.h || 844);
        startLevel(o.level);
        cameraFollow(world, 0, true);
        renderWorld(world, null, 0);
        if (o.kick) strike(o.kick);
        if (o.t) SHOT.step(o.t);
      }
      var src = comp();
      var r = o.rect || [0.25, 0.35, 0.5, 0.3];
      var sx = Math.round(r[0] * src.width), sy = Math.round(r[1] * src.height);
      var sw = Math.round(r[2] * src.width), sh = Math.round(r[3] * src.height);
      var k = o.scale || 2;
      var out = document.createElement("canvas");
      out.width = sw * k; out.height = sh * k;
      var c = out.getContext("2d");
      c.imageSmoothingEnabled = false;
      c.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return post(out, name, "crop " + sx + "," + sy + " " + sw + "x" + sh);
    }
  };
})();
