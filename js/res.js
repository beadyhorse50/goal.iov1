/* goal.io — res.js: one source of truth for how many pixels get rendered.

   The old rule lived in three places that had to agree by coincidence:
   min(devicePixelRatio, 2.5). That is not a resolution, it is a multiplier,
   and it produced wildly different pictures from the same code. A modern
   phone rendered *below* its own panel. A 1280x800 desktop window rendered
   1:1 and aliased every net cord, line marking and crowd dot it drew — most
   of the shimmer in this game was never a shader, it was 1x.

   The rule here is a pixel budget: render as many pixels as fit inside a 4K
   frame, 3840x2160, whatever shape the window is. On a desktop window that
   works out at 3-4x supersampling, which the browser resolves back down for
   free when it composites. On a phone it is real 4K-class detail, past what
   the panel can show, which is exactly where the thin geometry here lives.

   That is two to four times the fill rate of the old cap, and this renderer
   is fill-bound, so the budget is adaptive. tick() watches frame pacing and,
   when frames stop landing on a vsync, drops straight to the ratio the
   measurement says will fit. A ceiling keeps it from climbing back into a
   level that has already proved too slow, so it settles rather than pumping
   between two settings — but that ceiling relaxes again after a sustained
   comfortable stretch, so one bad patch does not cap the session.

   Everything reads RES.ratio(), a plain cached getter. The number only ever
   moves inside tick() or sync(), both of which run before anything renders.
   A ratio that changed halfway through a frame would leave the GL viewport
   and the 2D overlay at different scales, which does not look like a
   resolution bug — it looks like the camera is broken.

   Override with ?res=4k (no adaptation), ?res=native, ?res=off (the old
   2.5 cap), or ?res=2.75 for a fixed ratio.
*/
"use strict";

var RES = (function () {

  var T4K = 3840 * 2160;        // the budget, in device pixels
  var T2K = 1920 * 1080;        // what the canvas fallback can actually push
  var MAX_RATIO = 4;            // past this there is nothing left to resolve
  var MIN_SCALE = 0.5;          // the adaptive floor

  var target  = T2K;            // raised to T4K when the GL renderer boots
  var limit   = 8192;           // driver max texture size; set by RES.limit()
  var pinned  = null;           // ?res= or RES.pin()
  var adapt   = true;

  var scale   = 1;              // adaptive multiplier on the budget
  var ceiling = 1;              // highest scale not yet proved too slow
  var ratio   = 1;              // THE number
  var cw = 1, ch = 1;           // css size the current ratio was computed for

  /* ------------------------------------------------------------- the ratio */

  function compute() {
    cw = Math.max(1, window.innerWidth  || document.documentElement.clientWidth  || 1);
    ch = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    var nat = window.devicePixelRatio || 1;
    var r;

    if (pinned != null) {
      r = pinned;
    } else {
      /* the ratio that lands this window exactly on the budget. sqrt because
         the budget is an area and the ratio scales both axes at once. */
      var budget = Math.sqrt(target / (cw * ch));
      r = Math.min(MAX_RATIO, Math.max(1, budget)) * scale;
      /* even at the adaptive floor, never hand back a mushy picture on a
         device whose panel is sharper than that */
      r = Math.max(r, Math.min(nat, 1.5));
    }

    /* A render target past the driver's max texture size does not throw. It
       comes back incomplete, GPOST.resize() quietly returns false, and the
       entire post chain drops out — which reads as "the grade broke", not
       "the buffer was too big". Clamp rather than find out. */
    r = Math.min(r, limit / Math.max(cw, ch));

    ratio = Math.max(0.5, r);
    return ratio;
  }

  /* Recompute for the window as it is now. Cheap enough to call every frame,
     and calling it is always safer than trusting a cached value: the canvas
     renderer's resize() runs from a resize event, the harness runs it with a
     faked innerWidth, and both have to see the same number the GL layer will. */
  function sync() { return compute(); }

  /* --------------------------------------------------------- adaptive pass */

  var FRAMES = 45;
  var dts = new Float64Array(FRAMES), n = 0, prev = 0, hold = 0, good = 0;

  function median(k) {
    var s = [];
    for (var i = 0; i < k; i++) s.push(dts[i]);
    s.sort(function (a, b) { return a - b; });
    return s[k >> 1];
  }

  /* Call once per frame from the game loop. `active` is false on the menus,
     where nothing is being drawn — sampling there would ramp the resolution
     up on an empty screen and then collapse it the moment play starts. */
  function tick(now, active) {
    sync();
    if (!active || !adapt || pinned != null) { prev = 0; n = 0; return ratio; }
    if (!prev) { prev = now; return ratio; }

    var dt = now - prev;
    prev = now;

    /* A stall is a tab switch, a level load or a GC pause, not a frame we are
       too slow for. Throwing the window away is cheaper and more reliable
       than trying to tell them apart. */
    if (dt <= 0 || dt > 100) { n = 0; return ratio; }
    if (hold > 0) { hold--; return ratio; }

    dts[n++] = dt;
    if (n < FRAMES) return ratio;
    n = 0;

    var med = median(FRAMES);
    if (med > 20 && scale > MIN_SCALE) {
      good = 0;
      /* How much of the current cost we can actually afford, measured rather
         than guessed. Pixels go as the square of the ratio, hence the sqrt —
         a frame landing at 33 ms needs 0.71x the ratio, and saying so directly
         gets there in one step instead of walking down in four. */
      var fit = Math.sqrt(16.7 / med);
      var s = Math.max(scale * 0.7, Math.min(scale * 0.97, scale * fit));
      /* the ceiling goes just above where we are heading, not just below where
         we were: setting it to the level that was already too slow is how it
         ends up climbing straight back into it every time */
      ceiling = Math.min(ceiling, s * 1.05);
      step(s);
    } else if (med < 17.4) {
      good++;
      if (scale < ceiling - 0.01) {
        step(Math.min(ceiling, scale * 1.05));
      } else if (ceiling < 1 && good >= 6) {
        /* Sustained comfort at the current ceiling. The ceiling exists to stop
           the ratio pumping between two settings, but one that only ever goes
           down means a single bad patch — a thermal blip, another tab on the
           GPU, a heavy celebration — caps the game for the rest of the
           session. Let it back up, slowly enough that a device which is
           genuinely at its limit just bounces off the same wall. */
        good = 0;
        ceiling = Math.min(1, ceiling * 1.08);
        step(Math.min(ceiling, scale * 1.08));
      }
    } else {
      good = 0;
    }
    return ratio;
  }

  function step(s) {
    s = Math.max(MIN_SCALE, Math.min(1, s));
    if (Math.abs(s - scale) < 0.015) return;
    scale = s;
    hold = 30;                  // let the new resolution settle before judging it
    n = 0; good = 0;
    compute();
    save();
  }

  /* ------------------------------------------------------------ shadow map
     1024 texels over a 44 m box is visibly stepped once the picture itself is
     resolved past about 3 MP: the contact shadow under the ball is the first
     thing to go. Hysteresis on the way back down so a ratio hovering near the
     threshold does not reallocate the depth target every few frames. */
  var shadowNow = 1024;
  function shadow(max) {
    var px = pixels();
    if (px > 3.2e6) shadowNow = 2048;
    else if (px < 2.6e6) shadowNow = 1024;
    return Math.min(shadowNow, max || 2048);
  }

  function pixels() {
    return Math.round(cw * ratio) * Math.round(ch * ratio);
  }

  /* ---------------------------------------------------------- persistence
     A phone that has already proved it cannot hold 4K should not spend the
     first five seconds of every launch discovering that again. The ceiling is
     let back up slightly on each load so one bad session — another app on the
     GPU, a thermally throttled phone — does not cap the game permanently. */
  var KEY = "goalio_res";

  function save() {
    try { localStorage.setItem(KEY, scale.toFixed(3) + "," + ceiling.toFixed(3)); } catch (e) {}
  }

  function load() {
    try {
      var v = (localStorage.getItem(KEY) || "").split(",");
      var s = parseFloat(v[0]), c = parseFloat(v[1]);
      if (s >= MIN_SCALE && s <= 1) scale = s;
      if (c >= MIN_SCALE && c <= 1) ceiling = Math.min(1, c * 1.15);
      if (scale > ceiling) scale = ceiling;
    } catch (e) {}
  }

  function flag() {
    var m = /[?&]res=([^&]+)/.exec(window.location ? window.location.search : "");
    if (!m) return;
    var v = decodeURIComponent(m[1]).toLowerCase();
    if (v === "off")    { pinned = Math.min(window.devicePixelRatio || 1, 2.5); return; }
    if (v === "native") { pinned = window.devicePixelRatio || 1; return; }
    if (v === "4k")     { adapt = false; return; }
    var f = parseFloat(v);
    if (f > 0 && f <= 8) pinned = f;
  }

  flag();
  if (pinned == null) load();
  compute();

  return {
    T4K: T4K,
    T2K: T2K,

    ratio: function () { return ratio; },
    sync: sync,
    tick: tick,
    shadow: shadow,
    pixels: pixels,

    /* pin the ratio — the capture harness uses this for a deterministic frame */
    pin: function (r) { pinned = (r == null ? null : r); n = 0; return compute(); },

    /* the driver's real ceiling, once there is a context to ask */
    limit: function (px) { if (px > 0) { limit = px; compute(); } return limit; },

    /* which renderer is live decides how big the budget can be */
    target: function (px) { if (px > 0) { target = px; compute(); } return target; },

    info: function () {
      return {
        ratio: +ratio.toFixed(3),
        buffer: [Math.round(cw * ratio), Math.round(ch * ratio)],
        mpx: +(pixels() / 1e6).toFixed(2),
        css: [cw, ch],
        native: window.devicePixelRatio || 1,
        scale: +scale.toFixed(3),
        ceiling: +ceiling.toFixed(3),
        target: +(target / 1e6).toFixed(2),
        limit: limit,
        shadow: shadowNow,
        adapt: adapt && pinned == null
      };
    }
  };
})();
