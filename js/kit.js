/* goal.io — kit textures, painted at runtime.

   THE PROBLEM THIS SOLVES
   -----------------------
   The kit in each assets/models/*.glb is baked into its texture. So the game's
   three club kits — Hackney Marsh white, Redbridge City cyan, Atletico Lisboa
   gold — did nothing, and every player on a team wore the same squad number.

   Generating a GLB per kit would be three seasons times three roles at ~470 KB
   each: 4 MB of near-identical geometry to ship a colour change.

   But the kit is only a flat 512px texture of coloured rectangles over a known
   UV layout, and that layout is data. tools/kit_export.py pulls it out of the
   Python generator into config/kit-layout.json; this paints the same rectangles
   into a canvas. Any kit, any colours, any squad number, for zero bytes of
   assets and no build step.

   THE OBVIOUS RISK, AND WHAT IS DONE ABOUT IT
   -------------------------------------------
   Two implementations of one layout will drift. That is why the layout is
   EXPORTED rather than retyped — football-characters/chargen/textures.py stays
   the single source of truth and re-running the tool is how a change to it
   reaches the game. The painting order below mirrors kit_textures() step for
   step, deliberately, so the two can be read side by side.
*/
"use strict";

var KIT = (function () {

  var cache = {};          // key -> canvas
  var LAYOUT = null;

  function layout() {
    if (LAYOUT) return LAYOUT;
    LAYOUT = (typeof CONFIG !== "undefined" && CONFIG.get)
      ? CONFIG.get("kit-layout", null) : null;
    return LAYOUT;
  }

  /* Blocky 3x5 numerals, the same font the generator bakes in. Legible at
     512px on a shirt that is forty pixels tall on screen, which a real
     typeface is not. */
  function digits(ctx, size, text, uCentre, v, h, colour) {
    var L = layout();
    if (!L || !L.digits) return;
    var cell = h * size / 5.0;
    var width = (text.length * 3 + (text.length - 1)) * cell;
    var x = uCentre * size - width / 2;
    ctx.fillStyle = colour;
    for (var i = 0; i < text.length; i++) {
      var pat = L.digits[text.charAt(i)];
      if (pat) {
        for (var r = 0; r < 5; r++) {
          for (var c = 0; c < 3; c++) {
            if (pat.charAt(r * 3 + c) === "1") {
              ctx.fillRect(Math.round(x + c * cell), Math.round(v * size + r * cell),
                           Math.ceil(cell), Math.ceil(cell));
            }
          }
        }
      }
      x += cell * 4.0;
    }
  }

  function rectUV(ctx, size, u0, v0, u1, v1, colour) {
    ctx.fillStyle = colour;
    ctx.fillRect(Math.round(u0 * size), Math.round(v0 * size),
                 Math.ceil((u1 - u0) * size), Math.ceil((v1 - v0) * size));
  }

  /* Is this colour light enough that a dark number reads better on it? The
     generator makes the same call at the same threshold. */
  function darkOn(hex) {
    var v = parseInt(hex.replace("#", ""), 16);
    var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (r + g + b) > 380;
  }

  /* Mirrors chargen/textures.py kit_textures(), in the same order. */
  function paint(spec, number) {
    var L = layout();
    if (!L) return null;
    var size = L.size || 512;
    var uv = L.uv;
    var c = document.createElement("canvas");
    c.width = size; c.height = size;
    var x = c.getContext("2d");

    var P = spec.primary, Q = spec.secondary, T = spec.trim;

    x.fillStyle = P;
    x.fillRect(0, 0, size, size);

    var s = uv.shirt, su0 = s[0], sv0 = s[1], su1 = s[2], sv1 = s[3];
    var pattern = spec.pattern || "plain";
    var i, n, v;
    if (pattern === "stripes") {
      n = 10;
      for (i = 0; i < n; i += 2) {
        var w = (su1 - su0) / n;
        rectUV(x, size, su0 + i * w, sv0, su0 + (i + 1) * w, sv1, Q);
      }
    } else if (pattern === "halves") {
      rectUV(x, size, (su0 + su1) * 0.5, sv0, su1, sv1, Q);
    } else if (pattern === "sash") {
      x.fillStyle = Q;
      for (i = 0; i < Math.floor(size * 0.55); i++) {
        var yy = sv0 * size + i;
        var xx = su0 * size + i * 1.6;
        x.fillRect(xx, yy, size * 0.16, 1);
      }
    } else if (pattern === "hoops") {
      n = 7;
      for (i = 0; i < n; i++) {
        if (i % 2) {
          v = sv0 + (sv1 - sv0) * i / n;
          rectUV(x, size, su0, v, su1, v + (sv1 - sv0) / n, Q);
        }
      }
    }

    /* shoulder trim across the top of the shirt region */
    rectUV(x, size, su0, sv0, su1, sv0 + 0.035, T);

    /* squad number on the back half of the wrap */
    var nc = spec.numberColour || (darkOn(P) ? "#14161a" : "#f5f8fc");
    digits(x, size, String(number == null ? 9 : number), 0.50, sv0 + 0.13, 0.30, nc);

    var a = uv.sleeve;
    rectUV(x, size, a[0], a[1], a[2], a[3], Q);
    rectUV(x, size, a[0], a[3] - 0.028, a[2], a[3], T);          // cuff

    var h = uv.shorts;
    rectUV(x, size, h[0], h[1], h[2], h[3], Q);
    rectUV(x, size, h[0], h[1], h[2], h[1] + 0.022, T);          // waistband
    rectUV(x, size, h[0] + 0.06, h[1] + 0.05, h[0] + 0.12, h[3] - 0.03, P);

    var k = uv.sock;
    rectUV(x, size, k[0], k[1], k[2], k[3], P);
    rectUV(x, size, k[0], k[1], k[2], k[1] + 0.045, T);          // turnover
    rectUV(x, size, k[0], k[1] + 0.055, k[2], k[1] + 0.075, Q);

    var cl = uv.collar;
    rectUV(x, size, cl[0], cl[1], cl[2], cl[3], T);

    /* A flat fill reads as plastic. The generator adds noise then a one-pixel
       soften; this does the noise only — the soften cost more than it showed
       at the size a shirt actually occupies on screen. */
    var img = x.getImageData(0, 0, size, size);
    var d = img.data;
    for (i = 0; i < d.length; i += 4) {
      var nz = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 9 - 4.5;
      d[i] += nz; d[i + 1] += nz; d[i + 2] += nz;
    }
    x.putImageData(img, 0, 0);

    return c;
  }

  return {
    /* Cached: a match shows three or four distinct kits, and repainting a
       512px canvas per player per frame would be absurd. */
    get: function (spec, number) {
      if (!spec) return null;
      var key = spec.primary + "|" + spec.secondary + "|" + spec.trim + "|" +
                (spec.pattern || "plain") + "|" + number;
      if (cache[key] !== undefined) return cache[key];
      var c = null;
      try { c = paint(spec, number); }
      catch (e) { console.warn("[kit] paint failed:", e.message); }
      cache[key] = c;
      return c;
    },

    /* Which kit a player wears. Season comes from the level, so a club change
       between seasons actually changes the shirt. */
    specFor: function (team, role, season) {
      var K = (typeof CONFIG !== "undefined" && CONFIG.get) ? CONFIG.get("kits", null) : null;
      if (!K || !K.teams) return null;
      var t = K.teams[role === "gk" ? "gk" : team];
      if (!t) return null;
      return (t.bySeason && t.bySeason[String(season)]) || t.default || null;
    },

    ready: function () { return !!layout(); },
    clear: function () { cache = {}; }
  };
})();
