/* goal.io — configuration layer.

   WHAT THIS IS FOR
   ----------------
   Every number that defines the game used to live as a JS literal inside
   js/core.js: the pitch, the physics, the fifteen scenarios, the weather. That
   is fine for one person editing code and hopeless for anything else — a
   designer cannot balance a level, a CMS cannot write one, and no tool can
   validate one without parsing JavaScript.

   The data now lives in config/*.json. This file applies it.

   HOW IT ATTACHES, AND WHY THAT WAY
   ---------------------------------
   It does not edit js/core.js. core.js still defines every value it always
   defined, and those remain the built-in defaults. This file loads *after* it
   and overwrites what the config actually specifies — the same wrap-don't-edit
   idiom js/render.gl.js uses on js/render.js, for the same reason: the fallback
   path stays complete and one deleted <script> tag reverts the whole thing.

   So the failure mode is mild by construction. No bundle, corrupt JSON, a
   missing key, a first run offline before the service worker has cached it —
   in every case the built-in value stands and the game boots.

   IN PLACE, NOT REASSIGNED
   ------------------------
   Objects are mutated rather than replaced. Reassigning window.PITCH would
   work for anything that reads PITCH.halfW at call time, but js/render.gl.js
   bakes pitch dimensions into its shader source as literals when it builds the
   ground program, and js/sim.js reads constants into locals. Mutating the
   object everyone already holds is the only version that is correct for both.

   Edit config/*.json, then:
       python tools/config_validate.py && python tools/config_build.py
*/
"use strict";

var CONFIG = (function () {

  var src = (typeof window !== "undefined" && window.GOALIO_CONFIG) || null;
  var applied = [];
  var skipped = [];

  /* Copy src over dst in place, keeping dst's identity. Only keys present in
     src are touched, so a partial config file is a valid config file. */
  function merge(dst, src2, name) {
    if (!dst || !src2) { skipped.push(name); return false; }
    for (var k in src2) {
      if (!src2.hasOwnProperty(k)) continue;
      if (k.charAt(0) === "$") continue;          // $note is documentation
      dst[k] = src2[k];
    }
    applied.push(name);
    return true;
  }

  /* Replace an array's contents without replacing the array. */
  function refill(arr, next, name) {
    if (!arr || !next || !next.length) { skipped.push(name); return false; }
    arr.length = 0;
    for (var i = 0; i < next.length; i++) arr.push(next[i]);
    applied.push(name);
    return true;
  }

  function applyPitch(c) {
    if (!c.pitch || typeof PITCH === "undefined") { skipped.push("pitch"); return; }
    merge(PITCH, c.pitch, "pitch");
    /* GOAL_Y and OWN_GOAL_Y are derived from halfL at load in core.js, so they
       are stale the moment the pitch changes. Every level's geometry, the
       keeper's line and the bowl are all measured from them. */
    if (typeof window !== "undefined") {
      window.GOAL_Y = -PITCH.halfL;
      window.OWN_GOAL_Y = PITCH.halfL;
    }
  }

  function applyPhysics(c) {
    var p = c.physics;
    if (!p || typeof PHYS === "undefined") { skipped.push("physics"); return; }
    var modes = p.modes, rew = p.rewindsPerLevel, ka = p.kickAnimSeconds;
    var flat = {};
    for (var k in p) {
      if (p.hasOwnProperty(k) && k !== "modes" &&
          k !== "rewindsPerLevel" && k !== "kickAnimSeconds") flat[k] = p[k];
    }
    merge(PHYS, flat, "physics");
    if (modes && typeof MODES !== "undefined") refill(MODES, modes, "modes");
    if (typeof rew === "number") window.REWINDS_PER_LEVEL = rew;
    if (typeof ka === "number") window.KICK_ANIM = ka;
  }

  function applyConditions(c) {
    if (!c.conditions) { skipped.push("conditions"); return; }
    if (c.conditions.presets && typeof CONDITIONS !== "undefined") {
      merge(CONDITIONS, c.conditions.presets, "conditions");
    }
    if (c.conditions.byLevel && typeof LEVEL_CONDITIONS !== "undefined") {
      merge(LEVEL_CONDITIONS, c.conditions.byLevel, "levelConditions");
    }
  }

  function applyLevels(c) {
    if (!c.levels) { skipped.push("levels"); return; }
    if (c.levels.seasons && typeof SEASONS !== "undefined") {
      refill(SEASONS, c.levels.seasons, "seasons");
    }
    if (c.levels.levels && typeof LEVELS !== "undefined") {
      refill(LEVELS, c.levels.levels, "levels");
    }
  }

  function applyDifficulty(c) {
    if (c.difficulty && typeof LEVEL_DIFFICULTY !== "undefined") {
      merge(LEVEL_DIFFICULTY, c.difficulty, "difficulty");
    }
  }

  /* The UI is already tokenised as CSS custom properties on :root, so restyling
     the entire game is writing a few dozen strings — no stylesheet rewriting,
     no rebuild, and it takes effect on elements that already exist. */
  function applyUI(c) {
    if (!c.ui || typeof document === "undefined") { skipped.push("ui"); return; }
    var root = document.documentElement;
    if (!root || !root.style) { skipped.push("ui"); return; }
    var n = 0, group, k;
    var groups = ["palette", "radius", "space", "other"];
    for (var g = 0; g < groups.length; g++) {
      group = c.ui[groups[g]];
      if (!group) continue;
      for (k in group) {
        if (!group.hasOwnProperty(k) || k.charAt(0) === "$") continue;
        root.style.setProperty("--" + k, group[k]);
        n++;
      }
    }
    if (n) applied.push("ui(" + n + ")");
  }

  var API = {
    /* the raw tree, for anything that wants to read config the game does not
       yet consume — audio levels are here and are not wired in yet */
    raw: src,
    applied: applied,
    skipped: skipped,
    loaded: !!src,

    get: function (path, fallback) {
      if (!src) return fallback;
      var parts = String(path).split("."), o = src;
      for (var i = 0; i < parts.length; i++) {
        if (o == null || typeof o !== "object" || !(parts[i] in o)) return fallback;
        o = o[parts[i]];
      }
      return o;
    },

    /* what actually took effect, for the console and for tests */
    report: function () {
      return { loaded: !!src, applied: applied.slice(), skipped: skipped.slice() };
    }
  };

  if (!src) {
    /* Not an error. The bundle is optional and core.js's literals are a
       complete, working game — say so once and get out of the way. */
    if (typeof console !== "undefined") {
      console.info("[config] no config/config.bundle.js — using built-in defaults");
    }
    return API;
  }

  try {
    applyPitch(src);
    applyPhysics(src);
    applyConditions(src);
    applyDifficulty(src);
    applyLevels(src);
    applyUI(src);
  } catch (e) {
    /* A broken config must never be worse than no config. Whatever applied
       before the throw stays; the rest keeps its built-in value. */
    if (typeof console !== "undefined") {
      console.error("[config] failed while applying, falling back for the rest:", e);
    }
  }

  return API;
})();
