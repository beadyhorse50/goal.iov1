/* goal.io — career progression: XP, levels, skills, achievements, stats.

   WHAT THIS DELIBERATELY IS NOT
   -----------------------------
   The brief asks for contracts, transfers and training alongside XP and
   skills. Those belong to a squad game — Football Manager and Top Eleven have
   a squad, a fixture list and an opposition model to make a transfer mean
   something. This game is fifteen authored moments with one player in them.
   Bolting a transfer market onto that would be feature theatre: menus that
   move numbers nothing reads.

   What DOES fit, and is what Score Hero actually does, is a career told
   through the season structure the game already has — three clubs, fifteen
   matches, progression that changes how the ball behaves in your hands. So
   this is XP, levels, four skills that genuinely alter play, achievements, and
   a career record. Contracts arrive as the season gates that already exist.

   WHY THE SKILLS CANNOT BREAK BALANCE
   -----------------------------------
   Every skill acts either when the kick is CONSTRUCTED (js/game.js
   computeKick) or when a level STARTS. None of them reach inside js/sim.js,
   the ball physics or the keeper. Two consequences, both deliberate:

     - T.balance() drives world.kick() directly, so it still measures the base
       game. A level that is winnable in the harness is winnable at career
       level 1 with no skills spent.
     - Every skill only ever helps. Spending a point cannot make a level
       harder, so no build can strand a player.

   Persistence is separate from Save in js/core.js and survives its reset, so
   clearing level progress does not wipe a career. Both are localStorage and
   both fail silently in private mode — an unsaved career still plays.
*/
"use strict";

var CAREER = (function () {

  var KEY = "goalio.career.v1";

  var DEFAULTS = {
    xp: 0,
    level: 1,
    sp: 0,                       // unspent skill points
    skills: { power: 0, curve: 0, vision: 0, composure: 0 },
    stats: {
      goals: 0, attempts: 0, threeStars: 0, cleanWins: 0,
      curveGoals: 0, chipGoals: 0, outsideGoals: 0,
      streak: 0, bestStreak: 0, seasonsDone: 0
    },
    ach: {}                      // id -> unix ms unlocked
  };

  var data = clone(DEFAULTS);
  var lastAward = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function cfg(path, fallback) {
    if (typeof CONFIG === "undefined" || !CONFIG.get) return fallback;
    var v = CONFIG.get("progression." + path, undefined);
    return v === undefined ? fallback : v;
  }

  /* ------------------------------------------------------------ persistence */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          data.xp = d.xp || 0;
          data.level = d.level || 1;
          data.sp = d.sp || 0;
          /* merge rather than replace, so a skill added to the config later
             appears at rank 0 on an existing save instead of undefined */
          for (var k in DEFAULTS.skills) {
            if (DEFAULTS.skills.hasOwnProperty(k)) {
              data.skills[k] = (d.skills && d.skills[k]) || 0;
            }
          }
          for (var s in DEFAULTS.stats) {
            if (DEFAULTS.stats.hasOwnProperty(s)) {
              data.stats[s] = (d.stats && d.stats[s]) || 0;
            }
          }
          data.ach = d.ach || {};
        }
      }
    } catch (e) { /* private mode — play unsaved */ }
    return data;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ level */
  /* Total XP required to REACH level n. Level 1 is free. */
  function xpForLevel(n) {
    if (n <= 1) return 0;
    var base = cfg("level.base", 260), ex = cfg("level.exponent", 1.55);
    return Math.round(base * Math.pow(n - 1, ex));
  }

  function levelForXp(xp) {
    var max = cfg("level.max", 40), n = 1;
    while (n < max && xp >= xpForLevel(n + 1)) n++;
    return n;
  }

  /* How far through the current level, 0..1 — the progress bar's only input. */
  function levelProgress() {
    var cur = xpForLevel(data.level), next = xpForLevel(data.level + 1);
    if (next <= cur) return 1;
    return Math.max(0, Math.min(1, (data.xp - cur) / (next - cur)));
  }

  /* ------------------------------------------------------------- achievements */
  function achList() { return cfg("achievements", []) || []; }

  function statValue(name) {
    if (name === "level") return data.level;
    return data.stats[name] || 0;
  }

  /* Returns the ones that unlocked on this call, so the UI can announce them. */
  function checkAchievements() {
    var list = achList(), out = [], now = Date.now();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (data.ach[a.id]) continue;
      if (statValue(a.stat) >= a.target) {
        data.ach[a.id] = now;
        out.push(a);
      }
    }
    /* Achievement XP is granted without re-entering award(), because an
       achievement that pushed you over a level boundary would otherwise
       recurse through checkAchievements and could unlock a level achievement
       mid-iteration over the list it is mutating. */
    var gained = 0;
    for (var k = 0; k < out.length; k++) gained += out[k].xp || 0;
    if (gained) {
      data.xp += gained;
      data.level = levelForXp(data.xp);
    }
    return out;
  }

  /* ---------------------------------------------------------------- awarding */
  /* Called once when a level is completed with a goal. `world` is the finished
     World, so the flags it already tracks (usedCurve, usedChip,
     shotFromOutside) become career stats without the sim knowing about any of
     this. */
  function award(levelId, stars, world, isFirstClear) {
    var X = cfg("xp", {}) || {};
    var lines = [], total = 0;

    function add(label, amount) {
      if (!amount) return;
      lines.push({ label: label, xp: amount });
      total += amount;
    }

    add("GOAL", X.goal || 100);
    add(stars + (stars === 1 ? " STAR" : " STARS"), (X.perStar || 60) * stars);
    if (world && world.level && world.touchesUsed <= world.level.par) {
      add("UNDER PAR", X.underPar || 40);
    }
    if (world && world.rewinds === REWINDS_PER_LEVEL) add("NO REWIND", X.noRewind || 50);
    if (isFirstClear) add("FIRST CLEAR", X.firstClear || 120);

    /* ---- stats ---- */
    var st = data.stats;
    st.goals++;
    st.streak++;
    if (st.streak > st.bestStreak) st.bestStreak = st.streak;
    if (stars >= 3) st.threeStars++;
    if (world && world.rewinds === REWINDS_PER_LEVEL) st.cleanWins++;
    if (world && world.usedCurve) st.curveGoals++;
    if (world && world.usedChip) st.chipGoals++;
    if (world && world.shotFromOutside) st.outsideGoals++;

    /* A season counts as done when every level in it has at least one star. */
    st.seasonsDone = seasonsCompleted();

    var before = data.level;
    data.xp += total;
    data.level = levelForXp(data.xp);

    var unlocked = checkAchievements();
    var gained = data.level - before;
    if (gained > 0) data.sp += gained * cfg("level.skillPointsPerLevel", 1);

    save();
    lastAward = {
      lines: lines, total: total, levelsGained: gained,
      level: data.level, achievements: unlocked
    };
    return lastAward;
  }

  /* A miss breaks the scoring streak and nothing else. */
  function recordAttempt(scored) {
    data.stats.attempts++;
    if (!scored) data.stats.streak = 0;
    save();
  }

  function seasonsCompleted() {
    if (typeof LEVELS === "undefined" || typeof Save === "undefined") return 0;
    var seasons = {}, done = 0, id;
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i];
      if (!seasons[L.season]) seasons[L.season] = { total: 0, cleared: 0 };
      seasons[L.season].total++;
      if (Save.starsFor(L.id) > 0) seasons[L.season].cleared++;
    }
    for (id in seasons) {
      if (seasons.hasOwnProperty(id) && seasons[id].total &&
          seasons[id].cleared === seasons[id].total) done++;
    }
    return done;
  }

  /* ------------------------------------------------------------------ skills */
  function skillDef(id) {
    var all = cfg("skills", {}) || {};
    return all[id] || null;
  }

  function skillIds() {
    var all = cfg("skills", {}) || {}, out = [];
    for (var k in all) {
      if (all.hasOwnProperty(k) && k.charAt(0) !== "$") out.push(k);
    }
    return out;
  }

  function canSpend(id) {
    var d = skillDef(id);
    if (!d) return false;
    return data.sp > 0 && (data.skills[id] || 0) < (d.max || 5);
  }

  function spend(id) {
    if (!canSpend(id)) return false;
    data.skills[id] = (data.skills[id] || 0) + 1;
    data.sp--;
    save();
    return true;
  }

  /* THE ONLY THING THE GAME READS DURING PLAY.

     Returns plain multipliers and additions. js/game.js applies them where the
     kick is built; nothing here is visible to js/sim.js. */
  function mods() {
    var s = data.skills;
    function rank(id) { return s[id] || 0; }
    function per(id, dflt) {
      var d = skillDef(id);
      return d && d.perRank != null ? d.perRank : dflt;
    }
    return {
      speedMul: 1 + rank("power") * per("power", 0.02),
      curveMul: 1 + rank("curve") * per("curve", 0.06),
      passRadius: rank("vision") * per("vision", 0.35),
      extraRewinds: Math.floor(rank("composure") * per("composure", 0.5))
    };
  }

  /* -------------------------------------------------------------------- api */
  return {
    load: load,
    save: save,
    award: award,
    recordAttempt: recordAttempt,
    mods: mods,
    spend: spend,
    canSpend: canSpend,
    skillDef: skillDef,
    skillIds: skillIds,
    xpForLevel: xpForLevel,
    levelProgress: levelProgress,
    achievements: achList,
    seasonsCompleted: seasonsCompleted,
    lastAward: function () { return lastAward; },
    get data() { return data; },
    /* the settings screen already offers a two-step progress reset; this is
       the career half of it, kept separate so one does not silently take the
       other with it */
    reset: function () {
      data = clone(DEFAULTS);
      save();
    }
  };
})();
