/* headless harness — not loaded by index.html, injected manually while testing */
"use strict";

window.T = (function () {
  function kickAt(w, tx, ty, speed, m, curve) {
    var d = norm(tx - w.ball.x, ty - w.ball.y);
    w.kick(d.x, d.y, speed, MODES[m].angle, curve, m);
  }

  function play(levelIdx, plan, maxT) {
    var w = new World(LEVELS[levelIdx]);
    var t = 0, step = 1 / 120, n = 0;
    maxT = maxT || 20;
    while (t < maxT) {
      if (w.phase === "aim") {
        if (n >= plan.length) break;
        plan[n](w); n++;
      }
      if (w.phase === "over") break;
      w.update(step);
      t += step;
    }
    return { event: w.phase === "over" ? w.event : "timeout:" + w.phase, info: w.eventInfo,
             touches: w.touchesUsed, stars: w.rate(), t: +t.toFixed(2) };
  }

  function ballRun(speed, angle, spin) {
    var b = new Ball();
    var a = angle * Math.PI / 180;
    b.vy = -Math.cos(a) * speed; b.vz = Math.sin(a) * speed;
    b.spin = spin || 0; b.skid = angle > 0 ? 0 : 0.5;
    var t = 0, apex = 0, first = null;
    while (t < 12 && Math.hypot(b.vx, b.vy, b.vz) > 0.35) {
      stepBall(b, 1 / 240); t += 1 / 240;
      if (b.z > apex) apex = b.z;
      if (first === null && t > 0.02 && b.z <= 0.001 && angle > 0) first = Math.abs(b.y);
    }
    return { range: +Math.abs(b.y).toFixed(1), lateral: +b.x.toFixed(2),
             apex: +apex.toFixed(2), firstBounce: first ? +first.toFixed(1) : null };
  }

  /* ---- randomised solver: can a competent player beat this level? ---- */
  function randomAction(w) {
    var shootBias = w.ball.y < GOAL_Y + 30 ? 0.62 : 0.25;
    var mates = w.us.filter(function (p) { return p !== w.carrier; });
    if (mates.length && Math.random() > shootBias) {
      var m = mates[Math.floor(Math.random() * mates.length)];
      var lead = 0.6 + Math.random() * 2.4;
      var d = norm(m.x - w.ball.x, m.y - w.ball.y);
      kickAt(w, m.x + d.x * lead, m.y + d.y * lead,
             12 + Math.random() * 14, Math.floor(Math.random() * 3), (Math.random() - 0.5) * 1.0);
    } else {
      kickAt(w, (Math.random() * 2 - 1) * 3.5, GOAL_Y,
             19 + Math.random() * 15, Math.floor(Math.random() * 3), (Math.random() * 2 - 1));
    }
  }

  function solve(levelIdx, trials) {
    trials = trials || 500;
    var goals = 0, best = 0, evs = {}, bestPlan = null;
    for (var k = 0; k < trials; k++) {
      var w = new World(LEVELS[levelIdx]);
      var t = 0, log = [];
      while (t < 22 && w.phase !== "over") {
        if (w.phase === "aim") {
          var before = w.ball.x + "," + w.ball.y;
          randomAction(w);
          log.push(before);
        }
        w.update(1 / 120); t += 1 / 120;
      }
      var ev = w.phase === "over" ? w.event : "timeout";
      evs[ev] = (evs[ev] || 0) + 1;
      if (ev === "goal") {
        goals++;
        var s = w.rate();
        if (s > best) { best = s; bestPlan = w.touchesUsed; }
      }
    }
    return { id: LEVELS[levelIdx].id, name: LEVELS[levelIdx].name,
             winRate: +(goals / trials * 100).toFixed(1), bestStars: best,
             touchesAtBest: bestPlan, outcomes: evs };
  }

  function balance(trials) {
    var out = [];
    for (var i = 0; i < LEVELS.length; i++) out.push(solve(i, trials || 400));
    return out;
  }

  return { play: play, ballRun: ballRun, solve: solve, balance: balance, kickAt: kickAt };
})();
