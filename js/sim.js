/* goal.io — simulation: ball flight, player movement, defender & keeper AI */
"use strict";

/* =========================================================================
   BALL
   ========================================================================= */
function Ball() { this.reset(); }

Ball.prototype.reset = function () {
  this.x = 0; this.y = 0; this.z = 0;
  this.vx = 0; this.vy = 0; this.vz = 0;
  this.spin = 0;      // -1 .. 1, positive bends to the ball's right
  this.skid = 0;      // seconds of skidding left before it settles into a roll
  this.rot = 0;       // visual roll angle
  this.live = false;
  this.trail = [];
};

Ball.prototype.speed = function () { return Math.hypot(this.vx, this.vy); };

Ball.prototype.copy = function (o) {
  o = o || new Ball();
  o.x = this.x; o.y = this.y; o.z = this.z;
  o.vx = this.vx; o.vy = this.vy; o.vz = this.vz;
  o.spin = this.spin; o.skid = this.skid;
  return o;
};

/* One physics step. Returns nothing — mutates the ball. */
function stepBall(b, dt) {
  var airborne = b.z > 0.01 || b.vz > 0.01;
  var sp = Math.hypot(b.vx, b.vy);

  if (airborne) {
    var v3 = Math.hypot(b.vx, b.vy, b.vz) || 0.0001;
    var k = PHYS.AIR_K * v3;                 // |a| = AIR_K * v^2, applied per-axis
    b.vx -= k * b.vx * dt;
    b.vy -= k * b.vy * dt;
    b.vz -= k * b.vz * dt;
    b.vz -= PHYS.G * dt;
  } else if (sp > 0.01) {
    /* rolling: grass resistance + skid + the same air drag it feels in flight */
    var dec = (PHYS.ROLL_DECEL + (b.skid > 0 ? PHYS.SKID_DECEL : 0) + PHYS.AIR_K * sp * sp) * dt;
    var ns = Math.max(0, sp - dec);
    b.vx *= ns / sp; b.vy *= ns / sp;
    if (b.skid > 0) b.skid -= dt;
  } else {
    b.vx = 0; b.vy = 0;
  }

  /* Magnus force — sideways acceleration proportional to spin and speed */
  if (sp > 1 && Math.abs(b.spin) > 0.001) {
    var nx = -b.vy / sp, ny = b.vx / sp;     // left-hand normal
    var mag = PHYS.CURVE_K * b.spin * sp * (airborne ? 1 : PHYS.CURVE_GROUND);
    b.vx += nx * mag * dt;
    b.vy += ny * mag * dt;
  }

  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  if (b.z < 0) {
    b.z = 0;
    if (b.vz < -0.6) {
      b.vz = -b.vz * PHYS.BOUNCE;
      b.vx *= PHYS.BOUNCE_FRICTION;
      b.vy *= PHYS.BOUNCE_FRICTION;
      b.spin *= 0.7;
      b.skid = 0.35;
    } else {
      b.vz = 0;
    }
  }

  b.spin *= Math.pow(PHYS.SPIN_DECAY, dt);
  b.rot += Math.hypot(b.vx, b.vy, b.vz) * dt * 0.9;
}

/* Sample the ball's future flight. Used by the AI and by the aim preview. */
function predictPath(ball, seconds, dt, spinScale) {
  dt = dt || 1 / 60;
  var b = ball.copy();
  if (spinScale !== undefined) b.spin *= spinScale;
  var out = [], t = 0;
  while (t < seconds) {
    stepBall(b, dt);
    t += dt;
    out.push({ x: b.x, y: b.y, z: b.z, t: t, sp: Math.hypot(b.vx, b.vy) });
    if (b.y < GOAL_Y - 1 || Math.abs(b.x) > PITCH.halfW + 1 || b.y > PITCH.halfL + 1) break;
    if (Math.hypot(b.vx, b.vy) < 0.4 && b.z < 0.05) break;
  }
  return out;
}

/* =========================================================================
   PLAYERS
   ========================================================================= */
function Player(x, y, team, role, num) {
  this.x = x; this.y = y;
  this.hx = x; this.hy = y;          // home / spawn position
  this.vx = 0; this.vy = 0;
  this.team = team;                  // 'us' | 'them'
  this.role = role || "out";         // 'out' | 'gk'
  this.num = num || 0;
  this.face = -Math.PI / 2;
  this.maxSpeed = role === "gk" ? 5.4 : (team === "us" ? 7.35 : 7.15);
  this.accel = role === "gk" ? 16 : 13.5;
  this.react = 0;                    // seconds still to elapse before reacting
  this.tx = x; this.ty = y;          // steering target
  this.anim = Math.random() * 6.28;
  this.dive = 0;                     // keeper: 0..1 dive progress
  this.diveDir = 0;
  this.committed = false;
  this.readX = 0;
  this.stumble = 0;
  this.errX = 0; this.errY = 0; this.lag = 0.1;   // how badly they read the flight
  this.kickT = 0;                                 // strike animation timer
  this.receiveT = 0;                              // first-touch cushion timer
  this.kickPower = 0.7;                           // scales wind-up/follow-through
  this.kickMode = 1;                              // 0 ground 1 driven 2 chip
  this.kickIsPass = false;
}

Player.prototype.speed = function () { return Math.hypot(this.vx, this.vy); };

Player.prototype.moveTo = function (x, y) { this.tx = x; this.ty = y; };

/* STRIDE PHASE CONSTANT.

   The run cycle's clock is driven by distance travelled, not wall time, so the
   feet do not change speed independently of the player. That was already true
   — but the constant was wrong, which is why the feet slid anyway.

   Measured from the rig rather than guessed: over one run cycle the planted
   ankle is within 4 cm of the ground for 22% of the cycle, and during that
   window it sweeps 0.441 m backwards relative to the body at 2.033 m per clip
   second. For the foot to stay stuck to the turf, the body must advance at
   exactly that rate, which puts this constant at 4.28 and the distance per
   cycle at 2.03 m (about a metre a step).

   The old value of 1.5 gave 5.8 m per cycle — the body travelled 2.85x further
   than the feet did, so they skated at roughly two thirds of running speed.

   If the run clip's leg swing is ever re-authored, re-measure this. The number
   is a property of the clip, not a preference. */
var STRIDE_K = 4.28;

Player.prototype.step = function (dt) {
  if (this.kickT > 0) this.kickT -= dt;            // runs even while off balance
  if (this.receiveT > 0) this.receiveT -= dt;
  if (this.react > 0) { this.react -= dt; this.decay(dt); return; }
  if (this.stumble > 0) { this.stumble -= dt; this.decay(dt); return; }

  var dx = this.tx - this.x, dy = this.ty - this.y;
  var d = Math.hypot(dx, dy);
  var want = this.maxSpeed;
  if (d < 1.2) want = this.maxSpeed * (d / 1.2);      // slow into the target
  if (d < 0.05) { this.decay(dt); return; }

  var wx = (dx / d) * want, wy = (dy / d) * want;
  var ax = wx - this.vx, ay = wy - this.vy;
  var am = Math.hypot(ax, ay);
  var maxA = this.accel * dt;
  if (am > maxA) { ax *= maxA / am; ay *= maxA / am; }
  this.vx += ax; this.vy += ay;

  var sp = this.speed();
  if (sp > this.maxSpeed) { this.vx *= this.maxSpeed / sp; this.vy *= this.maxSpeed / sp; }

  this.x += this.vx * dt;
  this.y += this.vy * dt;
  if (sp > 0.4) this.face = Math.atan2(this.vy, this.vx);
  this.anim += sp * dt * STRIDE_K;

  this.x = clamp(this.x, -PITCH.halfW - 2, PITCH.halfW + 2);
  this.y = clamp(this.y, GOAL_Y - 1.4, PITCH.halfL + 2);
};

Player.prototype.decay = function (dt) {
  var f = Math.pow(0.02, dt);
  this.vx *= f; this.vy *= f;
  this.x += this.vx * dt; this.y += this.vy * dt;
};

/* Earliest point on a predicted path this player can physically get to.
   Returns null if the ball beats them everywhere. */
Player.prototype.intercept = function (path, delay, reachH) {
  reachH = reachH === undefined ? 2.1 : reachH;
  for (var i = 0; i < path.length; i++) {
    var p = path[i];
    if (p.z > reachH) continue;
    var need = dist(this.x, this.y, p.x, p.y);
    var can = Math.max(0, p.t - delay) * this.maxSpeed + 0.2;
    if (can >= need) return p;
  }
  return null;
}

/* =========================================================================
   WORLD
   ========================================================================= */
function World(level) {
  this.level = level;
  this.ball = new Ball();
  this.reset();
}

World.prototype.reset = function () {
  var L = this.level, i;
  this.us = [];
  this.them = [];

  /* the striker stands off to the side of the ball, both because that is how
     you actually address a ball and because it keeps him from hiding it from
     a camera sitting directly behind */
  this.carrier = new Player(L.ball[0] - 0.85, L.ball[1] + 0.75, "us", "out", 8);
  this.us.push(this.carrier);
  for (i = 0; i < L.mates.length; i++) {
    this.us.push(new Player(L.mates[i][0], L.mates[i][1], "us", "out", L.mates[i][2]));
  }
  for (i = 0; i < L.foes.length; i++) {
    this.them.push(new Player(L.foes[i][0], L.foes[i][1], "them", "out", 0));
  }
  this.gk = new Player(L.gk[0], L.gk[1], "them", "gk", 1);
  this.them.push(this.gk);

  this.ball.reset();
  this.ball.x = L.ball[0];
  this.ball.y = L.ball[1] - 0.35;

  this.touchesUsed = 0;
  this.phase = "aim";        // aim | live | over
  this.event = null;         // 'goal' | 'save' | 'blocked' | 'wide' | 'out' | 'outoftouches'
  this.eventInfo = "";
  /* Things that just happened, for the presentation layer to drain and turn
     into sound and effects. The sim never knows what a cue sounds like — it
     only reports that a bounce or a post strike occurred, which is why the
     headless harness can run without an audio context or a renderer. */
  this.cues = [];
  this.liveT = 0;
  this.cleanRun = true;      // no opposition touch all level
  this.usedCurve = false;
  this.usedChip = false;
  this.shotFromOutside = false;
  this.shakeT = 0;
  this.bounceT = 0;
  this.celebT = 0;
  this.celebTarget = null;
  this.flown = [];
  this.flownT = 0;
  this.tape = [];
  this.tapeT = 0;
  this.post = null;
  this.woodwork = 0;
  this.slowmo = 0;
  this.lastKickPos = { x: this.ball.x, y: this.ball.y };
  this.history = [];
  this.rewinds = REWINDS_PER_LEVEL;
  this.rewound = false;
};

/* ---- rewind: step back to just before the last touch --------------------
   The signature Score! Hero move — you retry the touch that went wrong
   instead of replaying the whole move. */
World.prototype.snapshot = function () {
  var b = this.ball, all = this.us.concat(this.them);
  return {
    ball: [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.spin, b.skid],
    players: all.map(function (p) {
      return [p.x, p.y, p.vx, p.vy, p.face, p.react, p.dive, p.diveDir,
              p.committed ? 1 : 0, p.stumble, p.anim, p.maxSpeed, p.tx, p.ty];
    }),
    carrier: this.us.indexOf(this.carrier),
    touchesUsed: this.touchesUsed,
    cleanRun: this.cleanRun,
    usedCurve: this.usedCurve,
    usedChip: this.usedChip
  };
};

World.prototype.restore = function (s) {
  var b = this.ball, all = this.us.concat(this.them);
  b.x = s.ball[0]; b.y = s.ball[1]; b.z = s.ball[2];
  b.vx = s.ball[3]; b.vy = s.ball[4]; b.vz = s.ball[5];
  b.spin = s.ball[6]; b.skid = s.ball[7];
  b.live = false; b.trail.length = 0;
  for (var i = 0; i < all.length && i < s.players.length; i++) {
    var p = all[i], v = s.players[i];
    p.x = v[0]; p.y = v[1]; p.vx = v[2]; p.vy = v[3]; p.face = v[4];
    p.react = v[5]; p.dive = v[6]; p.diveDir = v[7];
    p.committed = !!v[8]; p.stumble = v[9]; p.anim = v[10];
    p.maxSpeed = v[11]; p.tx = v[12]; p.ty = v[13];
  }
  this.carrier = this.us[Math.max(0, s.carrier)];
  this.touchesUsed = s.touchesUsed;
  this.cleanRun = s.cleanRun;
  this.usedCurve = s.usedCurve;
  this.usedChip = s.usedChip;
  this.phase = "aim";
  this.event = null;
  this.eventInfo = "";
  this.cues = [];
  this.liveT = 0;
  this.slowmo = 0;
  this.shakeT = 0;
  this.bounceT = 0;
  this.celebT = 0;
  this.celebTarget = null;
  this.flown = [];
  this.flownT = 0;
  this.tape = [];
  this.tapeT = 0;
  this.post = null;
  this.kickerCooldown = 0;
  this.path = null; this.readPath = null;
};

World.prototype.canRewind = function () {
  return this.rewinds > 0 && this.history.length > 0;
};

World.prototype.rewind = function () {
  if (!this.canRewind()) return false;
  this.restore(this.history.pop());
  this.rewinds--;
  this.rewound = true;
  return true;
};

World.prototype.movesLeft = function () { return this.level.touches - this.touchesUsed; };

/* ---- the kick ---------------------------------------------------------- */
World.prototype.kick = function (dirx, diry, speed, angleDeg, spin, modeIdx) {
  var b = this.ball;
  this.history.push(this.snapshot());
  if (this.history.length > 8) this.history.shift();
  var a = angleDeg * Math.PI / 180;
  var h = Math.cos(a) * speed;
  b.vx = dirx * h;
  b.vy = diry * h;
  b.vz = Math.sin(a) * speed;
  b.z = angleDeg > 0 ? 0.05 : 0;
  b.spin = spin;
  b.skid = angleDeg > 0 ? 0 : 0.5;
  b.live = true;
  b.trail.length = 0;

  this.lastKickPos = { x: b.x, y: b.y };
  this.touchesUsed++;
  this.phase = "live";
  this.liveT = 0;
  this.receiver = null;
  if (Math.abs(spin) > 0.34) this.usedCurve = true;
  if (modeIdx === 2) this.usedChip = true;
  this.shotFromOutside = !inBoxAttacking(b.x, b.y);

  /* the kicker is briefly off balance, and can't immediately win it back */
  this.carrier.stumble = 0.32;
  /* Record how hard it was hit and at what angle. The presentation layer scales
     the wind-up and follow-through from this: one clip played identically for a
     tap and for a 30 m/s drive is the most visible animation fault in the game,
     because shooting is the action the player repeats most. */
  this.carrier.kickPower = clamp((speed - PHYS.MIN_SPEED) /
                                 (PHYS.MAX_SPEED - PHYS.MIN_SPEED), 0, 1);
  this.carrier.kickMode = modeIdx;
  this.carrier.kickT = KICK_ANIM;
  this.carrier.kickIsPass = speed < 20;
  this.kickerCooldown = 0.45;

  /* everyone reacts to the ball leaving the foot, with human latency */
  var i;
  for (i = 0; i < this.them.length; i++) {
    var f = this.them[i];
    f.react = f.role === "gk" ? rnd(0.16, 0.24) : rnd(0.17, 0.30);
    f.committed = false;
    f.dive = 0;
    /* one misread per defender per touch, held for the whole flight */
    f.errX = rnd(-1.0, 1.0);
    f.errY = rnd(-1.0, 1.0);
    f.lag = rnd(0.04, 0.22);
  }
  for (i = 0; i < this.us.length; i++) if (this.us[i] !== this.carrier) this.us[i].react = rnd(0.08, 0.2);
  this.aiTimer = 0;
};

/* ---- per-frame AI ------------------------------------------------------ */
World.prototype.think = function (dt) {
  var b = this.ball, i, p;

  this.aiTimer -= dt;
  if (this.aiTimer <= 0) {
    this.aiTimer = 0.12;
    this.path = predictPath(b, 3.2, 1 / 50);
    /* Nobody can see a bend that has not happened yet. The opposition reads the
       flight as if it were straight until the curve has visibly bitten — which
       is the whole reason a whipped ball beats a set defence. */
    this.readPath = predictPath(b, 2.6, 1 / 50, this.liveT < 0.45 ? 0.18 : 1);
  }
  var path = this.readPath || [];

  /* --- defenders --- */
  for (i = 0; i < this.them.length; i++) {
    p = this.them[i];
    if (p.role === "gk") continue;
    if (p.react > 0) continue;
    var hit = p.intercept(path, 0.05 + p.lag, 2.05);
    if (hit) {
      /* they go where they think it is going, which is not quite where it is */
      p.moveTo(hit.x + p.errX, hit.y + p.errY);
    } else {
      /* can't reach it — drop back to protect the goal instead */
      var goalward = norm(0 - p.x, GOAL_Y + 6 - p.y);
      p.moveTo(p.x + goalward.x * 6, p.y + goalward.y * 6);
    }
  }

  /* --- goalkeeper --- */
  this.keeperThink(dt);

  /* --- our players --- */
  for (i = 0; i < this.us.length; i++) {
    p = this.us[i];
    if (p.react > 0) continue;
    if (p === this.carrier && this.kickerCooldown > 0) continue;
    var mine = p.intercept(this.path || [], 0.02, 2.4);
    if (mine) {
      p.moveTo(mine.x, mine.y);
    } else {
      /* make a forward run into space */
      var tgt = this.runSpace(p);
      p.moveTo(tgt.x, tgt.y);
    }
  }
};

World.prototype.runSpace = function (p) {
  /* head goalward, but veer away from the nearest opponent */
  var tx = p.x * 0.55, ty = Math.max(GOAL_Y + 7, p.y - 9);
  var near = null, nd = 1e9;
  for (var i = 0; i < this.them.length; i++) {
    var d = dist2(p.x, p.y, this.them[i].x, this.them[i].y);
    if (d < nd) { nd = d; near = this.them[i]; }
  }
  if (near && nd < 64) {
    var away = norm(p.x - near.x, p.y - near.y);
    tx += away.x * 5; ty += away.y * 2;
  }
  return { x: clamp(tx, -PITCH.halfW + 2, PITCH.halfW - 2), y: ty };
};

World.prototype.keeperThink = function (dt) {
  var gk = this.gk, b = this.ball;
  if (gk.react > 0) return;

  var toGoal = dist(b.x, b.y, 0, GOAL_Y);
  var shotAtGoal = false, crossX = 0, crossZ = 0, crossT = 99;

  var gp = this.readPath || [];
  for (var i = 1; i < gp.length; i++) {
    if (gp[i - 1].y > GOAL_Y && gp[i].y <= GOAL_Y) {
      var t = (gp[i - 1].y - GOAL_Y) / Math.max(0.0001, gp[i - 1].y - gp[i].y);
      crossX = lerp(gp[i - 1].x, gp[i].x, t);
      crossZ = lerp(gp[i - 1].z, gp[i].z, t);
      crossT = gp[i].t;
      if (Math.abs(crossX) < PITCH.goalHalf + 2.2 && crossZ < PITCH.crossbar + 0.9) shotAtGoal = true;
      break;
    }
  }

  /* Once the dive is launched the keeper is a projectile: no re-aiming, and the
     dive itself is the only lateral movement they get. */
  if (gk.committed) {
    gk.dive = clamp(gk.dive + dt * 3.2, 0, 1);
    gk.maxSpeed = 3.0;
    gk.moveTo(gk.diveTo, GOAL_Y + 0.55);
    return;
  }

  if (shotAtGoal && b.speed() > 8) {
    gk.readX = crossX;
    var lateral = crossX - gk.x;
    gk.maxSpeed = 3.2;                                   // set-position shuffle
    gk.moveTo(clamp(crossX, -PITCH.goalHalf - 1.2, PITCH.goalHalf + 1.2), GOAL_Y + 0.55);
    /* commit when waiting any longer would be fatal — early enough to be fooled
       by a ball that has not started bending yet */
    if (crossT < 0.62 || (Math.abs(lateral) > 1.5 && crossT < 1.0)) {
      gk.committed = true;
      gk.diveDir = sign(lateral || 0.001);
      gk.diveTo = clamp(crossX, gk.x - 1.7, gk.x + 1.7);
    }
  } else {
    /* off the line to narrow the angle, further out the further away the ball is */
    gk.maxSpeed = 5.4;
    gk.dive = Math.max(0, gk.dive - dt * 2);
    gk.committed = false;
    var advance = clamp(3.4 - toGoal * 0.09, 0.5, 3.6);
    if (toGoal > 30) advance = 0.7;
    var aim = norm(b.x - 0, b.y - GOAL_Y);
    gk.moveTo(clamp(b.x * 0.42, -PITCH.goalHalf - 0.9, PITCH.goalHalf + 0.9),
              GOAL_Y + 0.5 + advance * clamp(aim.y, 0, 1));
  }
};

/* ---- contact resolution ------------------------------------------------ */
World.prototype.contacts = function (dt) {
  var b = this.ball, i, p, d;

  /* keeper first — they have the biggest reach */
  var gk = this.gk;
  if (gk.react <= 0) {
    /* standing reach is about an arm; a full dive roughly doubles it. The dive
       travel itself is handled by the keeper's movement, not added here. */
    var reach = 0.85 + gk.dive * 0.75;
    var heightPenalty = clamp(1 - Math.max(0, b.z - 1.15) * 0.3, 0.45, 1);
    var pace = clamp(1.15 - b.speed() / 70, 0.7, 1.05);     // hard to hold a rocket
    var dx = Math.abs(b.x - gk.x), dy = Math.abs(b.y - gk.y);
    if (b.z < 2.55 && dy < 1.4 && dx < reach * heightPenalty * pace) {
      var hold = b.speed() < 19 && b.z < 1.7 && gk.dive < 0.6;
      this.cue("save", hold ? 0 : 1);
      this.finish(hold ? "save" : "save", hold ? "Gathered by the keeper." : "Keeper gets a hand to it!");
      this.shakeT = 0.18;
      return true;
    }
  }

  /* outfield opposition */
  if (this.kickerCooldown <= 0) {
    for (i = 0; i < this.them.length; i++) {
      p = this.them[i];
      if (p.role === "gk" || p.react > 0) continue;
      /* the harder it is hit, the less of a body they get in the way */
      var blockR = clamp(1.05 - b.speed() / 60, 0.5, 1.05);
      d = dist(b.x, b.y, p.x, p.y);
      if (d < blockR && b.z < 2.0) {
        this.cleanRun = false;
        /* a real block on a rocket is usually a deflection, not a clean stop */
        if (b.speed() > 24 && Math.random() < 0.45) {
          var away = norm(b.x - p.x || rnd(-1, 1), b.y - p.y || rnd(-1, 1));
          var sp = b.speed() * 0.55;
          b.vx = away.x * sp + rnd(-2, 2);
          b.vy = away.y * sp + rnd(-2, 2);
          b.vz = Math.max(b.vz, 1.5);
          b.spin *= 0.3;
          p.stumble = 0.5;
          this.shakeT = 0.1;
          this.cue("deflect", 1);
          return false;
        }
        this.cue("block", 1);
        this.finish("blocked", "Blocked. The defender read it.");
        this.shakeT = 0.16;
        return true;
      }
    }
  }

  /* our players receiving */
  if (this.kickerCooldown <= 0) {
    for (i = 0; i < this.us.length; i++) {
      p = this.us[i];
      if (p.react > 0) continue;
      d = dist(b.x, b.y, p.x, p.y);
      var canControl = b.speed() < 21 && b.z < 2.3;
      if (d < 1.0 && canControl) {
        this.receive(p);
        return true;
      }
    }
  }
  return false;
};

World.prototype.receive = function (p) {
  var b = this.ball;
  /* The ball is teleported to this player's feet, which the camera's shock
     absorber hides — but the PLAYER used to do nothing, so a pass landed as a
     discontinuity. A short cushion animation covers the moment. */
  p.receiveT = 0.46;
  this.cue("receive", 1);
  /* first touch: heavier the faster it arrives, worse under pressure */
  var arrive = b.speed();
  var press = 0;
  for (var i = 0; i < this.them.length; i++) {
    var d = dist(p.x, p.y, this.them[i].x, this.them[i].y);
    if (d < 5) press += (5 - d) / 5;
  }
  var err = clamp(arrive / 26, 0, 1) * (0.5 + press * 0.55);
  var dir = norm(b.vx || 0.01, b.vy || 0.01);
  /* nudge the settled ball off the receiver's centre line so it stays visible */
  b.x = p.x + dir.x * (0.75 + err * 1.5) + rnd(-err, err) + 0.8;
  b.y = p.y + dir.y * (0.75 + err * 1.5) + rnd(-err, err) - 0.5;
  b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0; b.spin = 0; b.live = false;

  this.carrier = p;
  this.phase = "aim";
  this.touchQuality = err;

  if (this.movesLeft() <= 0) this.finish("outoftouches", "Out of touches.");
};

/* ---- goal / woodwork / out of play ------------------------------------- */
World.prototype.boundary = function (prev) {
  var b = this.ball;

  if (prev.y > GOAL_Y && b.y <= GOAL_Y) {
    var t = (prev.y - GOAL_Y) / Math.max(0.0001, prev.y - b.y);
    var cx = lerp(prev.x, b.x, t);
    var cz = lerp(prev.z, b.z, t);
    var post = PITCH.goalHalf;

    if (Math.abs(cx) <= post - 0.06 && cz <= PITCH.crossbar - 0.06) {
      this.goalX = cx; this.goalZ = cz;
      this.finish("goal", "");
      return true;
    }
    /* clipped the frame? */
    if (Math.abs(cx) <= post + 0.14 && cz <= PITCH.crossbar + 0.14) {
      this.woodwork = 0.6;
      this.shakeT = 0.22;
      this.cue("post", Math.abs(cx) > post - 0.1 ? 0 : 1);
      b.x = prev.x; b.y = prev.y + 0.05; b.z = prev.z;
      if (Math.abs(cx) > post - 0.1) { b.vx = -b.vx * 0.6; b.vy *= 0.5; }
      else { b.vz = -Math.abs(b.vz) * 0.5 - 2; b.vy = Math.abs(b.vy) * 0.45; }
      b.spin *= 0.3;
      this.eventInfo = "woodwork";
      return false;
    }
    this.finish("wide", cz > PITCH.crossbar ? "Over the bar." : "Wide of the post.");
    return true;
  }

  if (Math.abs(b.x) > PITCH.halfW || b.y > PITCH.halfL) {
    this.finish("out", "Out of play.");
    return true;
  }
  return false;
};

/* Run the celebration. Called only once the level is over and only on a goal. */
World.prototype.celebrate = function (dt) {
  this.celebT = (this.celebT || 0) + dt;
  var t = this.celebT;
  var scorer = this.carrier;
  if (!scorer) return;

  /* the scorer peels off toward the near corner on the side they scored from */
  if (!this.celebTarget) {
    var side = (this.goalX || 0) >= 0 ? 1 : -1;
    this.celebTarget = { x: side * (PITCH.halfW - 13), y: GOAL_Y + 9.0 };
  }

  var tg = this.celebTarget;
  var d = dist(scorer.x, scorer.y, tg.x, tg.y);
  /* sprint for the first stretch, then slow into a stand and let the arms do
     the work — running flat out under a camera that has stopped moving reads
     as a bug */
  /* A full sprint outruns the camera on a portrait frame. Real celebrations
     are a short burst then a slow-down anyway. */
  var want = t < 1.1 ? 5.4 : (d > 2 ? 1.8 : 0);
  if (d > 0.4 && want > 0) {
    var n = norm(tg.x - scorer.x, tg.y - scorer.y);
    scorer.vx = n.x * want; scorer.vy = n.y * want;
    scorer.x += scorer.vx * dt; scorer.y += scorer.vy * dt;
    scorer.face = Math.atan2(n.y, n.x);
    scorer.anim += Math.hypot(scorer.vx, scorer.vy) * dt * STRIDE_K;
  } else {
    scorer.vx *= 0.86; scorer.vy *= 0.86;
    /* Turn and face the stand once they stop. Celebrating with your back to
       the camera and to the crowd wastes the shot entirely. */
    var toCrowd = Math.atan2(GOAL_Y - 12 - scorer.y, (this.celebTarget.x > 0 ? 1 : -1) * 3);
    var da = ((toCrowd - scorer.face + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    scorer.face += da * Math.min(1, dt * 4.5);
  }

  /* team-mates converge, staggered, and stop short so they do not stack up */
  for (var i = 0; i < this.us.length; i++) {
    var p = this.us[i];
    if (p === scorer) continue;
    if (t < 0.35 + i * 0.12) continue;
    var dd = dist(p.x, p.y, scorer.x, scorer.y);
    if (dd < 2.6 + i * 0.5) { p.vx *= 0.84; p.vy *= 0.84; continue; }
    var m = norm(scorer.x - p.x, scorer.y - p.y);
    var sp = Math.min(6.4, 2.0 + dd * 0.4);
    p.vx = m.x * sp; p.vy = m.y * sp;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.face = Math.atan2(m.y, m.x);
    p.anim += sp * dt * STRIDE_K;
  }
};

World.prototype.cue = function (name, a) {
  this.cues.push({ n: name, a: a });
  if (this.cues.length > 24) this.cues.shift();
};

World.prototype.finish = function (ev, info) {
  if (this.phase === "over") return;
  this.phase = "over";
  this.event = ev;
  this.eventInfo = info || "";

  /* POST-MORTEM. Enough state for the presentation layer to show the player
     WHY the attempt failed rather than only that it did. "SAVED" is an
     outcome; "the keeper went the way you aimed and you were 40 cm inside the
     post" is a lesson, and only one of those makes a hard game feel fair.

     Recorded here because it all evaporates the moment the next attempt
     starts. Presentation-agnostic: numbers and positions, no text. */
  var b = this.ball, gk = this.gk;
  this.post = {
    ev: ev,
    ball: { x: b.x, y: b.y, z: b.z },
    /* the flight actually taken, for the replay line */
    flight: (this.flown || []).slice(),
    /* where the keeper ended up and which way they committed */
    gk: gk ? { x: gk.x, y: gk.y, dive: gk.dive, dir: gk.diveDir } : null,
    /* how far off target: signed metres past the post, and over the bar */
    wideBy: Math.abs(b.x) - PITCH.goalHalf,
    overBy: b.z - PITCH.crossbar,
    speed: b.speed()
  };
  this.ball.live = false;
  if (ev === "goal") { this.slowmo = 0.9; this.cue("net", 1); }
};

/* ---- main tick --------------------------------------------------------- */
World.prototype.update = function (dt) {
  var i;
  if (this.shakeT > 0) this.shakeT -= dt;
  if (this.bounceT > 0) this.bounceT -= dt;
  if (this.woodwork > 0) this.woodwork -= dt;

  if (this.phase !== "live") {
    for (i = 0; i < this.us.length; i++) this.us[i].anim += dt * 0.6;
    /* THE CELEBRATION.

       The level is decided by this point, so moving players here cannot affect
       balance — but standing everyone still through the biggest moment in the
       game made the goal land on a freeze-frame of eleven statues. The scorer
       sprints away toward the corner with the rest converging on them, which
       is what a goal actually looks like and gives the pull-out camera
       something to follow.

       Kept in the simulation rather than the renderer because positions are
       simulation state; the renderer only ever reads them. */
    if (this.phase === "over" && this.event === "goal") this.celebrate(dt);
    return;
  }

  this.liveT += dt;
  if (this.kickerCooldown > 0) this.kickerCooldown -= dt;

  this.think(dt);

  /* sub-step the ball so nothing tunnels through a defender at 30 m/s */
  var steps = Math.max(1, Math.ceil(this.ball.speed() * dt / 0.28));
  var sdt = dt / steps;
  for (var s = 0; s < steps; s++) {
    var prev = { x: this.ball.x, y: this.ball.y, z: this.ball.z };
    var pvz = this.ball.vz;
    stepBall(this.ball, sdt);
    /* vz flipping from falling to rising at ground level is a bounce. Detected
       out here because stepBall is shared with predictPath, and the aim preview
       must not fire cues. */
    if (pvz < -0.6 && this.ball.vz > 0 && this.ball.z <= 0.02) {
      this.cue("bounce", Math.min(1, -pvz / 12));
      this.bounceT = 0.18;
    }
    if (this.boundary(prev)) return;
    if (this.contacts(sdt)) return;
  }

  for (i = 0; i < this.us.length; i++) this.us[i].step(dt);
  for (i = 0; i < this.them.length; i++) this.them[i].step(dt);

  this.ball.trail.push({ x: this.ball.x, y: this.ball.y, z: this.ball.z });
  if (this.ball.trail.length > 46) this.ball.trail.shift();

  /* THE TAPE.

     The whole attempt, sampled at ~28 Hz: the ball, and every player's position,
     facing, velocity and stride phase. Two things read it — the post-mortem
     flight line, and the goal replay.

     Velocity is recorded as well as position because the renderer picks a clip
     from speed(): without it, a replay would show eleven players sliding around
     in their idle poses. Stride phase is recorded so the feet stay planted
     through the replay exactly as they did live.

     Bounded at 400 frames (~14 s, longer than any attempt can last) so a stuck
     level cannot grow it without limit. */
  if (!this.tape) this.tape = [];
  this.tapeT = (this.tapeT || 0) + dt;
  if (this.tapeT > 0.035) {
    this.tapeT = 0;
    var all = this.us.concat(this.them), rec = [];
    for (var ti = 0; ti < all.length; ti++) {
      var tp = all[ti];
      rec.push(tp.x, tp.y, tp.face, tp.vx, tp.vy, tp.anim);
    }
    this.tape.push({ bx: this.ball.x, by: this.ball.y, bz: this.ball.z,
                     rot: this.ball.rot, p: rec });
    if (this.tape.length > 400) this.tape.shift();
  }

  /* the ball-only path, kept separately for the post-mortem line */
  if (!this.flown) this.flown = [];
  this.flownT = (this.flownT || 0) + dt;
  if (this.flownT > 0.035) {
    this.flownT = 0;
    this.flown.push({ x: this.ball.x, y: this.ball.y, z: this.ball.z });
    if (this.flown.length > 260) this.flown.shift();
  }

  /* ball has come to rest in open space */
  if (this.ball.speed() < 0.45 && this.ball.z < 0.06 && this.liveT > 0.35) {
    var best = null, bd = 1e9;
    var all = this.us.concat(this.them);
    for (i = 0; i < all.length; i++) {
      var d = dist(this.ball.x, this.ball.y, all[i].x, all[i].y);
      if (d < bd) { bd = d; best = all[i]; }
    }
    if (best && best.team === "us" && bd < 12) {
      this.receive(best);
    } else {
      this.cleanRun = false;
      this.finish("lost", "Possession lost.");
    }
  }

  if (this.liveT > 14) this.finish("lost", "Move broke down.");
};

/* stars earned for a completed level */
World.prototype.rate = function () {
  if (this.event !== "goal") return 0;
  var L = this.level, s = 1;
  if (this.touchesUsed <= L.par) s++;
  var bonus = false;
  switch (L.bonus) {
    case "curve":   bonus = this.usedCurve; break;
    case "chip":    bonus = this.usedChip; break;
    case "outside": bonus = this.shotFromOutside; break;
    case "clean":   bonus = this.cleanRun; break;
    default:        bonus = this.cleanRun;
  }
  if (bonus) s++;
  return clamp(s, 1, 3);
};

World.prototype.bonusText = function () {
  switch (this.level.bonus) {
    case "curve":   return "bend the winner";
    case "chip":    return "lift it over the keeper";
    case "outside": return "score from outside the box";
    default:        return "keep it away from the opposition";
  }
};
