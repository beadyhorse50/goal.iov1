/* goal.io — audio engine.

   Everything is synthesised at runtime: no sample files, so the game stays a
   single folder that works offline. But it is not a blip generator. The shape
   of this file matters more than any individual sound:

     dry ──────────────────────────┐
     wet ── convolver (stadium IR) ┤── master ── compressor ── out
     bed ── crowd noise + LFOs ────┘

   The crowd bed is always running while a match is on screen, and every event
   ducks or swells it. That single continuous layer is what makes the rest stop
   sounding like a menu on a phone: a kick with a stadium tail behind it reads
   as a kick in a stadium. Silence between events is what made the old build
   feel unfinished, not the quality of the events themselves.

   All sound-producing calls are no-ops until unlock() has run inside a real
   user gesture — browsers require it, and calling it early leaves a dead
   AudioContext that never recovers.
*/
"use strict";

var SND = (function () {

  var ac = null, ready = false;
  var master, comp, dry, wet, verb, bedGain, duck;
  var bed = null;                     // the crowd loop, built once
  var enabled = true;
  var lastPitch = {};                 // per-name time gate, kills machine-gunning

  /* ------------------------------------------------------------------ core */

  function unlock() {
    if (ac) { if (ac.state === "suspended") ac.resume(); return ac; }
    /* respect a saved mute before anything is built, or the first gesture
       plays a whistle at a player who turned sound off last session */
    if (typeof Save !== "undefined" && Save.data && Save.data.sound === 0) enabled = false;
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { ac = false; return null; }
    build();
    return ac;
  }

  function build() {
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 26;
    comp.ratio.value = 3.4; comp.attack.value = 0.004; comp.release.value = 0.22;

    master = ac.createGain(); master.gain.value = 0.9;

    /* one duck node the whole mix passes through, so a goal can punch a hole
       in the bed and let the roar through without touching every voice */
    duck = ac.createGain(); duck.gain.value = 1;

    verb = ac.createConvolver();
    verb.buffer = impulse(2.4, 2.6);
    wet = ac.createGain(); wet.gain.value = 0.28;
    dry = ac.createGain(); dry.gain.value = 1.0;

    dry.connect(duck);
    wet.connect(verb); verb.connect(duck);
    duck.connect(master); master.connect(comp); comp.connect(ac.destination);

    bedGain = ac.createGain(); bedGain.gain.value = 0;
    bedGain.connect(dry); bedGain.connect(wet);
    ready = true;
  }

  /* A stadium is a big, dark, slightly gated space. Noise decaying on a curve
     with a touch of early reflection gets there and costs nothing to ship. */
  function impulse(dur, decay) {
    var n = Math.floor(ac.sampleRate * dur);
    var b = ac.createBuffer(2, n, ac.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch);
      for (var i = 0; i < n; i++) {
        var t = i / n;
        var env = Math.pow(1 - t, decay);
        /* a few discrete early reflections stop it sounding like a reverb tail
           on nothing — they are what give the space a size */
        var er = 0;
        if (i > 1100 && i < 1160) er = 0.5;
        if (i > 2400 && i < 2470) er = 0.34;
        if (i > 4100 && i < 4180) er = 0.22;
        d[i] = ((Math.random() * 2 - 1) * env) + er * (Math.random() * 2 - 1);
      }
    }
    return b;
  }

  function now() { return ac.currentTime; }

  /* route a voice to both buses at a chosen wetness */
  function route(node, send) {
    node.connect(dry);
    if (send > 0) { var g = ac.createGain(); g.gain.value = send; node.connect(g); g.connect(wet); }
  }

  function env(g, t0, a, peak, d, hold) {
    hold = hold || 0;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    if (hold) g.gain.setValueAtTime(peak, t0 + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + hold + d);
  }

  function osc(type, f, t0, dur, peak, send, slideTo, detune) {
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (detune) o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    env(g, t0, Math.min(0.012, dur * 0.2), peak, dur);
    o.connect(g); route(g, send == null ? 0.2 : send);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return o;
  }

  /* one-shot noise through a filter — the workhorse for every impact */
  function burst(t0, dur, peak, type, hz, q, send, sweepTo) {
    var n = Math.max(1, Math.floor(ac.sampleRate * dur));
    var b = ac.createBuffer(1, n, ac.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var s = ac.createBufferSource(); s.buffer = b;
    var f = ac.createBiquadFilter();
    f.type = type || "lowpass"; f.frequency.setValueAtTime(hz, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    if (q) f.Q.value = q;
    var g = ac.createGain();
    env(g, t0, 0.003, peak, dur);
    s.connect(f); f.connect(g); route(g, send == null ? 0.25 : send);
    s.start(t0); s.stop(t0 + dur + 0.05);
    return s;
  }

  /* --------------------------------------------------------- the crowd bed */

  /* A looping buffer of many overlapping voice-ish bands. Built once, then
     modulated forever: cheap, and it never repeats audibly because three LFOs
     of different periods ride the filter and the gain. */
  function buildBed() {
    var dur = 9.0;                       // long enough that the loop is not a pulse
    var n = Math.floor(ac.sampleRate * dur);
    var b = ac.createBuffer(2, n, ac.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch);
      /* pink-ish noise: cheap one-pole cascade, warmer than white */
      var b0 = 0, b1 = 0, b2 = 0;
      for (var i = 0; i < n; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.030;
        b1 = 0.985 * b1 + w * 0.075;
        b2 = 0.900 * b2 + w * 0.150;
        d[i] = (b0 + b1 + b2) * 0.55;
      }
      /* sprinkle short claps and whistles so it reads as people, not wind */
      for (var k = 0; k < 900; k++) {
        var at = Math.floor(Math.random() * (n - 3000));
        var len = 60 + Math.floor(Math.random() * 500);
        var amp = 0.05 + Math.random() * 0.14;
        for (var j = 0; j < len; j++) {
          var e = Math.pow(1 - j / len, 2.2);
          d[at + j] += (Math.random() * 2 - 1) * amp * e;
        }
      }
      /* smooth the loop join so there is no click every 9 seconds */
      var xf = Math.floor(ac.sampleRate * 0.25);
      for (var m = 0; m < xf; m++) {
        var a = m / xf;
        d[m] = d[m] * a + d[n - xf + m] * (1 - a);
      }
    }
    return b;
  }

  function startBed() {
    if (!ready || bed) return;
    var src = ac.createBufferSource();
    src.buffer = buildBed(); src.loop = true;

    /* two bands: a low body that is always there, and a bright band that
       only opens up when the crowd is excited */
    var lo = ac.createBiquadFilter(); lo.type = "lowpass"; lo.frequency.value = 760; lo.Q.value = 0.6;
    var hi = ac.createBiquadFilter(); hi.type = "bandpass"; hi.frequency.value = 1750; hi.Q.value = 0.55;
    var hiG = ac.createGain(); hiG.gain.value = 0.16;

    src.connect(lo); lo.connect(bedGain);
    src.connect(hi); hi.connect(hiG); hiG.connect(bedGain);

    /* slow breathing so the level is never static */
    var l1 = ac.createOscillator(), l1g = ac.createGain();
    l1.frequency.value = 0.055; l1g.gain.value = 0.16;
    l1.connect(l1g); l1g.connect(bedGain.gain); l1.start();

    var l2 = ac.createOscillator(), l2g = ac.createGain();
    l2.frequency.value = 0.017; l2g.gain.value = 420;
    l2.connect(l2g); l2g.connect(lo.frequency); l2.start();

    bed = { src: src, lo: lo, hi: hiG };
    src.start();
    bedGain.gain.setValueAtTime(0.0001, now());
    bedGain.gain.linearRampToValueAtTime(0.34, now() + 2.2);
  }

  function stopBed() {
    if (!ready || !bed) return;
    var t = now();
    bedGain.gain.cancelScheduledValues(t);
    bedGain.gain.setValueAtTime(bedGain.gain.value, t);
    bedGain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    var b = bed; bed = null;
    setTimeout(function () { try { b.src.stop(); } catch (e) {} }, 900);
  }

  /* push the crowd up for a moment — anticipation, near miss, goal */
  function swell(amount, dur, bright) {
    if (!ready || !bed) return;
    var t = now(), g = bedGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.min(1.15, 0.34 + amount), t + 0.10);
    g.linearRampToValueAtTime(0.34, t + (dur || 1.4));
    if (bright) {
      var h = bed.hi.gain;
      h.cancelScheduledValues(t); h.setValueAtTime(h.value, t);
      h.linearRampToValueAtTime(0.16 + bright, t + 0.12);
      h.linearRampToValueAtTime(0.16, t + (dur || 1.4));
    }
  }

  /* duck the whole mix briefly so a transient lands hard — the "expensive" trick */
  function sidechain(depth, dur) {
    if (!ready) return;
    var t = now(), g = duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(1 - depth, t + 0.012);
    g.linearRampToValueAtTime(1, t + (dur || 0.30));
  }

  function gate(name, ms) {
    var t = ac ? now() : 0;
    if (lastPitch[name] && t - lastPitch[name] < ms / 1000) return false;
    lastPitch[name] = t; return true;
  }

  /* ------------------------------------------------------------------ voices */

  var V = {

    /* A real kick is three things at once: the click of boot leather, the
       woody body of the ball, and a low thump you feel. One noise burst is
       why the old one sounded like a UI tap. */
    kick: function (power) {
      if (!ready || !enabled) return;
      var t = now(), p = Math.max(0, Math.min(1, power));
      burst(t, 0.020, 0.34 + p * 0.30, "highpass", 2600 + p * 2600, 0.8, 0.06);      // leather
      burst(t + 0.004, 0.11 + p * 0.05, 0.30 + p * 0.34, "bandpass",
            420 + p * 520, 1.5, 0.22, 180);                                          // body
      osc("sine", 150 + p * 60, t + 0.002, 0.16 + p * 0.08, 0.42 + p * 0.34, 0.10,
          46 + p * 14);                                                              // thump
      if (p > 0.72) burst(t + 0.02, 0.20, 0.10 * p, "bandpass", 3200, 2.2, 0.5);     // air
      sidechain(0.22 + p * 0.16, 0.24);
      swell(0.10 + p * 0.16, 0.9, 0.05 + p * 0.06);
    },

    pass: function (power) {
      if (!ready || !enabled) return;
      var t = now(), p = Math.max(0, Math.min(1, power));
      burst(t, 0.016, 0.22 + p * 0.18, "highpass", 2200, 0.8, 0.06);
      osc("sine", 132, t, 0.10, 0.22 + p * 0.16, 0.10, 62);
      sidechain(0.12, 0.16);
    },

    /* net is a wide, soft, fast-decaying hiss with a rope creak under it */
    net: function () {
      if (!ready || !enabled) return;
      var t = now();
      burst(t, 0.30, 0.34, "bandpass", 2400, 0.7, 0.55, 900);
      burst(t + 0.02, 0.22, 0.16, "highpass", 5200, 0.6, 0.4);
      osc("triangle", 220, t, 0.16, 0.10, 0.35, 150);
    },

    /* aluminium, not a bell: two close partials beating against each other */
    post: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("triangle", 1180, t, 0.85, 0.26, 0.6, 1120);
      osc("triangle", 1183, t, 0.85, 0.20, 0.6, 1118, 14);
      osc("sine", 2360, t, 0.40, 0.10, 0.6);
      burst(t, 0.03, 0.24, "highpass", 4000, 0.8, 0.4);
      sidechain(0.26, 0.4);
      swell(0.40, 1.6, 0.14);
    },

    save: function () {
      if (!ready || !enabled) return;
      var t = now();
      burst(t, 0.10, 0.30, "lowpass", 900, 0.9, 0.3);              // glove
      burst(t + 0.01, 0.16, 0.14, "bandpass", 1900, 1.2, 0.35);
      osc("sine", 120, t, 0.12, 0.24, 0.15, 70);
      sidechain(0.20, 0.26);
      swell(0.30, 1.5, 0.10);
    },

    block: function () {
      if (!ready || !enabled) return;
      var t = now();
      burst(t, 0.08, 0.26, "lowpass", 620, 0.9, 0.25);
      osc("sine", 104, t, 0.10, 0.22, 0.12, 62);
      sidechain(0.16, 0.2);
    },

    bounce: function (power) {
      if (!ready || !enabled || !gate("bounce", 70)) return;
      var t = now(), p = Math.max(0, Math.min(1, power));
      burst(t, 0.05, 0.10 + p * 0.16, "lowpass", 700 + p * 500, 0.9, 0.18);
      osc("sine", 96, t, 0.07, 0.10 + p * 0.14, 0.10, 60);
    },

    /* the big one. A roar is a rising swell, not a cheer sample: broadband
       noise opening its filter upward while the bed lifts underneath. */
    roar: function () {
      if (!ready || !enabled) return;
      var t = now();
      sidechain(0.42, 0.16);

      var n = Math.floor(ac.sampleRate * 4.2);
      var b = ac.createBuffer(2, n, ac.sampleRate);
      for (var ch = 0; ch < 2; ch++) {
        var d = b.getChannelData(ch);
        var a0 = 0, a1 = 0;
        for (var i = 0; i < n; i++) {
          var w = Math.random() * 2 - 1;
          a0 = 0.995 * a0 + w * 0.05;
          a1 = 0.93 * a1 + w * 0.16;
          d[i] = (a0 + a1);
        }
        /* dense claps: this is what makes it people rather than a jet */
        for (var k = 0; k < 2600; k++) {
          var at = Math.floor(Math.random() * (n - 2000));
          var len = 40 + Math.floor(Math.random() * 260);
          var amp = 0.06 + Math.random() * 0.20;
          for (var j = 0; j < len; j++) {
            d[at + j] += (Math.random() * 2 - 1) * amp * Math.pow(1 - j / len, 2);
          }
        }
      }
      var s = ac.createBufferSource(); s.buffer = b;
      var f = ac.createBiquadFilter(); f.type = "lowpass";
      f.frequency.setValueAtTime(500, t);
      f.frequency.linearRampToValueAtTime(4200, t + 0.55);
      f.frequency.linearRampToValueAtTime(2200, t + 3.6);
      var g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.85, t + 0.28);
      g.gain.setValueAtTime(0.85, t + 1.5);
      g.gain.exponentialRampToValueAtTime(0.02, t + 4.1);
      s.connect(f); f.connect(g); route(g, 0.5);
      s.start(t); s.stop(t + 4.3);

      swell(0.72, 4.0, 0.34);
    },

    /* disappointment: the inverse shape of the roar, and much shorter */
    groan: function () {
      if (!ready || !enabled) return;
      var t = now();
      var n = Math.floor(ac.sampleRate * 1.6);
      var b = ac.createBuffer(1, n, ac.sampleRate);
      var d = b.getChannelData(0), a0 = 0;
      for (var i = 0; i < n; i++) {
        var w = Math.random() * 2 - 1;
        a0 = 0.996 * a0 + w * 0.06; d[i] = a0;
      }
      var s = ac.createBufferSource(); s.buffer = b;
      var f = ac.createBiquadFilter(); f.type = "lowpass";
      f.frequency.setValueAtTime(1400, t);
      f.frequency.exponentialRampToValueAtTime(340, t + 1.4);
      var g = ac.createGain();
      env(g, t, 0.12, 0.42, 1.3, 0.10);
      s.connect(f); f.connect(g); route(g, 0.45);
      s.start(t); s.stop(t + 1.7);
      swell(0.16, 1.4, 0);
    },

    whistle: function (long) {
      if (!ready || !enabled) return;
      var t = now(), dur = long ? 0.9 : 0.34;
      /* a pea whistle is two close tones plus a fast warble */
      var o1 = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
      o1.type = "square"; o2.type = "square";
      o1.frequency.value = 2360; o2.frequency.value = 2980;
      var lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 22; lg.gain.value = 90;
      lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency); lfo.start(t);
      env(g, t, 0.02, 0.16, dur * 0.5, dur * 0.5);
      o1.connect(g); o2.connect(g); route(g, 0.4);
      o1.start(t); o2.start(t); o1.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
      lfo.stop(t + dur + 0.1);
      burst(t, 0.06, 0.06, "highpass", 3000, 0.7, 0.3);
    },

    /* --------------------------------------------------------------- UI */

    tap: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("sine", 900, t, 0.045, 0.10, 0.05, 620);
      burst(t, 0.012, 0.05, "highpass", 4200, 0.7, 0.05);
    },

    tick: function () {
      if (!ready || !enabled || !gate("tick", 28)) return;
      var t = now();
      osc("sine", 1500, t, 0.022, 0.045, 0.02);
    },

    confirm: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("sine", 620, t, 0.09, 0.11, 0.14);
      osc("sine", 930, t + 0.055, 0.12, 0.10, 0.16);
      burst(t, 0.02, 0.05, "highpass", 3600, 0.7, 0.08);
    },

    back: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("sine", 520, t, 0.08, 0.09, 0.12, 340);
    },

    deny: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("square", 180, t, 0.10, 0.07, 0.1, 130);
      osc("square", 178, t + 0.09, 0.10, 0.06, 0.1, 120);
    },

    /* stars landing on the result card, pitched up per star */
    star: function (i) {
      if (!ready || !enabled) return;
      var t = now(), f = [784, 988, 1319][Math.min(2, i)] || 784;
      osc("triangle", f, t, 0.34, 0.14, 0.42);
      osc("sine", f * 2, t, 0.16, 0.06, 0.3);
      burst(t, 0.04, 0.07, "highpass", 5000, 0.8, 0.4);
      sidechain(0.10, 0.16);
    },

    /* short brass-ish sting under the GOAL card */
    sting: function () {
      if (!ready || !enabled) return;
      var t = now();
      [0, 0.09, 0.18].forEach(function (o, i) {
        var f = [392, 523, 659][i];
        osc("sawtooth", f, t + o, 0.55 - i * 0.06, 0.10, 0.45);
        osc("sawtooth", f, t + o, 0.55 - i * 0.06, 0.07, 0.45, null, 12);
      });
      osc("sine", 98, t, 0.7, 0.26, 0.2);
      burst(t, 0.5, 0.10, "highpass", 6000, 0.7, 0.6);
    },

    rewind: function () {
      if (!ready || !enabled) return;
      var t = now();
      osc("triangle", 300, t, 0.30, 0.11, 0.3, 900);
      burst(t, 0.26, 0.08, "bandpass", 1800, 1.4, 0.4, 4200);
    },

    /* wind + rain layer, ducked under everything, for weather levels */
    weather: function (level) {
      if (!ready || !enabled) return;
      var t = now();
      burst(t, 3.0, 0.05 * level, "bandpass", 900, 0.5, 0.5);
    }
  };

  /* ---------------------------------------------------------------- public */

  return {
    unlock: function () { unlock(); return ready; },
    ready: function () { return ready; },
    enable: function (v) {
      enabled = !!v;
      if (ready) master.gain.setTargetAtTime(enabled ? 0.9 : 0, now(), 0.05);
    },
    enabled: function () { return enabled; },
    startBed: startBed,
    stopBed: stopBed,
    swell: swell,
    sidechain: sidechain,
    /* the presentation layer calls these by name */
    play: function (name, arg) { if (V[name]) V[name](arg); },
    V: V
  };
})();
