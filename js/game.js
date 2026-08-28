/* goal.io — input, game loop, career flow and UI */
"use strict";

var world = null;
var screenState = "menu";        // menu | levels | story | play
var currentLevel = 0;
var mode = 0;                    // 0 ground, 1 driven, 2 chip
var drag = null;
var overTimer = 0;
var goalBeat = 0;            // seconds since the attempt finished
var replayFired = false;
var resultShown = false;
var liveScore = [0, 0];

var $ = function (id) { return document.getElementById(id); };

/* ============================== audio ==================================== */
/* The engine lives in audio.js. This is only the bridge: everything here is a
   name the presentation layer calls, so swapping a voice never touches game
   logic. audio() must be reached from inside a real gesture or the context
   stays dead — every button handler calls it first for that reason. */
function audio() { SND.unlock(); return SND.ready(); }

var SFX = {
  kick:    function (power) { SND.play("kick", power); },
  pass:    function (power) { SND.play("pass", power); },
  goal:    function () { SND.play("roar"); SND.play("sting"); },
  net:     function () { SND.play("net"); },
  save:    function () { SND.play("save"); SND.play("groan"); },
  block:   function () { SND.play("block"); },
  post:    function () { SND.play("post"); },
  bounce:  function (p) { SND.play("bounce", p); },
  fail:    function () { SND.play("groan"); },
  whistle: function (long) { SND.play("whistle", long); },
  rewind:  function () { SND.play("rewind"); },
  star:    function (i) { SND.play("star", i); },
  tap:     function () { SND.play("tap"); },
  tick:    function () { SND.play("tick"); },
  confirm: function () { SND.play("confirm"); },
  back:    function () { SND.play("back"); },
  deny:    function () { SND.play("deny"); }
};
function buzz(ms) {
  if (!Save.data.haptics) return;
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
}

/* ===================== UI plumbing (transitions, feedback) ===============
   All of this exists so a screen change is an event rather than an assignment.
   paintScreen() is the only way overlay content should ever be written. */

/* Swap the overlay's contents with an out-then-in transition, then number the
   children so the stagger CSS has something to work from. Without the numbering
   every child would animate simultaneously and the effect disappears. */
var _painting = false;
function paintScreen(html, after) {
  var host = $("ovContent");

  function put() {
    host.classList.remove("swapOut", "swapIn");
    host.innerHTML = html;
    host.classList.add("stg");
    stagger(host);
    void host.offsetWidth;
    host.classList.add("swapIn");
    if (after) after();
    _painting = false;
  }

  /* first paint of a session has nothing to transition out of */
  if (!host.innerHTML || _painting) { put(); return; }
  _painting = true;
  host.classList.add("swapOut");
  setTimeout(put, 170);
}

/* index the direct children for the stagger, skipping spacers that would
   otherwise burn a slot and leave a visible hole in the sequence */
function stagger(host, sel) {
  var kids = sel ? host.querySelectorAll(sel) : host.children;
  var n = 0;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    if (el.classList && (el.classList.contains("grow"))) continue;
    if (!el.offsetHeight && !el.children.length && !el.textContent) continue;
    el.style.setProperty("--i", n++);
  }
}

/* A ripple from the actual contact point. Centre-origin ripples feel wrong
   because the eye knows where the finger landed. */
function ripple(el, ev) {
  if (!el) return;
  var r = el.getBoundingClientRect();
  var x = (ev && ev.clientX != null ? ev.clientX : r.left + r.width / 2) - r.left;
  var y = (ev && ev.clientY != null ? ev.clientY : r.top + r.height / 2) - r.top;
  var d = Math.max(r.width, r.height) * 2.1;
  var s = document.createElement("span");
  s.className = "rip";
  s.style.width = s.style.height = d + "px";
  s.style.left = x + "px";
  s.style.top = y + "px";
  el.appendChild(s);
  setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 560);
}

/* One place to wire a tappable element: sound, haptics, ripple, then the work.
   Doing this per-listener is how press feedback ends up inconsistent. */
function tap(el, fn, sound) {
  if (!el) return;
  el.addEventListener("pointerdown", function (e) {
    audio();
    SFX[sound || "tap"]();
    buzz(8);
    ripple(el, e);
  });
  el.addEventListener("click", function (e) { fn(e); });
}

/* give every primary button its travelling specular band */
function sheenUp(host) {
  var bs = (host || document).querySelectorAll(".btn:not(.ghost)");
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].querySelector(".sheen")) continue;
    var sp = document.createElement("span");
    sp.className = "sheen";
    bs[i].insertBefore(sp, bs[i].firstChild);
  }
}

/* Count a number up to its target. Used on the result tiles — a figure that
   simply appears is information, a figure that counts is a reward. */
function countUp(el, to, dur, prefix, suffix) {
  var from = 0, t0 = performance.now();
  dur = dur || 620;
  function tick(now) {
    var p = Math.min(1, (now - t0) / dur);
    var e = 1 - Math.pow(1 - p, 3);
    el.textContent = (prefix || "") + Math.round(from + (to - from) * e) + (suffix || "");
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ============================== career flow ============================== */
function levelIndexById(id) {
  for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return i;
  return 0;
}

/* Pre-match card: competition, scoreline, clock, the story beat, the brief. */
function showStory(idx) {
  currentLevel = clamp(idx, 0, LEVELS.length - 1);
  var L = LEVELS[currentLevel];
  var S = seasonOf(L);
  screenState = "story";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");

  var newSeason = !Save.data.seenIntro[S.id];
  var intro = newSeason
    ? '<div class="panel acc"><h3>Season ' + S.id + " &middot; " + S.name + "</h3>" +
      '<div style="font-size:13px;line-height:1.6;color:#c6d4df">' + S.intro + "</div></div>"
    : "";
  if (newSeason) { Save.data.seenIntro[S.id] = 1; Save.flush(); }

  var crestA = S.club.slice(0, 2).toUpperCase(), crestB = L.opponent.slice(0, 2).toUpperCase();
  paintScreen(
    '<div class="compBar"><div class="tag"><span>' + L.comp + '</span></div>' +
      '<div class="no">MATCH ' + String(L.id).padStart(2, "0") + " / " + LEVELS.length + "</div></div>" +
    '<div class="fixture">' +
      '<div class="crest" style="background:rgba(200,255,46,.10);color:var(--acc)"><span>' + crestA + "</span></div>" +
      '<div class="club">' + S.club + "</div>" +
      '<div class="sc">' + L.score[0] + "&ndash;" + L.score[1] + "</div>" +
      '<div class="club away">' + L.opponent + "</div>" +
      '<div class="crest" style="color:var(--dim)"><span>' + crestB + "</span></div>" +
    "</div>" +
    '<div class="minRow"><div class="m">' + L.minute + "&rsquo; PLAYED</div>" +
      '<div class="n">&middot; ' + L.name + "</div></div>" +
    '<div class="story">' + L.story + "</div>" +
    intro +
    '<div class="panel acc"><h3>Your job</h3>' +
      '<div class="job">' + L.obj + "</div></div>" +
    '<div class="panel"><h3>Brief</h3><ul class="brief">' +
      '<li><span class="i">01</span><span><b>' + L.touches +
        (L.touches === 1 ? " touch</b> to score." : " touches</b> to score.") + "</span></li>" +
      '<li><span class="i">02</span><span><b>' + REWINDS_PER_LEVEL +
        " rewinds</b> — take a bad touch back instead of restarting.</span></li>" +
      '<li><span class="i">03</span><span>Third star: <b>' + bonusTextFor(L) + "</b>.</span></li>" +
    "</ul></div>" +
    (difficultyFor(L).hot
      ? '<div class="panel gold"><h3>Step up</h3><div class="job" ' +
        'style="font-size:13px;line-height:1.5">This one is a level harder than ' +
        'anything before it. Expect to use a rewind.</div></div>'
      : "") +
    '<div style="height:14px"></div>' +
    '<button class="btn" id="btnKick">KICK OFF</button>' +
    '<button class="btn ghost" id="btnBack">ALL MATCHES</button>',
  function () {
    sheenUp($("ovContent"));
    tap($("btnKick"), function () { startLevel(currentLevel); }, "confirm");
    tap($("btnBack"), function () { showLevels(); }, "back");
  });
}

function bonusTextFor(L) {
  switch (L.bonus) {
    case "curve":   return "bend the finish";
    case "chip":    return "lift it over the keeper";
    case "outside": return "score from outside the box";
    default:        return "never let the opposition touch it";
  }
}

/* COMPOSURE ranks buy extra rewinds. Applied to the World after it is built
   rather than by changing REWINDS_PER_LEVEL, so the constant stays the base
   value everything else — including the harness — reads. */
function applyCareerRewinds() {
  if (typeof CAREER === "undefined" || !world) return;
  var extra = CAREER.mods().extraRewinds || 0;
  if (extra > 0) world.rewinds += extra;
}

function startLevel(idx) {
  currentLevel = clamp(idx, 0, LEVELS.length - 1);
  var L = LEVELS[currentLevel];
  world = new World(L);
  applyCareerRewinds();
  drag = null;
  overTimer = 0;
  resultShown = false;
  liveScore = [L.score[0], L.score[1]];
  screenState = "play";
  $("overlay").classList.add("hide");
  $("result").classList.add("hide");
  $("playUI").classList.remove("hide");

  var S = seasonOf(L);
  $("hLvl").textContent = String(L.id).padStart(2, "0");
  $("hHome").textContent = S.club.slice(0, 3).toUpperCase();
  $("hAway").textContent = L.opponent.slice(0, 3).toUpperCase();
  $("hMin").textContent = L.minute + "’";
  $("objective").textContent = L.obj;
  setScore();
  setHint(L.id === 1 && !Save.data.taught
    ? "Trace the line — the curve you draw is the curve the ball takes"
    : L.tip, L.id === 1 && !Save.data.taught ? 12 : undefined);
  syncDots();
  syncRewind();
  FEEL.reset();
  resetPostMortem();
  if (typeof replayStop === "function") replayStop(world);
  goalBeat = 0;
  replayFired = false;
  /* the guided stroke, on the very first match only */
  if (L.id === 1 && !Save.data.taught) { tutorBegin(); }
  else { tutorEnd(); }
  /* conditions before the first frame, or the level opens in the wrong light */
  setCondition(conditionFor(L));
  cameraFollow(world, 0, true);
  /* the bed is what makes the stadium feel occupied — start it with the whistle */
  SND.startBed();
  SFX.whistle(false);
  if (conditionFor(L).rain) SND.play("weather", conditionFor(L).rain);
  matchIntro(L, S);
}

function setScore() { $("hScore").textContent = liveScore[0] + "-" + liveScore[1]; }

function syncDots() {
  var wrap = $("moveDots");
  wrap.innerHTML = "";
  for (var i = 0; i < world.level.touches; i++) {
    var d = document.createElement("div");
    d.className = "dot" + (i < world.touchesUsed ? " used" : "");
    wrap.appendChild(d);
  }
}

function syncRewind() {
  $("rewindCount").textContent = world.rewinds;
  $("btnRewind").classList.toggle("off", !world.canRewind());
}

var hintTimer = 0;
function setHint(t, secs) {
  $("hint").textContent = t || "";
  $("hint").style.opacity = t ? "1" : "0";
  hintTimer = secs || (t ? 5 : 0);
}

function toast(t) {
  var el = $("toast");
  el.firstChild.textContent = t;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.style.opacity = "0"; }, 1500);
}

/* ===================== match presentation (DOM) ========================== */

/* One word, punched in and released. scale lets a small event read as smaller
   than a goal without needing a second element. */
function bigWord(t, colour, scale) {
  var el = $("bigWord");
  var k = scale == null ? 1 : scale;
  el.textContent = t;
  el.style.color = colour || "#fff";
  el.style.transition = "none";
  el.style.opacity = "1";
  el.style.letterSpacing = "-0.04em";
  el.style.transform = "scale(" + (1.05 + 0.30 * k) + ") translateY(6px)";
  requestAnimationFrame(function () {
    el.style.transition = "opacity .45s ease, transform .55s cubic-bezier(.16,1.1,.24,1), letter-spacing .7s ease";
    el.style.transform = "scale(" + k + ") translateY(0)";
    el.style.letterSpacing = "0.02em";
    setTimeout(function () {
      el.style.transition = "opacity .34s ease, transform .34s ease";
      el.style.opacity = "0";
      el.style.transform = "scale(" + (k * 1.06) + ")";
    }, 760 * k + 240);
  });
}

/* The goal word. Letters arrive individually from below with a rubber ease,
   the block overshoots, then the whole thing drifts and fades. A single scaled
   div reads as a debug label no matter how you tween it — per-letter stagger
   is what makes it read as broadcast typography. */
function kineticWord(text) {
  var host = $("kinetic");
  host.innerHTML = "";
  host.classList.remove("hide");

  var wrap = document.createElement("div");
  wrap.className = "kwrap";

  var sub = document.createElement("div");
  sub.className = "ksub";
  sub.textContent = (world && world.level ? world.level.comp : "GOAL");

  for (var i = 0; i < text.length; i++) {
    var sp = document.createElement("span");
    sp.className = "kl";
    sp.textContent = text[i];
    sp.style.transitionDelay = (i * 46) + "ms";
    wrap.appendChild(sp);
  }
  host.appendChild(wrap);
  host.appendChild(sub);

  /* force a layout read so the transition actually runs from the start state */
  void host.offsetWidth;
  host.classList.add("in");

  var letters = wrap.querySelectorAll(".kl");
  Array.prototype.forEach.call(letters, function (l, i) {
    setTimeout(function () { SFX.tick(); }, i * 46);
  });

  clearTimeout(host._out);
  host._out = setTimeout(function () {
    host.classList.add("out");
    setTimeout(function () {
      host.classList.remove("in", "out");
      host.classList.add("hide");
      host.innerHTML = "";
    }, 620);
  }, 1500);
}

/* Full-frame bloom. Two layers: a fast white pop and a slow coloured wash, so
   it reads as light rather than as an opacity animation. */
function flashScreen(amount, dur) {
  var f = $("flash");
  f.style.transition = "none";
  f.style.opacity = String(amount == null ? 0.85 : amount);
  requestAnimationFrame(function () {
    f.style.transition = "opacity " + (dur || 0.5) + "s cubic-bezier(.2,.7,.3,1)";
    f.style.opacity = "0";
  });
}
function flash() { flashScreen(0.55, 0.6); }

/* The scoreline changing is a beat in itself — flip the old digit out and the
   new one in, and pulse the bug so the eye is pulled to it. */
function scorebugFlip() {
  var sc = $("hScore");
  sc.classList.remove("flip");
  void sc.offsetWidth;
  liveScore[0]++;
  setTimeout(function () { setScore(); }, 150);
  sc.classList.add("flip");
  var bug = $("scorebug");
  bug.classList.remove("hit"); void bug.offsetWidth; bug.classList.add("hit");
}

/* Kickoff card: competition, fixture, minute. Sits over the pitch for a beat
   so a match starts like a broadcast rather than simply appearing. */
function matchIntro(L, S) {
  var el = $("intro");
  el.innerHTML =
    '<div class="icomp">' + L.comp + "</div>" +
    '<div class="ifix"><span class="ih">' + S.club.slice(0, 3).toUpperCase() +
      '</span><span class="isc">' + L.score[0] + "&ndash;" + L.score[1] + "</span>" +
      '<span class="ia">' + L.opponent.slice(0, 3).toUpperCase() + "</span></div>" +
    '<div class="imin">' + L.minute + "&rsquo; &middot; " + L.name + "</div>" +
    '<div class="ibar"><i></i></div>';
  el.classList.remove("hide", "out");
  void el.offsetWidth;
  el.classList.add("in");
  clearTimeout(el._t);
  el._t = setTimeout(function () {
    el.classList.add("out");
    setTimeout(function () { el.classList.add("hide"); el.classList.remove("in", "out"); }, 520);
  }, 1450);
}

/* ============================== result =================================== */
var RESULT_TITLES = {
  goal: "GOAL!", save: "SAVED", blocked: "BLOCKED", wide: "MISSED",
  out: "OUT OF PLAY", lost: "LOST IT", outoftouches: "OUT OF TOUCHES"
};

function showResult() {
  resultShown = true;
  var goal = world.event === "goal";
  var stars = world.rate();
  var L = world.level;

  /* Stars land one at a time, each with its own pitch. Three stars appearing
     together is a status read-out; three stars arriving in sequence is a
     reward, and it is the single most re-playable moment in the loop. */
  var el = $("stars");
  el.innerHTML = "";
  for (var i = 0; i < 3; i++) {
    var sp = document.createElement("span");
    sp.className = i < stars ? "star-on" : "star-off";
    sp.textContent = "★";
    el.appendChild(sp);
  }
  (function (nodes) {
    for (var k = 0; k < nodes.length; k++) {
      (function (node, idx) {
        setTimeout(function () {
          node.classList.add("land");
          if (idx < stars) { SFX.star(idx); buzz(12); }
        }, 260 + idx * 230);
      })(nodes[k], k);
    }
  })(el.querySelectorAll("span"));

  $("resTitle").textContent = RESULT_TITLES[world.event] || "OVER";
  $("resTitle").style.color = goal ? "var(--acc)" : "var(--bad)";

  var sub;
  if (goal) {
    sub = stars < 3 ? "For the third star: " + bonusTextFor(L) + "."
                    : "Perfect. Nothing left on the table.";
  } else {
    sub = world.eventInfo || "Have another go.";
    if (world.canRewind()) sub += " Rewind puts the ball back for the last touch.";
  }
  $("resSub").textContent = sub;

  $("resStats").innerHTML =
    '<div class="tile' + (goal ? " hl" : "") + '"><div class="v">' +
      liveScore[0] + "-" + liveScore[1] + '</div><div class="k">SCORE</div></div>' +
    '<div class="tile"><div class="v">' + world.touchesUsed + " / " + L.touches +
      '</div><div class="k">TOUCHES</div></div>' +
    '<div class="tile"><div class="v">' + world.rewinds +
      '</div><div class="k">REWINDS LEFT</div></div>';

  /* XP ON THE RESULT CARD.

     A progression system the player never sees land is a number in
     localStorage. The breakdown matters more than the total: "UNDER PAR +40"
     teaches what the game rewards, which is the only thing that will make
     anyone replay a match they have already won. */
  var xpHost = $("resXp");
  if (xpHost) {
    if (award && award.total) {
      var rows = "";
      for (var xi = 0; xi < award.lines.length; xi++) {
        rows += '<div class="xpRow"><span>' + award.lines[xi].label +
                '</span><b>+' + award.lines[xi].xp + "</b></div>";
      }
      rows += '<div class="xpRow xpTotal"><span>TOTAL</span><b>+' +
              award.total + " XP</b></div>";
      if (award.levelsGained > 0) {
        rows += '<div class="lvlUp">LEVEL ' + award.level + " &middot; " +
                award.levelsGained + " SKILL POINT" +
                (award.levelsGained > 1 ? "S" : "") + "</div>";
      }
      for (var ai = 0; ai < award.achievements.length; ai++) {
        rows += '<div class="lvlUp">' + award.achievements[ai].name + "</div>";
      }
      xpHost.innerHTML = rows;
      xpHost.classList.remove("hide");
      xpHost.classList.add("stg");
      stagger(xpHost, ".xpRow, .lvlUp");
    } else {
      xpHost.innerHTML = "";
      xpHost.classList.add("hide");
    }
  }

  var last = currentLevel >= LEVELS.length - 1;
  var bNext = $("btnNext"), bAgain = $("btnAgain"), bRw = $("btnResRewind");

  if (goal) {
    bNext.style.display = "flex";
    bNext.textContent = last ? "FINISH CAREER" : "NEXT MATCH";
    bAgain.textContent = stars < 3 ? "REPLAY FOR 3 STARS" : "PLAY AGAIN";
    bRw.style.display = "none";
  } else {
    bNext.style.display = "none";
    bRw.style.display = world.canRewind() ? "flex" : "none";
    bRw.textContent = "REWIND · " + world.rewinds + " LEFT";
    bAgain.textContent = "RESTART MATCH";
  }

  /* CAREER. Recorded before Save.record so "first clear" can still see that
     this level had no stars a moment ago. */
  var award = null;
  if (typeof CAREER !== "undefined") {
    if (goal) {
      award = CAREER.award(L.id, stars, world, Save.starsFor(L.id) === 0);
    }
    CAREER.recordAttempt(goal);
  }
  if (goal) Save.record(L.id, stars);
  $("result").classList.remove("hide");
  var rc = $("result");
  rc.classList.remove("in"); void rc.offsetWidth; rc.classList.add("in");
  sheenUp(rc);
  stagger(rc.querySelector("#resStats"), ".tile");

  /* count the headline figures up rather than printing them */
  var tiles = rc.querySelectorAll("#resStats .tile .v");
  if (tiles[1]) countUp(tiles[1], world.touchesUsed, 520, "", " / " + L.touches);
  if (tiles[2]) countUp(tiles[2], world.rewinds, 460);
}

function doRewind() {
  if (!world || !world.canRewind()) return;
  if (typeof replayStop === "function") replayStop(world);
  world.rewind();
  resultShown = false;
  overTimer = 0;
  drag = null;
  $("result").classList.add("hide");
  liveScore = [world.level.score[0], world.level.score[1]];
  setScore();
  syncDots();
  syncRewind();
  SFX.rewind();
  buzz(15);
  toast("Rewound — take that touch again");
  cameraFollow(world, 0, true);
}

/* ============================== input =================================== */
function localPoint(e) {
  var t = e.touches && e.touches.length ? e.touches[0] : e;
  return { x: t.clientX, y: t.clientY };
}

function beginDrag(e) {
  if (screenState !== "play" || !world || world.phase !== "aim") return;
  audio();
  /* the moment they touch, the lesson is over and never returns */
  if (TUTOR.on) { tutorEnd(); Save.data.taught = 1; Save.flush(); }
  var p = localPoint(e);
  var g = screenToGround(p.x, p.y);
  if (!g) return;                       // finger is on or above the horizon
  drag = {
    startX: p.x, startY: p.y,
    /* the stroke is anchored at the ball, so your thumb never covers it */
    offX: world.ball.x - g.x, offY: world.ball.y - g.y,
    pts: [{ x: world.ball.x, y: world.ball.y }],
    power: 0, curve: 0, dir: { x: 0, y: -1 }, speed: 0, length: 0,
    targetMate: null, preview: null
  };
  updateDrag(e);
}

function updateDrag(e) {
  if (!drag) return;
  var p = localPoint(e);
  var g = screenToGround(p.x, p.y);
  if (!g) return;
  var wx = g.x + drag.offX, wy = g.y + drag.offY;

  var last = drag.pts[drag.pts.length - 1];
  if (dist(last.x, last.y, wx, wy) > 0.55) {
    drag.pts.push({ x: wx, y: wy });
    if (drag.pts.length > 140) drag.pts.shift();
  } else {
    drag.pts[drag.pts.length - 1] = { x: wx, y: wy };
  }
  computeKick();
}

/* turn the drawn line into launch direction, power and spin */
function computeKick() {
  var pts = drag.pts, b = world.ball;
  var end = pts[pts.length - 1];
  var chordLen = dist(b.x, b.y, end.x, end.y);
  drag.length = chordLen;

  if (chordLen < 1.2) { drag.power = 0; drag.speed = 0; drag.preview = null; return; }

  var chord = norm(end.x - b.x, end.y - b.y);

  /* launch along the tangent of the first part of the stroke — the spin does the rest */
  var tanIdx = Math.max(1, Math.floor(pts.length * 0.22));
  var tp = pts[Math.min(tanIdx, pts.length - 1)];
  var tan = norm(tp.x - b.x, tp.y - b.y);
  if (dist(b.x, b.y, tp.x, tp.y) < 0.4) tan = chord;
  var dir = norm(tan.x * 0.62 + chord.x * 0.38, tan.y * 0.62 + chord.y * 0.38);

  /* spin from how far the stroke bows away from the straight line */
  var maxDev = 0;
  for (var i = 1; i < pts.length - 1; i++) {
    var s = chord.x * (pts[i].y - b.y) - chord.y * (pts[i].x - b.x);
    var along = chord.x * (pts[i].x - b.x) + chord.y * (pts[i].y - b.y);
    if (along < 0 || along > chordLen) continue;
    if (Math.abs(s) > Math.abs(maxDev)) maxDev = s;
  }
  var curve = clamp(maxDev / Math.max(3, chordLen * 0.30), -1, 1);

  var M = MODES[mode];
  var speed = Math.min(clamp(6.5 + chordLen * 0.95, PHYS.MIN_SPEED, PHYS.MAX_SPEED) * M.powerMul,
                       PHYS.MAX_SPEED);

  /* CAREER SKILLS.

     Applied here, to the kick as it is constructed, and nowhere else. Nothing
     below this reaches js/sim.js, so the ball physics and the keeper are
     identical at every career level and T.balance() — which drives
     world.kick() directly — still measures the base game. Every skill only
     ever helps, so no spend can strand a player on a level. */
  var CM = (typeof CAREER !== "undefined") ? CAREER.mods()
                                           : { speedMul: 1, curveMul: 1, passRadius: 0 };
  speed = Math.min(speed * CM.speedMul, PHYS.MAX_SPEED);
  curve = clamp(curve * CM.curveMul, -1, 1);

  drag.dir = dir;
  drag.curve = curve * M.curveMul;
  drag.speed = speed;
  drag.power = clamp((speed - PHYS.MIN_SPEED) / (PHYS.MAX_SPEED - PHYS.MIN_SPEED), 0, 1);

  drag.targetMate = null;
  for (var k = 0; k < world.us.length; k++) {
    var m = world.us[k];
    if (m === world.carrier) continue;
    if (dist(end.x, end.y, m.x, m.y) < 2.4 + CM.passRadius) { drag.targetMate = m; break; }
  }

  var ghost = b.copy();
  var a = M.angle * Math.PI / 180;
  ghost.vx = dir.x * Math.cos(a) * speed;
  ghost.vy = dir.y * Math.cos(a) * speed;
  ghost.vz = Math.sin(a) * speed;
  ghost.spin = drag.curve;
  ghost.skid = M.angle > 0 ? 0 : 0.5;
  drag.preview = predictPath(ghost, 2.0, 1 / 50);
}

function endDrag() {
  if (!drag) return;
  var d = drag;
  drag = null;
  if (!world || world.phase !== "aim") return;
  if (d.speed <= 0 || d.length < 1.2) return;

  world.kick(d.dir.x, d.dir.y, d.speed, MODES[mode].angle, d.curve, mode);
  /* turf kicked up at the point of contact */
  /* turf lifted at the contact point, plus a couple of bright scuff sparks so
     the moment of contact has a highlight to catch the eye */
  fxBurst(world.ball.x, world.ball.y, 0.05, 8 + Math.round(d.power * 11),
          { speed: 1.8 + d.power * 3.2, up: 1.7, life: 0.40, r: 0.030,
            col: "148,182,104", grav: 11 });
  fxBurst(world.ball.x, world.ball.y, 0.07, 3 + Math.round(d.power * 4),
          { speed: 3.2 + d.power * 3.4, up: 1.2, life: 0.20, r: 0.018,
            col: "255,248,222", grav: 6, glow: 1 });
  CROWD_SURGE = Math.max(CROWD_SURGE, 0.22 + d.power * 0.3);
  cameraPunch(d.targetMate ? 0.16 + d.power * 0.20 : 0.30 + d.power * 0.45);
  if (d.targetMate) { FEEL.pass(d.power); SFX.pass(d.power); }
  else              { FEEL.strike(d.power); SFX.kick(d.power); }
  impactRing(world.ball.x, world.ball.y, d.power);
  syncDots();
  syncRewind();
  setHint("");
  if (Math.abs(d.curve) > 0.5) toast("Whipped it — watch it bend");
}

function bindInput() {
  var c = $("game");
  c.addEventListener("touchstart", function (e) { e.preventDefault(); beginDrag(e); }, { passive: false });
  c.addEventListener("touchmove", function (e) { e.preventDefault(); updateDrag(e); }, { passive: false });
  c.addEventListener("touchend", function (e) { e.preventDefault(); endDrag(); }, { passive: false });
  c.addEventListener("touchcancel", function () { drag = null; });
  c.addEventListener("mousedown", beginDrag);
  window.addEventListener("mousemove", function (e) { if (drag) updateDrag(e); });
  window.addEventListener("mouseup", function () { if (drag) endDrag(); });

  Array.prototype.forEach.call(document.querySelectorAll(".mode"), function (el) {
    tap(el, function () {
      mode = parseInt(el.getAttribute("data-mode"), 10);
      Save.data.mode = mode; Save.flush();
      syncModes();
      if (drag) computeKick();
    }, "tick");
  });

  tap($("btnRetry"), function () { startLevel(currentLevel); });
  tap($("btnRewind"), function () { doRewind(); }, "rewind");
  tap($("btnMenu"), function () { showLevels(); }, "back");
  tap($("btnAgain"), function () { startLevel(currentLevel); }, "confirm");
  $("btnResRewind").addEventListener("click", function () { doRewind(); });
  $("btnNext").addEventListener("click", function () {
    SFX.tap();
    if (currentLevel >= LEVELS.length - 1) showFinale();
    else showStory(currentLevel + 1);
  });

  window.addEventListener("keydown", function (e) {
    if (e.key === "1" || e.key === "2" || e.key === "3") {
      mode = parseInt(e.key, 10) - 1; syncModes(); if (drag) computeKick();
    }
    if (screenState !== "play") return;
    if (e.key.toLowerCase() === "r") startLevel(currentLevel);
    if (e.key.toLowerCase() === "z") doRewind();
  });
}

function syncModes() {
  Array.prototype.forEach.call(document.querySelectorAll(".mode"), function (el) {
    el.classList.toggle("on", parseInt(el.getAttribute("data-mode"), 10) === mode);
  });
}

/* ============================== settings ================================= */

/* A row that toggles. Written as a real control rather than a checkbox so it
   matches the rest of the card language. */
function toggleRow(id, label, sub, on) {
  return '<div class="panel" style="margin-top:8px;display:flex;align-items:center;gap:14px">' +
    '<div style="flex:1">' +
      '<div style="font-size:13.5px;font-weight:800;letter-spacing:-.005em">' + label + '</div>' +
      '<div style="font-size:10.5px;color:var(--dim);margin-top:3px;line-height:1.45">' + sub + '</div>' +
    '</div>' +
    '<div id="' + id + '" class="tgl' + (on ? " on" : "") + '"><i></i></div>' +
  '</div>';
}

function showSettings(back) {
  screenState = "settings";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");

  var total = Save.totalStars(), max = LEVELS.length * 3;

  paintScreen(
    '<div class="brandRow"><div class="brandSlash"></div>' +
      '<div class="brand" style="font-size:30px">SETTINGS</div></div>' +
    '<div class="kicker">AUDIO &middot; FEEDBACK &middot; PROGRESS</div>' +

    toggleRow("tgSound", "Crowd &amp; effects", "Stadium bed, impacts and the roar.", Save.data.sound) +
    toggleRow("tgHaptic", "Haptics", "Vibration on contact, saves and goals.", Save.data.haptics) +

    '<div class="panel"><h3>Progress</h3>' +
      '<div class="progRow" style="margin-top:0"><span>CAREER</span><b>' +
        total + " / " + max + " STARS</b></div>" +
      '<div class="prog gold"><i style="width:' + Math.round(total / max * 100) + '%"></i></div>' +
      '<div style="font-size:11px;color:var(--dim);margin-top:12px;line-height:1.5">' +
        "Resetting clears every star and re-locks the career. It cannot be undone." +
      "</div></div>" +
    '<button class="btn danger" id="btnWipe">RESET PROGRESS</button>' +
    '<div class="grow"></div>' +
    '<button class="btn ghost" id="btnSetBack">BACK</button>',
  function () {
    sheenUp($("ovContent"));

    function bindToggle(id, get, set) {
      var el = $(id);
      tap(el, function () {
        set(get() ? 0 : 1);
        el.classList.toggle("on", !!get());
        Save.flush();
      }, "tick");
    }
    bindToggle("tgSound", function () { return Save.data.sound; },
      function (v) { Save.data.sound = v; SND.enable(!!v); });
    bindToggle("tgHaptic", function () { return Save.data.haptics; },
      function (v) { Save.data.haptics = v; if (v) buzz(14); });

    /* two-step, because a single tap on a destructive control is a bug report */
    var armed = false;
    tap($("btnWipe"), function () {
      var b = $("btnWipe");
      if (!armed) {
        armed = true;
        b.textContent = "TAP AGAIN TO CONFIRM";
        toast("This will erase every star");
        setTimeout(function () {
          if (!armed) return;
          armed = false; b.textContent = "RESET PROGRESS";
        }, 3200);
        return;
      }
      armed = false;
      Save.data.stars = {}; Save.data.unlocked = 1; Save.data.seenIntro = {};
      Save.flush();
      toast("Career reset");
      showMenu();
    }, "deny");

    tap($("btnSetBack"), function () { (back || showMenu)(); }, "back");
  });
}

/* ============================== screens ================================= */

/* ======================================================================== */
/* CAREER SCREEN                                                            */
/* ======================================================================== */

/* Built from the same classes every other screen uses — panel, progRow, prog,
   tile, btn — so it inherits the design tokens rather than introducing a
   second visual language. The only new CSS is the skill row and the
   achievement chip, both in index.html. */
function showCareer(back) {
  screenState = "career";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");

  var D = CAREER.data;
  var pct = Math.round(CAREER.levelProgress() * 100);
  var nextXp = CAREER.xpForLevel(D.level + 1);
  var curXp = CAREER.xpForLevel(D.level);
  var into = Math.max(0, D.xp - curXp), need = Math.max(1, nextXp - curXp);

  /* ---- skills ---- */
  var ids = CAREER.skillIds(), skillHtml = "";
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], def = CAREER.skillDef(id), rank = D.skills[id] || 0;
    var max = def.max || 5, pips = "";
    for (var p = 0; p < max; p++) {
      pips += '<i class="' + (p < rank ? "on" : "") + '"></i>';
    }
    var can = CAREER.canSpend(id);
    skillHtml +=
      '<div class="skill">' +
        '<div class="sk-main">' +
          '<div class="sk-name">' + def.name + '<span class="sk-rank">' + rank + " / " + max + "</span></div>" +
          '<div class="sk-desc">' + def.desc + "</div>" +
          '<div class="sk-pips">' + pips + "</div>" +
        "</div>" +
        '<button class="sk-add' + (can ? "" : " off") + '" data-skill="' + id + '"' +
          (can ? "" : " disabled") + ">+</button>" +
      "</div>";
  }

  /* ---- achievements ---- */
  var list = CAREER.achievements(), achHtml = "", got = 0;
  for (var a = 0; a < list.length; a++) {
    var A = list[a], has = !!D.ach[A.id];
    if (has) got++;
    achHtml +=
      '<div class="ach' + (has ? " on" : "") + '">' +
        '<div class="ach-t">' + A.name + "</div>" +
        '<div class="ach-d">' + A.desc + "</div>" +
      "</div>";
  }

  var st = D.stats;
  var acc = st.attempts ? Math.round(st.goals / st.attempts * 100) : 0;

  paintScreen(
    '<div class="brandRow"><div class="brandSlash"></div>' +
      '<div class="brand" style="font-size:30px">CAREER</div></div>' +
    '<div class="kicker">LEVEL ' + D.level + " &middot; " + D.xp.toLocaleString() + " XP</div>" +

    '<div class="panel">' +
      '<div class="progRow" style="margin-top:0"><span>LEVEL ' + D.level +
        '</span><b>' + into.toLocaleString() + " / " + need.toLocaleString() + " XP</b></div>" +
      '<div class="prog gold"><i style="width:' + pct + '%"></i></div>' +
      '<div class="progRow" style="margin-top:11px"><span>NEXT</span>' +
        '<b style="font-size:11px;letter-spacing:.12em">LEVEL ' + (D.level + 1) + "</b></div>" +
    "</div>" +

    '<div class="tiles">' +
      '<div class="tile"><div class="v">' + st.goals + '</div><div class="k">GOALS</div></div>' +
      '<div class="tile"><div class="v">' + st.threeStars + '</div><div class="k">3-STAR</div></div>' +
      '<div class="tile"><div class="v">' + acc + '%</div><div class="k">CONVERSION</div></div>' +
      '<div class="tile"><div class="v">' + st.bestStreak + '</div><div class="k">BEST RUN</div></div>' +
    "</div>" +

    '<div class="panel"><h3>Skills' +
      (D.sp > 0 ? '<span class="sp">' + D.sp + " POINT" + (D.sp > 1 ? "S" : "") + "</span>" : "") +
      "</h3>" + skillHtml + "</div>" +

    '<div class="panel"><h3>Achievements<span class="sp dim">' + got + " / " + list.length + "</span></h3>" +
      '<div class="achGrid">' + achHtml + "</div></div>" +

    '<div class="grow"></div>' +
    '<button class="btn ghost" id="btnCarBack">BACK</button>',
  function () {
    sheenUp($("ovContent"));
    var adds = $("ovContent").querySelectorAll(".sk-add");
    for (var k = 0; k < adds.length; k++) {
      (function (btn) {
        if (btn.disabled) return;
        tap(btn, function () {
          if (CAREER.spend(btn.getAttribute("data-skill"))) {
            SFX.star(1); buzz(14);
            showCareer(back);            /* repaint: ranks, pips and points all move */
          }
        }, "confirm");
      })(adds[k]);
    }
    tap($("btnCarBack"), function () { (back || showMenu)(); });
  });
}

function showMenu() {
  screenState = "menu";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");

  var resume = Math.min(Save.data.unlocked, LEVELS.length);
  var total = Save.totalStars(), max = LEVELS.length * 3;
  var pct = Math.round(total / max * 100);
  var L = LEVELS[levelIndexById(resume)];
  var S = seasonOf(L);

  paintScreen(
    '<div class="brandRow"><div class="brandSlash"></div><div class="brand">goal.io</div></div>' +
    '<div class="kicker">SWIPE FOOTBALL &middot; 15 MATCHES &middot; 3 SEASONS</div>' +

    '<div class="tiles">' +
      '<div class="tile hl"><div class="v">' + total + "</div><div class=\"k\">STARS</div></div>" +
      '<div class="tile"><div class="v">' + String(resume).padStart(2, "0") +
        '</div><div class="k">NEXT UP</div></div>' +
      '<div class="tile"><div class="v">' + pct + '%</div><div class="k">COMPLETE</div></div>' +
    "</div>" +

    '<div class="panel"><div class="progRow"><span>CAREER PROGRESS</span><b>' +
      total + " / " + max + "</b></div>" +
      '<div class="prog"><i style="width:' + pct + '%"></i></div>' +
      '<div class="progRow" style="margin-top:11px"><span>' + S.name +
        '</span><b style="font-size:11px;letter-spacing:.12em">' + S.club + "</b></div></div>" +

    '<div class="grow"></div>' +
    '<button class="btn" id="btnPlay">' +
      (Save.data.unlocked > 1 ? "CONTINUE" : "START CAREER") + "</button>" +
    '<button class="btn ghost" id="btnLevels">ALL MATCHES</button>' +
    '<button class="btn ghost" id="btnCareer">CAREER</button>' +
    '<button class="btn ghost" id="btnHow">HOW TO PLAY</button>' +
    '<button class="btn ghost" id="btnSettings">SETTINGS</button>' +
    '<div id="howBox"></div>',
  function () {
  sheenUp($("ovContent"));
  tap($("btnPlay"), function () { showStory(levelIndexById(resume)); }, "confirm");
  tap($("btnLevels"), function () { showLevels(); });
  tap($("btnCareer"), function () { showCareer(showMenu); });
  tap($("btnSettings"), function () { showSettings(showMenu); });
  tap($("btnHow"), function () {
    var box = $("howBox");
    if (box.innerHTML) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="panel"><h3>Controls</h3><ul class="brief">' +
      '<li><span class="i">01</span><span><b>Drag anywhere</b> — the line grows from the ball, so your thumb never covers it.</span></li>' +
      '<li><span class="i">02</span><span><b>Longer drag, more power.</b> The arc by the ball is your meter.</span></li>' +
      '<li><span class="i">03</span><span><b>Curve the line</b> and the ball bends that way in flight.</span></li>' +
      '<li><span class="i">04</span><span><b>Ground / Driven / Chip</b> sets how it is struck.</span></li>' +
      '<li><span class="i">05</span><span>End the line <b>on a teammate</b> to pass.</span></li>' +
      '<li><span class="i">06</span><span><b>Rewind</b> takes back one bad touch, three per match.</span></li>' +
      '<li><span class="i">07</span><span>The white dots preview only the <b>first part</b> of the flight.</span></li>' +
      "</ul></div>";
    box.classList.add("stg");
    stagger(box.querySelector(".brief") || box, "li");
  });
  });
}

function showLevels() {
  screenState = "levels";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");

  var total = Save.totalStars(), max = LEVELS.length * 3;
  var html =
    '<div class="brandRow"><div class="brandSlash"></div>' +
      '<div class="brand" style="font-size:30px">MATCHES</div></div>' +
    '<div class="kicker">' + total + " / " + max + " STARS COLLECTED</div>" +
    '<div class="prog" style="margin-top:12px"><i style="width:' +
      Math.round(total / max * 100) + '%"></i></div>';

  SEASONS.forEach(function (S) {
    var sMax = LEVELS.filter(function (L) { return L.season === S.id; }).length * 3;
    html += '<div class="seasonBar">' +
        '<div class="num">' + String(S.id).padStart(2, "0") + "</div>" +
        '<div class="txt"><div class="s">' + S.name + '</div><div class="c">' + S.club + "</div></div>" +
        '<div class="st">' + Save.seasonStars(S.id) + "/" + sMax + " &#9733;</div></div>" +
      '<div class="levelGrid" data-season="' + S.id + '"></div>';
  });
  html += '<div style="height:16px"></div><button class="btn ghost" id="btnHome">MAIN MENU</button>';
  paintScreen(html, function () { buildLevelGrid(); });
}

function buildLevelGrid() {
  SEASONS.forEach(function (S) {
    var grid = $("ovContent").querySelector('.levelGrid[data-season="' + S.id + '"]');
    LEVELS.forEach(function (L, i) {
      if (L.season !== S.id) return;
      var locked = L.id > Save.data.unlocked;
      var st = Save.starsFor(L.id);
      /* the next playable match is highlighted, so the eye always lands on
         where the player is up to rather than on the whole grid at once */
      var isNext = !locked && st === 0 && L.id === Save.data.unlocked;
      var d = difficultyFor(L);
      var pips = "";
      for (var pi = 0; pi < 3; pi++) {
        pips += '<i class="' + (pi < d.band ? (d.hot ? "hot" : "on") : "") + '"></i>';
      }

      var b = document.createElement("button");
      b.className = "lvl" + (locked ? " locked" : "") + (st > 0 ? " done" : "") +
                    (isNext ? " next" : "");
      b.innerHTML = '<div class="edge"></div>' +
        '<div class="diff">' + pips + "</div>" +
        '<div class="n">' + (locked ? "&#128274;" : String(L.id).padStart(2, "0")) + "</div>" +
        '<div class="st">' + (st ? new Array(st + 1).join("★") : "") + "</div>" +
        '<div class="t">' + L.name + "</div>";
      b.style.setProperty("--i", grid.children.length);
      if (!locked) tap(b, function () { showStory(i); }, "confirm");
      else tap(b, function () { toast("Win match " + (L.id - 1) + " to unlock this"); }, "deny");
      grid.appendChild(b);
    });
  });
  tap($("btnHome"), function () { showMenu(); }, "back");
}

function showFinale() {
  screenState = "levels";
  $("overlay").classList.remove("hide");
  $("playUI").classList.add("hide");
  $("result").classList.add("hide");
  var total = Save.totalStars(), max = LEVELS.length * 3;
  paintScreen(
    '<div style="height:26px"></div>' +
    '<div class="brandRow"><div class="brandSlash"></div>' +
      '<div class="brand" style="font-size:34px">CAREER<br>COMPLETE</div></div>' +
    '<div class="kicker">SUNDAY LEAGUE TO A EUROPEAN CUP FINAL</div>' +
    '<div class="tiles">' +
      '<div class="tile hl"><div class="v">' + total + '</div><div class="k">STARS</div></div>' +
      '<div class="tile"><div class="v">' + LEVELS.length + '</div><div class="k">MATCHES</div></div>' +
      '<div class="tile"><div class="v">' + Math.round(total / max * 100) +
        '%</div><div class="k">COMPLETE</div></div>' +
    "</div>" +
    '<p class="lede">Fifteen touches of genius. Go back for the stars you left behind.</p>' +
    '<div style="height:16px"></div>' +
    '<button class="btn" id="btnLv2">ALL MATCHES</button>' +
    '<button class="btn ghost" id="btnHome2">MAIN MENU</button>',
  function () {
    sheenUp($("ovContent"));
    tap($("btnLv2"), function () { showLevels(); }, "confirm");
    tap($("btnHome2"), function () { showMenu(); }, "back");
  });
}

/* ============================== loop ==================================== */
var lastT = 0, acc = 0;
var STEP = 1 / 120;

function frame(ts) {
  requestAnimationFrame(frame);
  if (!lastT) lastT = ts;
  var dt = Math.min(0.05, (ts - lastT) / 1000);
  lastT = ts;
  /* before checkResize: the adaptive pass can move the pixel ratio, and
     checkResize is what notices and resizes the canvases to match */
  if (typeof RES !== "undefined") RES.tick(ts, screenState === "play" && !!world);
  checkResize();

  if (hintTimer > 0) {
    hintTimer -= dt;
    if (hintTimer <= 0) $("hint").style.opacity = "0";
  }

  if (screenState !== "play" || !world) return;

  /* FEEL owns time. world.slowmo is the sim asking for drama; the director
     decides the curve, so hit-stop and slow motion can never fight. */
  if (world.slowmo > 0) { world.slowmo = 0; FEEL.slowmo(1.5, 0.26); }
  var scale = FEEL.stepTime(dt);
  FEEL.step(dt, world);

  acc += dt * scale;
  var guard = 0;
  while (acc >= STEP && guard++ < 12) {
    var before = world.phase;
    world.update(STEP);
    acc -= STEP;
    if (before !== "over" && world.phase === "over") onLevelOver();
    if (before === "live" && world.phase === "aim") { syncDots(); }
  }
  /* drain after stepping so a cue raised mid-substep is felt on this frame */
  FEEL.drainCues(world);
  if (acc > 0.25) acc = 0;

  cameraFollow(world, dt, false);
  renderWorld(world, drag, dt);

  if (world.phase === "over" && !resultShown) {
    overTimer -= dt;
    goalBeat += dt;
    /* the replay fires once, after the celebration has had its moment */
    if (world.event === "goal" && !replayFired && goalBeat > 2.6) {
      replayFired = true;
      if (replayStart(world)) { SND.swell(0.20, 2.4, 0.06); }
    }
    if (overTimer <= 0) {
      if (typeof replayStop === "function") replayStop(world);
      showResult();
    }
  }
}

function onLevelOver() {
  var e = world.event;
  /* a goal now has a timeline to play out — hold the result card back for it */
  /* a failure now has a post-mortem to read, so it gets longer on screen */
  /* A goal now plays out as: camera beats (0 - 1.3 s), celebration (to 2.6 s),
     replay (2.6 - 4.9 s), then the result card. A miss holds long enough to
     read the post-mortem. */
  overTimer = e === "goal" ? 5.3 : 2.35;
  goalBeat = 0;
  replayFired = false;
  if (e === "goal") {
    /* scorebugFlip owns the increment so the digit change is animated */
    netHit(world.goalX || 0, world.goalZ || 0.6);
    CROWD_SURGE = 1.0;
    /* Three layers instead of one cloud of identical circles. A single burst of
       46 fat pale dots at close range reads as lens bokeh, not as an impact:
       what sells it is a fast bright spark shower, a slower drifting dust, and
       a puff of chalk off the line. All small — the old radius filled a third
       of the frame once the goal camera moved in close. */
    var gx = world.goalX || 0, gz = world.goalZ || 0.6;
    fxBurst(gx, GOAL_Y + 0.35, gz, 26,
            { speed: 8.4, up: 3.2, life: 0.44, r: 0.030,
              col: "255,250,214", grav: 12, glow: 1 });
    fxBurst(gx, GOAL_Y + 0.5, gz, 16,
            { speed: 2.6, up: 1.7, life: 1.10, r: 0.019,
              col: "226,238,250", grav: 1.6 });
    fxBurst(gx, GOAL_Y + 0.1, 0.06, 12,
            { speed: 2.2, up: 2.4, life: 0.70, r: 0.024,
              col: "236,240,232", grav: 7 });
    SFX.goal();
    FEEL.goal(world);
    scorebugFlip();
  } else if (e === "save") {
    CROWD_SURGE = Math.max(CROWD_SURGE, 0.6);
    fxBurst(world.ball.x, world.ball.y, world.ball.z + 0.1, 14,
            { speed: 3.4, up: 2.2, life: 0.42, r: 0.024,
              col: "225,235,245", glow: 1 });
    bigWord("SAVED", "#ffcc3d", 0.9);
  } else if (e === "blocked") {
    bigWord("BLOCKED", "#ff8a3d", 0.8);
  } else {
    SFX.fail();
    SFX.whistle(true);
  }
}

/* ============================== boot ==================================== */
/* Boot, with the splash held until there is genuinely something to show.

   The steps below are cheap, so the honest total is a few tens of
   milliseconds. The splash is not there to disguise a slow load — it is there
   so the first thing on screen is the game's own mark rather than a white
   flash and then a menu popping into existence. It holds for a minimum beat
   for that reason, and no longer.

   Each step reports progress, and the crowd table is built here rather than
   lazily on the first rendered frame: 5,200 entries plus a sort is the one
   piece of startup work heavy enough to cause a visible hitch, and it used to
   happen on whichever frame first drew a stand. */
(function boot() {
  var bar = document.getElementById("bootBar");
  var stat = document.getElementById("bootStat");
  var t0 = Date.now();

  function step(pct, label) {
    if (bar) bar.style.width = pct + "%";
    if (stat && label) stat.textContent = label;
  }

  step(12, "LOADING");
  Save.load();
  if (typeof CAREER !== "undefined") CAREER.load();
  mode = Save.data.mode || 0;

  step(34, "PITCH");
  initRender();

  step(58, "CROWD");
  /* pay for the crowd table now, not mid-match */
  if (typeof crowdData === "function") crowdData();

  step(78, "CONTROLS");
  bindInput();
  syncModes();

  step(94, "READY");
  showMenu();
  requestAnimationFrame(frame);

  /* hold the splash for a moment so it reads as a title card, not a flicker */
  var held = Math.max(0, 620 - (Date.now() - t0));
  setTimeout(function () {
    step(100, "READY");
    var b = document.getElementById("boot");
    if (!b) return;
    b.classList.add("gone");
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 700);
  }, held);
})();
