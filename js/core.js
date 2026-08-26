/* goal.io — core: geometry, maths, career data, persistence
   Pitch is in real metres. Origin = centre spot.
   x: -34 (left touchline) .. +34 (right touchline)
   y: -52.5 (the goal you ATTACK, top of screen) .. +52.5 (your own goal)
*/
"use strict";

var PITCH = {
  halfW: 34,          // 68m wide
  halfL: 52.5,        // 105m long
  goalHalf: 3.66,     // 7.32m mouth
  crossbar: 2.44,
  sixHalf: 9.16,      // six-yard box
  sixDepth: 5.5,
  boxHalf: 20.16,     // penalty area
  boxDepth: 16.5,
  penSpot: 11,
  arcR: 9.15,
  centreR: 9.15,
  cornerR: 1
};
var GOAL_Y = -PITCH.halfL;         // line we attack
var OWN_GOAL_Y = PITCH.halfL;

/* ---------------- physics constants (tuned to real football values) ------- */
var PHYS = {
  G: 9.81,
  BALL_R: 0.112,          // size 5 ball
  AIR_K: 0.010,           // quadratic drag, accel = AIR_K * v^2 (~0.43kg ball)
  ROLL_DECEL: 2.3,        // m/s^2 rolling resistance on cut grass (drag on top)
  SKID_DECEL: 1.6,        // extra decel while skidding, before it settles to a roll
  CURVE_K: 0.42,          // Magnus: lateral accel = CURVE_K * spin * speed
  CURVE_GROUND: 0.4,      // curve is weaker once the ball is rolling
  SPIN_DECAY: 0.62,       // per second (multiplicative)
  BOUNCE: 0.55,
  BOUNCE_FRICTION: 0.76,
  MAX_SPEED: 34,          // ~122 km/h, a rocket
  MIN_SPEED: 7
};

/* launch angles per strike type */
var MODES = [
  { name: "GROUND", angle: 0,  powerMul: 1.00, curveMul: 1.00 },
  { name: "DRIVEN", angle: 9,  powerMul: 1.14, curveMul: 0.85 },
  { name: "CHIP",   angle: 29, powerMul: 0.86, curveMul: 0.70 }
];

var REWINDS_PER_LEVEL = 3;
var KICK_ANIM = 0.42;        // seconds of strike animation after a touch

/* ---------------- small maths ---------------- */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function dist2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
function norm(x, y) { var m = Math.hypot(x, y) || 1; return { x: x / m, y: y / m }; }
function rnd(a, b) { return a + Math.random() * (b - a); }
function sign(v) { return v < 0 ? -1 : 1; }

function inBoxAttacking(x, y) {
  return Math.abs(x) <= PITCH.boxHalf && y <= GOAL_Y + PITCH.boxDepth && y >= GOAL_Y;
}

/* ---------------- career ----------------
   Three seasons. Levels run continuously, Score! Hero style: each one is a
   freeze-frame of a real match moment with a scoreline and a clock.
     ball   : [x, y]
     mates  : [x, y, shirtNumber]
     foes   : [x, y]
     gk     : [x, y]
     par    : touches needed for the second star
     bonus  : third-star condition — 'curve' | 'outside' | 'chip' | 'clean'
*/
var SEASONS = [
  { id: 1, name: "SUNDAY LEAGUE", club: "HACKNEY MARSH", kit: "#f4fbff",
    intro: "Nineteen, no contract, and a trial that lasts ninety minutes. Marsh have never been past the fourth round. Give them a reason to keep you." },
  { id: 2, name: "THE CHAMPIONSHIP", club: "REDBRIDGE CITY", kit: "#7ce8ff",
    intro: "City paid forty grand for you and the fans want to know why. Second tier, thirty thousand a week through the turnstiles, and a manager who does not rate you yet." },
  { id: 3, name: "EUROPE", club: "ATLÉTICO LISBOA", kit: "#ffd23d",
    intro: "A number ten shirt, a new language, and a continent watching. This is the one you told everyone you would reach." }
];

/* CONDITIONS.

   Fifteen matches in identical bright sunshine is the single cheapest-looking
   thing a football game can do, and it is free to fix: the renderer already
   grades the turf, the sky and the crowd, so all it needs is a set of numbers
   to grade them differently. Each level names a condition; the renderer looks
   it up and everything downstream follows.

     light    overall exposure, 1 = bright afternoon
     warm     colour temperature of the key light, 1 = golden, 0 = blue
     flood    how much the floodlights contribute, 1 = they are doing the work
     wet      surface sheen and darkening
     rain     0 none, 1 heavy
     haze     how quickly distance washes out
     sky      zenith / mid / horizon colours

   Weather is presentation only. It never touches the ball. */
/* WHERE THE SUN IS, per condition.

   `sunEl` is elevation in degrees above the horizon, `sunAz` the compass
   bearing measured from +X toward +Y. Until now there was one hard-coded light
   vector for every match in the game, which meant a golden-hour kick-off and a
   midweek afternoon threw identical shadows in identical directions -- the
   single biggest reason the conditions felt like colour filters rather than
   like different times of day.

   Elevation is the interesting number. It sets shadow length, it sets how much
   direct light a standing figure catches, and below about 25 degrees the roof
   of the west stand starts throwing a band across the grass, which is the most
   recognisable lighting event in televised football. Golden hour is set low
   enough to get that band; the afternoon is not. */
var CONDITIONS = {
  afternoon: { light: 1.00, warm: 0.55, flood: 0.10, wet: 0.00, rain: 0, haze: 1.00,
               sunEl: 40, sunAz: 128,
               sky: ["#1f4f78", "#77b1cf", "#e2edee"] },
  goldenHour:{ light: 0.96, warm: 1.00, flood: 0.25, wet: 0.00, rain: 0, haze: 1.25,
               /* Chosen from the geometry, not by eye. The shooting camera sees
                  only about +/-7 m of pitch width, so a shadow band along a
                  touchline can never enter the frame -- the edge has to run
                  ACROSS the pitch, which means the sun has to sit behind the
                  camera and low. At 9 degrees the stand's roof lip throws its
                  edge to about y = -35: the foreground turf falls into shade,
                  the goalmouth stays in the last of the light, and the striker
                  is standing on the line between them. Anything above about 11
                  degrees puts that edge behind the camera and the whole effect
                  is invisible. */
               sunEl: 9, sunAz: 105,
               sky: ["#243f6b", "#b3763f", "#f5cf9a"] },
  overcast:  { light: 0.88, warm: 0.18, flood: 0.30, wet: 0.18, rain: 0, haze: 1.45,
               sunEl: 34, sunAz: 142,
               sky: ["#43505c", "#7c8a94", "#c3ccd1"] },
  rain:      { light: 0.80, warm: 0.10, flood: 0.55, wet: 0.72, rain: 1, haze: 1.75,
               sunEl: 27, sunAz: 155,
               sky: ["#2e3944", "#5b6874", "#98a4ad"] },
  night:     { light: 0.66, warm: 0.30, flood: 1.00, wet: 0.10, rain: 0, haze: 0.85,
               sunEl: 33, sunAz: 205,
               sky: ["#070b14", "#0e1626", "#1d2a3c"] },
  nightRain: { light: 0.62, warm: 0.20, flood: 1.00, wet: 0.78, rain: 1, haze: 1.30,
               sunEl: 31, sunAz: 212,
               sky: ["#060910", "#101a28", "#1f2c3a"] }
};

/* Which condition each match is played in, by level id. Chosen as an arc:
   Sunday league in daylight, the Championship grinding through winter, Europe
   under lights. */
var LEVEL_CONDITIONS = {
  1: "afternoon", 2: "afternoon", 3: "goldenHour", 4: "overcast",  5: "rain",
  6: "afternoon", 7: "overcast",  8: "rain",       9: "goldenHour", 10: "night",
  11:"night",     12:"nightRain", 13:"night",      14:"nightRain",  15:"night"
};

/* DIFFICULTY, measured rather than guessed.

   These bands come from T.balance(300) win rates on random input — not from
   how hard a level feels to design. Random play is not human play, but the
   RATIO between levels is meaningful, and it is brutal: level 6 sits at 26%
   and level 13 at 0.7%, a 37x spread with nothing in the interface telling the
   player a step up is coming. That is the difference between a hard game and
   one that feels broken.

   band: 1 = comfortable, 2 = testing, 3 = hard.
   hot:  an outlier the player should be warned about explicitly. */
var LEVEL_DIFFICULTY = {
  1:  { band: 1, hot: 0 },   /* 9.7% */
  2:  { band: 2, hot: 0 },   /* 4.0% */
  3:  { band: 2, hot: 0 },   /* 4.7% */
  4:  { band: 1, hot: 0 },   /* 14.3% */
  5:  { band: 3, hot: 0 },   /* 3.7% */
  6:  { band: 1, hot: 0 },   /* 26.3% */
  7:  { band: 1, hot: 0 },   /* 10.0% */
  8:  { band: 2, hot: 0 },   /* 7.7% */
  9:  { band: 3, hot: 1 },   /* 1.0% */
  10: { band: 3, hot: 1 },   /* 1.3% */
  11: { band: 3, hot: 0 },   /* 2.7% */
  12: { band: 2, hot: 0 },   /* 6.0% */
  13: { band: 3, hot: 1 },   /* 0.7% */
  14: { band: 2, hot: 0 },   /* 5.3% */
  15: { band: 2, hot: 0 }    /* 5.7% */
};

function difficultyFor(level) {
  return LEVEL_DIFFICULTY[level.id] || { band: 2, hot: 0 };
}

function conditionFor(level) {
  return CONDITIONS[LEVEL_CONDITIONS[level.id] || "afternoon"] || CONDITIONS.afternoon;
}

var LEVELS = [
  /* ---------------- SEASON 1 — SUNDAY LEAGUE ---------------- */
  {
    id: 1, season: 1, name: "DEBUT", opponent: "LEYTON VALE", comp: "COUNTY CUP R1",
    minute: 88, score: [0, 0],
    story: "Eighty-eight minutes on the bench, two minutes to matter. The ball drops to you on the edge of the D.",
    obj: "Beat the keeper from the edge of the D",
    tip: "Drag anywhere — the line grows from the ball. Longer drag, more power.",
    touches: 1, par: 1, bonus: "clean",
    ball: [0, -31], mates: [], foes: [], gk: [0, -50.5]
  },
  {
    id: 2, season: 1, name: "OVER THE WALL", opponent: "DAGENHAM ROAD", comp: "LEAGUE",
    minute: 71, score: [1, 1],
    story: "Free kick, twenty-six yards, three big lads in the wall and a keeper who fancies himself.",
    obj: "Bend a free kick around the wall",
    tip: "Draw a CURVED line — the ball follows your arc. Straight into the wall gets blocked.",
    touches: 1, par: 1, bonus: "curve",
    ball: [0, -26], mates: [], foes: [[-1.7, -35.2], [0, -35.2], [1.7, -35.2]], gk: [0.6, -50.6]
  },
  {
    id: 3, season: 1, name: "ONE-TWO", opponent: "BARKING ATHLETIC", comp: "LEAGUE",
    minute: 34, score: [0, 1],
    story: "A goal down and the midfield is a swamp. Your winger has made the run. Use him.",
    obj: "Play the give-and-go, then finish",
    tip: "End your line ON a teammate to pass. They take the next touch.",
    touches: 2, par: 2, bonus: "clean",
    ball: [-11, -26], mates: [[7, -32, 10]], foes: [[-8, -32], [2, -37]], gk: [0, -50.4]
  },
  {
    id: 4, season: 1, name: "THE DINK", opponent: "LEYTON VALE", comp: "COUNTY CUP QF",
    minute: 62, score: [1, 1],
    story: "Their keeper has spent all afternoon on the edge of his box. Punish him.",
    obj: "Lift it over the sweeper keeper",
    tip: "Tap CHIP to loft it. Too much power and it clears the bar.",
    touches: 1, par: 1, bonus: "chip",
    ball: [1, -34], mates: [], foes: [], gk: [0.5, -42]
  },
  {
    id: 5, season: 1, name: "ON THE BREAK", opponent: "ILFORD TOWN", comp: "COUNTY CUP SF",
    minute: 90, score: [1, 1],
    story: "Their corner, cleared to you on the halfway line. Everything is in front of you. Go.",
    obj: "Three touches to punish the counter",
    tip: "Defenders react and chase. Move it before they close you down.",
    touches: 3, par: 3, bonus: "clean",
    ball: [-16, -8], mates: [[10, -18, 7], [-2, -26, 9]], foes: [[-6, -18], [8, -30], [-14, -33]],
    gk: [0, -50.3]
  },

  /* ---------------- SEASON 2 — THE CHAMPIONSHIP ---------------- */
  {
    id: 6, season: 2, name: "TIGHT ANGLE", opponent: "STOKELY", comp: "LEAGUE",
    minute: 12, score: [0, 0],
    story: "First start for City. You have chased a lost cause to the byline and kept it in.",
    obj: "Score from the byline",
    tip: "Barely any goal to aim at. Bend it back across the keeper.",
    touches: 1, par: 1, bonus: "clean",
    ball: [15.5, -47], mates: [], foes: [[10.5, -44]], gk: [-1.2, -50.2]
  },
  {
    id: 7, season: 2, name: "WHIPPED IN", opponent: "NORTH END", comp: "LEAGUE",
    minute: 55, score: [0, 1],
    story: "You are on the left, your nine is unmarked at the back post and screaming for it.",
    obj: "Cross it, then attack the knock-down",
    tip: "CHIP the cross onto his head, then finish what comes off it.",
    touches: 2, par: 2, bonus: "curve",
    ball: [-22, -40], mates: [[3, -45, 9]], foes: [[-14, -42], [1, -47.5]], gk: [0, -50.8]
  },
  {
    id: 8, season: 2, name: "CROWDED HOUSE", opponent: "WEALDSTONE PARK", comp: "LEAGUE",
    minute: 79, score: [1, 1],
    story: "They have put eleven men behind the ball for twenty minutes. Find the one gap.",
    obj: "Thread it through a packed box",
    tip: "Every lane is covered. Find the gap — or bend one open.",
    touches: 2, par: 2, bonus: "clean",
    ball: [-4, -27], mates: [[9, -38, 11]], foes: [[-9, -33], [-2, -34], [5, -33.5], [11, -43]],
    gk: [0, -50.5]
  },
  {
    id: 9, season: 2, name: "FROM DISTANCE", opponent: "GRANGEMOOR", comp: "FA CUP R4",
    minute: 45, score: [0, 0],
    story: "No angle, no runners, and the whole ground telling you to shoot.",
    obj: "Score from outside the area",
    tip: "DRIVEN gives you a low, rising ball that keepers hate.",
    touches: 1, par: 1, bonus: "outside",
    ball: [-6, -24], mates: [], foes: [[-5, -30], [0, -31.5]], gk: [-0.5, -49.5]
  },
  {
    id: 10, season: 2, name: "DERBY DAY", opponent: "EAST LONDON", comp: "LEAGUE",
    minute: 90, score: [1, 2],
    story: "Ninety minutes gone, a goal down in the derby. This is what they bought you for.",
    obj: "Win the derby. Four touches.",
    tip: "The whole back line is home. Keep it moving and pick your moment.",
    touches: 4, par: 3, bonus: "clean",
    ball: [-20, 4], mates: [[14, -12, 7], [-3, -24, 10], [18, -34, 11]],
    foes: [[-12, -10], [3, -20], [-10, -30], [12, -30], [0, -40]], gk: [0, -50.4]
  },

  /* ---------------- SEASON 3 — EUROPE ---------------- */
  {
    id: 11, season: 3, name: "FIRST NIGHT", opponent: "SPARTA NORD", comp: "EUROPEAN CUP GRP",
    minute: 23, score: [0, 0],
    story: "European debut. Sixty thousand people who have never heard of you.",
    obj: "Announce yourself. Two touches.",
    tip: "Their line is high and flat. Play through it, not around it.",
    touches: 2, par: 2, bonus: "clean",
    ball: [-9, -18], mates: [[8, -28, 7], [-14, -30, 11]],
    foes: [[-4, -26], [6, -27], [-11, -35], [2, -38]], gk: [0, -50.4]
  },
  {
    id: 12, season: 3, name: "OUTSIDE OF THE BOOT", opponent: "REAL ANDALUZ", comp: "LEAGUE",
    minute: 67, score: [1, 1],
    story: "Marked tight, back to goal, and the only route to the corner is around a man.",
    obj: "Bend one in from a standing start",
    tip: "Heavy curve, low power. Let the spin do the work.",
    touches: 1, par: 1, bonus: "curve",
    ball: [9, -30], mates: [], foes: [[7.5, -34], [10.5, -34.5]], gk: [1.5, -50.5]
  },
  {
    id: 13, season: 3, name: "BACKS TO THE WALL", opponent: "SPARTA NORD", comp: "EUROPEAN CUP QF",
    minute: 85, score: [0, 1],
    story: "Away goal needed, eighty-five gone, and the clearance drops to you inside your own half.",
    obj: "The length of the pitch. Four touches.",
    tip: "Long driven passes travel further than you think. Use your runners.",
    touches: 4, par: 3, bonus: "clean",
    ball: [-4, 22], mates: [[16, -4, 7], [-16, -14, 11], [2, -30, 9]],
    foes: [[-2, 8], [14, -8], [-13, -22], [4, -26], [-6, -38]], gk: [0, -50.3]
  },
  {
    id: 14, season: 3, name: "NINETY-FOURTH", opponent: "OLYMPIA TURIN", comp: "EUROPEAN CUP SF",
    minute: 94, score: [1, 1],
    story: "Fourth minute of four added on. Aggregate level. The next touch decides the tie.",
    obj: "Two touches. Nothing less than a goal.",
    tip: "They are all behind the ball and they know a shot is coming.",
    touches: 2, par: 2, bonus: "clean",
    ball: [-12, -33], mates: [[6, -40, 9]],
    foes: [[-8, -37], [-1, -38.5], [4, -36], [9, -44], [-4, -45]], gk: [0, -50.6]
  },
  {
    id: 15, season: 3, name: "THE FINAL", opponent: "REAL ANDALUZ", comp: "EUROPEAN CUP FINAL",
    minute: 89, score: [1, 1],
    story: "You said you would be here. Eighty-nine minutes, level, and the ball is yours.",
    obj: "Win it. Everything you have learned.",
    tip: "Full defence, best keeper you have faced. Make one of them wrong.",
    touches: 4, par: 3, bonus: "clean",
    ball: [-18, -6], mates: [[13, -16, 7], [-5, -27, 10], [17, -37, 11]],
    foes: [[-11, -13], [4, -21], [-9, -31], [11, -32], [-2, -40], [6, -42]], gk: [0, -50.5]
  }
];

function seasonOf(level) {
  for (var i = 0; i < SEASONS.length; i++) if (SEASONS[i].id === level.season) return SEASONS[i];
  return SEASONS[0];
}

/* ---------------- persistence ---------------- */
var SAVE_KEY = "goalio.save.v2";
var Save = {
  /* sound/haptics default ON, and both persist — mobile play is often in
     public and a game with no mute is a one-star review */
  data: { stars: {}, unlocked: 1, mode: 0, seenIntro: {}, sound: 1, haptics: 1, taught: 0 },
  load: function () {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          this.data.stars = d.stars || {};
          this.data.unlocked = d.unlocked || 1;
          this.data.mode = d.mode || 0;
          this.data.seenIntro = d.seenIntro || {};
          this.data.sound = d.sound === undefined ? 1 : d.sound;
          this.data.haptics = d.haptics === undefined ? 1 : d.haptics;
          this.data.taught = d.taught || 0;
        }
      }
    } catch (e) { /* private mode / storage disabled — play unsaved */ }
    return this.data;
  },
  flush: function () {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) {}
  },
  starsFor: function (id) { return this.data.stars[id] || 0; },
  record: function (id, stars) {
    if (stars > this.starsFor(id)) this.data.stars[id] = stars;
    if (id + 1 > this.data.unlocked) this.data.unlocked = Math.min(id + 1, LEVELS.length);
    this.flush();
  },
  totalStars: function () {
    var t = 0, k;
    for (k in this.data.stars) t += this.data.stars[k];
    return t;
  },
  seasonStars: function (sid) {
    var t = 0;
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].season === sid) t += this.starsFor(LEVELS[i].id);
    return t;
  }
};
