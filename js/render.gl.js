/* goal.io — WebGL renderer, behind a flag, alongside the canvas one.

   HOW IT ATTACHES, AND WHY THIS WAY
   ---------------------------------
   It does not edit js/render.js. Not one line. Every world pass in there is a
   plain global function, so this file replaces the ones it takes over with
   no-ops and wraps renderWorld(). The canvas renderer keeps its camera, its
   condition tables, its palette, its screen-space FX and its whole overlay —
   all of that is tuned and none of it is worth rewriting — and this file takes
   the geometry.

   The layering, back to front:
     #gamegl   WebGL: sky, turf, goal, ball          (this file)
     #game     2D:    players, aim, FX, post-mortem  (js/render.js, js/fx.js)
     DOM       vignette, kinetic type, HUD

   That hybrid is deliberate and temporary. A part-finished WebGL renderer
   looks worse than a finished canvas one for a long stretch, and the way to
   not lose that bet is to hand it the pitch first and keep the actors on
   canvas until the skinned path is better than what it replaces.

   TURN IT ON
     ?gl=1 in the URL, or localStorage.goalio_gl = "1", then reload.
     GLR.off() puts it back.

   WHAT THIS ALREADY DOES THAT CANVAS CANNOT
     - a real depth buffer, so nothing needs a painter's bias
     - pitch markings as analytic distance fields: correct at any camera, and
       antialiased by the derivative rather than by luck
     - a shadow map, so the ball's shadow is cast geometry and not an ellipse
     - fog, exposure and colour temperature per fragment instead of as a
       full-frame fill, which is what the canvas grade had to be
*/
"use strict";

var GLR = (function () {

  var on = false;             // flag state, read once at load
  var live = false;           // did the context and every program come up
  var gl = null, glc = null;  // context and its canvas
  var W = 0, H = 0;           // drawing buffer size in device pixels

  var P = {};                 // programs
  var MESH = {};              // meshes
  var TEX = {};               // textures
  var SHADOW = null;

  /* scratch matrices — allocated once, a renderer that allocates per frame
     hands the GC a sawtooth and the sawtooth is judder */
  var mView = M4.ident(), mProj = M4.ident(), mVP = M4.ident();
  var mTmp = M4.ident(), mTmp2 = M4.ident(), mModel = M4.ident();
  var mLightVP = M4.ident(), mLightV = M4.ident(), mLightP = M4.ident();

  var eye = [0, 0, 0], at = [0, 0, 0], up = [0, 0, 1];
  var basis = { f: [0, 0, -1], r: [1, 0, 0], u: [0, 0, 1] };
  var c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0], c4 = [0, 0, 0];

  var FAR = 400, NEARZ = 0.30, FOVY = 0.9;

  /* Per-pass switches. The canvas renderer found its black pitch by disabling
     passes one at a time and reading pixels back, after two confident theories
     about the cause were both wrong. Same trick, made permanent. */
  var DBG = { sky: 1, stand: 1, roof: 1, crowd: 1, ground: 1, posts: 1, ball: 1, net: 1 };
  var SHADOW_SIZE = 1024;
  var SHADOW_HALF = 22;       // metres either side of the shadow camera centre

  function flagged() {
    try {
      if (/[?&]gl=1/.test(location.search)) return true;
      if (/[?&]gl=0/.test(location.search)) return false;
      return localStorage.getItem("goalio_gl") === "1";
    } catch (e) { return false; }
  }

  /* ==================================================================== */
  /* GLSL shared chunks                                                    */
  /* ==================================================================== */

  var HEAD = "#version 300 es\nprecision highp float;\n";

  /* One light, one exposure, one temperature, for every shader.

     The canvas renderer learned this the expensive way: grading only the turf
     gave a black pitch with brightly lit players standing on it, because the
     players drew from fixed palette colours. Here every surface calls grade()
     with the same numbers, so there is no second place for the light to
     disagree with itself. */
  var COMMON = `
  uniform vec3  uEye;
  uniform vec3  uLight;      // to the light, normalised
  uniform vec3  uSkyH;       // horizon colour: what fog fades toward
  uniform vec4  uCond;       // light, warm, flood, haze
  uniform vec4  uViewport;   // x, y, w, h in device pixels
  uniform float uWet;

  float fogAmount(float d) {
    float k = max(0.0, d - 45.0) * 0.0140 * max(uCond.w, 0.05);
    return 1.0 - exp(-k * k);
  }

  vec3 applyFog(vec3 c, float d) {
    return mix(c, uSkyH, clamp(fogAmount(d), 0.0, 0.985));
  }

  /* exposure + colour temperature, then the floodlights put light back into
     the middle of the pitch. Multiply then screen, same as drawGrade(). */
  vec3 grade(vec3 c) {
    float e = uCond.x, w = uCond.y, fl = uCond.z;
    c *= vec3(e * (1.0 + (w - 0.5) * 0.20),
              e * (1.0 + (w - 0.5) * 0.04),
              e * (1.0 - (w - 0.5) * 0.26));
    if (fl > 0.12) {
      vec2 s = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
      float d = length((s - vec2(0.5, 0.42)) * vec2(1.0, 1.30));
      float a = fl * 0.26 * (1.0 - smoothstep(0.04, 1.15, d));
      c = 1.0 - (1.0 - c) * (1.0 - vec3(1.0, 0.972, 0.886) * a);
    }
    return c;
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  `;

  /* Percentage-closer filtering over the hardware comparison sampler. Four
     taps in a rotated pattern is enough at this map size; the hardware is
     already doing a 2x2 bilinear compare inside each one. */
  var SHADOW_CHUNK = `
  uniform highp sampler2DShadow uShadow;
  uniform mat4 uLightVP;
  uniform float uShadowTexel;

  float shadowAt(vec3 wp, float ndl) {
    vec4 lp = uLightVP * vec4(wp, 1.0);
    vec3 q = lp.xyz / lp.w * 0.5 + 0.5;
    if (q.x < 0.001 || q.x > 0.999 || q.y < 0.001 || q.y > 0.999 || q.z > 1.0) return 1.0;
    /* slope-scaled bias: a surface edge-on to the light needs more of it, and
       a constant bias big enough for the worst case detaches every shadow */
    float b = mix(0.0016, 0.0006, clamp(ndl, 0.0, 1.0));
    q.z -= b;
    float s = 0.0;
    float t = uShadowTexel;
    s += texture(uShadow, vec3(q.xy + vec2(-0.7, -0.3) * t, q.z));
    s += texture(uShadow, vec3(q.xy + vec2( 0.3, -0.7) * t, q.z));
    s += texture(uShadow, vec3(q.xy + vec2( 0.7,  0.3) * t, q.z));
    s += texture(uShadow, vec3(q.xy + vec2(-0.3,  0.7) * t, q.z));
    return s * 0.25;
  }
  `;

  /* ==================================================================== */
  /* sky                                                                   */
  /* ==================================================================== */

  var SKY_VS = HEAD + `
  in vec2 aPos;
  out vec2 vNdc;
  void main() {
    vNdc = aPos;
    /* z = w puts it on the far plane, so everything else wins the depth test */
    gl_Position = vec4(aPos, 1.0, 1.0);
  }
  `;

  var SKY_FS = HEAD + COMMON + `
  in vec2 vNdc;
  out vec4 oCol;
  uniform vec3 uCamR, uCamU, uCamF;
  uniform vec2 uTan;          // tan(fovX/2), tan(fovY/2)
  uniform vec3 uSkyZ, uSkyM;  // zenith, mid

  void main() {
    /* a real view ray, so the horizon stays put under shake and zoom rather
       than sliding the way a screen-space gradient does */
    vec3 ray = normalize(uCamF + uCamR * (vNdc.x * uTan.x) + uCamU * (vNdc.y * uTan.y));
    float el = clamp(ray.z, -0.15, 1.0);

    vec3 c = mix(uSkyH, uSkyM, smoothstep(0.0, 0.085, el));
    c = mix(c, uSkyZ, smoothstep(0.055, 0.33, el));

    /* the sun, and the haze it drags down toward the horizon */
    float sun = max(dot(ray, uLight), 0.0);
    float warm = uCond.y;
    c += vec3(1.0, 0.86, 0.62) * pow(sun, 220.0) * 0.55 * warm;
    c += vec3(1.0, 0.80, 0.55) * pow(sun, 7.0) * 0.10 * warm * uCond.x;

    /* below the horizon the sky is not sky, it is the far side of the ground
       plane seen through the haze — match it so the seam does not read */
    c = mix(c, uSkyH * 0.82, smoothstep(0.0, -0.06, el));

    oCol = vec4(grade(c), 1.0);
  }
  `;

  /* ==================================================================== */
  /* turf                                                                  */
  /* ==================================================================== */

  var GROUND_VS = HEAD + `
  in vec2 aPos;
  uniform mat4 uVP;
  out vec3 vW;
  void main() {
    vW = vec3(aPos, 0.0);
    gl_Position = uVP * vec4(vW, 1.0);
  }
  `;

  /* Markings as distance fields. The canvas renderer draws each line as a
     projected quad, which means its width is chosen in screen space and its
     ends are chosen by hand. Here every line is a distance in metres and the
     antialiasing comes from fwidth, so a line 90 m away is a correct thin
     grey rather than a shimmering white one. */
  function groundFrag() {
    var HW = PITCH.halfW.toFixed(3), HL = PITCH.halfL.toFixed(3);
    var BH = PITCH.boxHalf.toFixed(3), BD = PITCH.boxDepth.toFixed(3);
    var SH = PITCH.sixHalf.toFixed(3), SD = PITCH.sixDepth.toFixed(3);
    var PS = PITCH.penSpot.toFixed(3), AR = PITCH.arcR.toFixed(3);
    var CR = PITCH.centreR.toFixed(3), KR = PITCH.cornerR.toFixed(3);
    var SUR = (typeof SURROUND !== "undefined" ? SURROUND : 6).toFixed(2);

    return HEAD + COMMON + SHADOW_CHUNK + `
  in vec3 vW;
  out vec4 oCol;
  uniform vec3 uG1, uG2;      // the two mow colours
  uniform float uBands;

  const float HW = ${HW}, HL = ${HL};
  const float LW = 0.060;     // half a 12 cm line

  float sdSeg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  /* A 12 cm line at 60 m is genuinely thinner than a pixel, and antialiasing
     it honestly fades it out. Real broadcast pitches do not look like that,
     so below a pixel the line widens instead of dimming — energy is not
     conserved and that is the point. */
  float cov(float d, float aa) {
    float w = max(LW, aa * 0.9);
    return 1.0 - smoothstep(w - aa, w + aa, d);
  }
  float dotCov(float d, float r, float aa) {
    float w = max(r, aa * 1.1);
    return 1.0 - smoothstep(w - aa, w + aa, d);
  }

  float markings(vec2 p, float aa) {
    float m = 0.0;
    /* touchlines and goal lines */
    m = max(m, cov(sdSeg(p, vec2(-HW, -HL), vec2(-HW,  HL)), aa));
    m = max(m, cov(sdSeg(p, vec2( HW, -HL), vec2( HW,  HL)), aa));
    m = max(m, cov(sdSeg(p, vec2(-HW, -HL), vec2( HW, -HL)), aa));
    m = max(m, cov(sdSeg(p, vec2(-HW,  HL), vec2( HW,  HL)), aa));
    /* halfway and the centre circle */
    m = max(m, cov(sdSeg(p, vec2(-HW, 0.0), vec2(HW, 0.0)), aa));
    m = max(m, cov(abs(length(p) - ${CR}), aa));
    m = max(m, dotCov(length(p), 0.14, aa));

    /* both ends: penalty area, six-yard box, spot, D */
    for (int i = 0; i < 2; i++) {
      float s = i == 0 ? -1.0 : 1.0;          // -1 = the goal we attack
      float gy = s * HL;
      float by = gy - s * ${BD};
      float sy = gy - s * ${SD};
      float py = gy - s * ${PS};
      m = max(m, cov(sdSeg(p, vec2(-${BH}, gy), vec2(-${BH}, by)), aa));
      m = max(m, cov(sdSeg(p, vec2( ${BH}, gy), vec2( ${BH}, by)), aa));
      m = max(m, cov(sdSeg(p, vec2(-${BH}, by), vec2( ${BH}, by)), aa));
      m = max(m, cov(sdSeg(p, vec2(-${SH}, gy), vec2(-${SH}, sy)), aa));
      m = max(m, cov(sdSeg(p, vec2( ${SH}, gy), vec2( ${SH}, sy)), aa));
      m = max(m, cov(sdSeg(p, vec2(-${SH}, sy), vec2( ${SH}, sy)), aa));
      m = max(m, dotCov(length(p - vec2(0.0, py)), 0.13, aa));
      /* the D is the part of the arc outside the box, and only that part */
      float dArc = abs(length(p - vec2(0.0, py)) - ${AR});
      float outside = step(0.0, (p.y - by) * -s);
      m = max(m, cov(dArc, aa) * outside);
      /* corner arcs */
      m = max(m, cov(abs(length(p - vec2(-HW, gy)) - ${KR}), aa));
      m = max(m, cov(abs(length(p - vec2( HW, gy)) - ${KR}), aa));
    }
    return m;
  }

  /* Where the grass is worn: both goalmouths, the centre circle, the spots.
     Returns 0..1. */
  float wearAt(vec2 p) {
    float w = 0.0;
    for (int i = 0; i < 2; i++) {
      float gy = (i == 0 ? -1.0 : 1.0) * HL;
      vec2 d = (p - vec2(0.0, gy)) / vec2(11.0, 5.5);
      w = max(w, (1.0 - smoothstep(0.35, 1.0, length(d))) * 0.85);
      float py = gy - (i == 0 ? -1.0 : 1.0) * ${PS};
      w = max(w, (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0, py)) / 1.6))) * 0.7);
    }
    w = max(w, (1.0 - smoothstep(0.72, 1.0, length(p / vec2(9.6, 9.6)))) * 0.22);
    w *= 0.55 + 0.9 * hash21(floor(p * 2.4));
    return clamp(w, 0.0, 1.0);
  }

  void main() {
    vec2 p = vW.xy;
    vec3 V = uEye - vW;
    float dist = length(V);
    V /= dist;

    /* the pixel footprint in metres — every antialiasing width below is in
       these units, which is why nothing shimmers in the far field */
    float aa = max(fwidth(p.x), fwidth(p.y)) * 0.75 + 0.004;
    float detail = 1.0 - smoothstep(0.06, 0.40, aa);

    /* mow stripes. Adjacent bands catch the light from opposite ends — that
       opposition is most of the effect, not the two base greens. */
    float band = floor((p.y + HL) / (2.0 * HL / uBands));
    float even = mod(band, 2.0);
    vec3 base = mix(uG1, uG2, even);
    float mow = even > 0.5 ? 1.0 : -1.0;
    float sheen = dot(normalize(vec3(V.xy, 0.0)), vec3(0.0, mow, 0.0));
    base *= 1.0 + sheen * 0.115 * detail;

    /* blades, then a low-frequency mottle so the plane is never one flat fill */
    float fine = hash21(floor(p * vec2(7.5, 22.0))) - 0.5;
    float clump = hash21(floor(p * vec2(1.3, 3.1) + 17.0)) - 0.5;
    float mott = hash21(floor(p * 0.31)) - 0.5;
    float detail2 = 1.0 - smoothstep(0.18, 0.85, aa);
    base *= 1.0 + fine * 0.055 * detail + clump * 0.052 * detail2 + mott * 0.05;

    /* wear: browner, flatter, and it kills the stripe with it */
    float wear = wearAt(p);
    base = mix(base, mix(base, vec3(0.44, 0.40, 0.27), 0.55), wear);

    /* outside the surround it is not grass any more */
    float apron = smoothstep(0.0, 1.4, max(abs(p.x) - (HW + ${SUR}), abs(p.y) - (HL + ${SUR})));
    base = mix(base, vec3(0.135, 0.150, 0.132), apron);

    vec3 N = vec3(0.0, 0.0, 1.0);
    float ndl = max(dot(N, uLight), 0.0);
    float sh = shadowAt(vW, ndl);

    /* key + sky ambient. The ambient is tinted by the sky, which is what
       stops a night pitch reading as a grey pitch. */
    vec3 lit = base * (0.52 + 0.62 * ndl * sh) + uSkyH * base * 0.16;

    /* wet turf: a broad sheen plus a tight highlight, both cut by shadow */
    if (uWet > 0.01) {
      vec3 Hv = normalize(uLight + V);
      float spec = pow(max(dot(N, Hv), 0.0), 48.0);
      lit *= 1.0 - uWet * 0.22;
      lit += vec3(0.85, 0.93, 1.0) * spec * uWet * 1.35 * sh;
      lit += uSkyH * uWet * 0.10 * pow(1.0 - max(dot(N, V), 0.0), 3.0);
    }

    /* FLOODLIGHT POOLS.

       Four rigs, as in the canvas renderer — but there they are screen-space
       radial gradients, which means the pools slide across the turf whenever
       the camera moves. In world space they stay bolted to the pitch, which is
       the entire difference between a lit ground and a lens effect. */
    float pool = 0.0;
    vec2 rig0 = vec2(16.5, 21.1);
    pool += 1.0 - smoothstep(0.0, 1.0, length((p - vec2(-rig0.x, -rig0.y)) / vec2(31.0, 27.0)));
    pool += 1.0 - smoothstep(0.0, 1.0, length((p - vec2( rig0.x, -rig0.y)) / vec2(31.0, 27.0)));
    pool += 1.0 - smoothstep(0.0, 1.0, length((p - vec2(-rig0.x,  rig0.y)) / vec2(31.0, 27.0)));
    pool += 1.0 - smoothstep(0.0, 1.0, length((p - vec2( rig0.x,  rig0.y)) / vec2(31.0, 27.0)));
    lit += vec3(1.0, 0.988, 0.886) * pool * (0.014 + uCond.z * 0.085) * (1.0 - apron);
    /* wet turf under floodlights is mostly reflection, not diffuse */
    if (uWet > 0.01) {
      vec3 Hp = normalize(uLight + V);
      lit += vec3(1.0, 0.97, 0.88) * pow(max(dot(N, Hp), 0.0), 90.0) * pool * uWet * uCond.z * 0.8;
    }

    float m = markings(p, aa) * (1.0 - apron) * (1.0 - wear * 0.45);
    vec3 lineC = vec3(0.94, 0.96, 0.95) * (0.62 + 0.5 * ndl * sh);
    lit = mix(lit, lineC, m);

    oCol = vec4(grade(applyFog(lit, dist)), 1.0);
  }
  `;
  }

  /* ==================================================================== */
  /* the bowl: stands, roof, crowd                                         */
  /* ==================================================================== */

  var STAND_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  in vec2 aUv;               // x: around the bowl 0..1   y: row, 0 at the front
  uniform mat4 uVP;
  out vec3 vW, vN;
  out vec2 vUv;
  void main() {
    vW = aPos; vN = aNrm; vUv = aUv;
    gl_Position = uVP * vec4(aPos, 1.0);
  }
  `;

  var STAND_FS = HEAD + COMMON + `
  in vec3 vW, vN;
  in vec2 vUv;
  out vec4 oCol;
  uniform vec3 uBase, uSeat;
  uniform float uRoof;       // 1 for the roof underside, which is lit by nothing
  uniform sampler2D uBoards;
  uniform float uBoardRep;   // texture repeats around the bowl
  uniform float uSeats;      // seats around the bowl
  uniform vec2 uRake;        // front-row height, row rise

  void main() {
    vec3 N = normalize(vN);
    vec3 V = uEye - vW;
    float d = length(V);
    V /= d;
    float ndl = max(dot(N, uLight), 0.0);

    /* sampled outside the branch below: a texture fetch in non-uniform control
       flow has undefined derivatives, which shows up as the mip level popping
       along the boards as the camera pans */
    /* U is negated because the boards are seen from INSIDE the bowl. The
       perimeter path runs counter-clockwise, so walking it with increasing u
       puts the text the right way round for a camera outside the ground and
       backwards for every camera this game has. */
    vec4 board = texture(uBoards, vec2(-vUv.x * uBoardRep,
                                       1.0 - clamp((vUv.y + 1.0 - 0.05) / 0.89, 0.0, 1.0)));

    /* Ambient occlusion down the rake. The front rows sit at the bottom of a
       bowl with a roof over them, and without this the whole stand reads as
       one flat grey card — which is exactly what a stadium never looks like. */
    /* the front rows measured 65-101/255 against grass at 150+, which read as
       a black band rather than as concrete in shade */
    float ao = mix(0.66, 1.0, clamp(vUv.y, 0.0, 1.0));
    ao *= mix(1.0, 0.34, uRoof);

    vec3 c = uBase * (0.30 + 0.55 * ndl) * ao + uSkyH * uBase * (0.44 * ao);

    /* THE BOARDS.

       The perimeter wall is not concrete, it is a ring of lit advertising, and
       it is the single most recognisable band in a televised football ground.
       Leaving it grey is most of why the stand read as a wall of nothing. */
    if (vUv.y < 0.0) {
      float h = vUv.y + 1.0;
      float band = step(0.05, h) * (1.0 - step(0.94, h));
      c = mix(vec3(0.10, 0.11, 0.13), board.rgb, band);
      c *= 0.70 + 0.45 * ndl;
      /* they are backlit panels, so they hold up when the light goes */
      c += board.rgb * band * (0.10 + 0.22 * uCond.z);
    }

    /* THE LIGHT BANKS.

       Roof-mounted rather than on pylons: it is what almost every modern
       ground uses, it needs no new geometry, and at night it puts a hard row
       of highlights along the top of the frame — which is the shape your eye
       actually reads as "floodlit" long before it reads the pitch. */
    if (uRoof > 0.5) {
      float inEdge = 1.0 - smoothstep(0.05, 0.17, vUv.y - 1.0);
      float lampX = step(0.68, fract(vUv.x * 34.0));
      float lamp = inEdge * lampX;
      c += vec3(1.0, 0.97, 0.88) * lamp * (0.12 + uCond.z * 1.35);
    }

    /* THE SEATS.

       Wherever a spectator is not sitting, the thing you see is a seat, not
       bare concrete — and a bank of empty seats in club colours is half of
       what makes a stand look like a stand. They go on the risers, which is
       where seats physically are, and they stop at the gangways because the
       crowd generator skips exactly the same columns. */
    if (vUv.y >= 0.0 && abs(N.z) < 0.5 && uRoof < 0.5) {
      float rz = fract((vW.z - uRake.x) / uRake.y);
      float su = fract(vUv.x * uSeats);
      float f = fract(vUv.x * 16.0);
      float notGw = step(0.026, f) * (1.0 - step(0.974, f));
      float aaS = fwidth(vUv.x * uSeats);
      /* below about half a seat per pixel the pattern is noise, so it
         dissolves into the average colour instead of fizzing */
      float vis = 1.0 - smoothstep(0.22, 0.55, aaS);
      float seat = step(0.16, su) * (1.0 - step(0.84, su)) * step(0.28, rz) * notGw;
      vec3 seatC = uSeat * (0.34 + 0.52 * ndl) * ao;
      c = mix(c, seatC, seat * vis);
      c = mix(c, mix(c, seatC, 0.58 * notGw), 1.0 - vis);
    }

    /* structural bays: a joint every few metres around the bowl, and a change
       of tone across them, so the rake has a length to it */
    float bay = fract(vUv.x * 96.0);
    float joint = 1.0 - smoothstep(0.0, 0.045, min(bay, 1.0 - bay));
    c *= 1.0 - joint * 0.22;
    c *= 0.94 + 0.12 * hash21(vec2(floor(vUv.x * 96.0), 3.0));

    oCol = vec4(grade(applyFog(c, d)), 1.0);
  }
  `;

  /* THE CROWD.

     One instanced quad per spectator, upright in world space rather than fully
     camera-facing — a crowd that rolls with the camera reads as a decal.

     This is the pass that most needs a GPU. The canvas renderer measured the
     crowd at 7.4 ms of a 13.9 ms frame and got there by pre-sorting by colour
     and thinning distant banks by stride; the ceiling on that road is a few
     thousand people. Here it is one draw call and the number of spectators is
     very nearly free, so the stands are full. */
  var CROWD_VS = HEAD + `
  in vec2 aPos;              // quad corner, -0.5 .. 0.5
  in vec3 aIns;              // seat position
  in vec3 aCol;              // shirt
  in float aSeed;
  uniform mat4 uVP;
  uniform vec3 uCamR;
  uniform vec2 uCrowd;       // time, surge
  uniform float uFocal;      // pixels per metre at one metre
  uniform vec3 uEyeV;
  out vec3 vCol;
  out vec2 vQ;
  out vec3 vW;
  out float vSeed, vPx;

  void main() {
    float ph = aSeed * 6.2831853;
    /* a settled crowd breathes; a surging one comes up out of its seat, and
       the half-wave keeps them from all rising in lockstep */
    float bob = sin(uCrowd.x * 1.6 + ph) * 0.028
              + uCrowd.y * max(0.0, sin(uCrowd.x * 6.5 + ph * 2.3)) * 0.40;
    vec3 c = aIns + vec3(0.0, 0.0, bob);
    float w = 0.50, h = 0.78;
    vec3 p = c + uCamR * (aPos.x * w) + vec3(0.0, 0.0, aPos.y * h + h * 0.5);
    vW = p; vQ = aPos; vCol = aCol; vSeed = aSeed;
    /* on-screen height in pixels, so the fragment shader can stop drawing a
       silhouette it cannot resolve */
    vPx = uFocal * h / max(1.0, length(uEyeV - c));
    gl_Position = uVP * vec4(p, 1.0);
  }
  `;

  var CROWD_FS = HEAD + COMMON + `
  in vec3 vCol;
  in vec2 vQ;
  in vec3 vW;
  in float vSeed, vPx;
  out vec4 oCol;

  vec3 skinOf(float s) {
    float k = fract(s * 7.31);
    if (k < 0.20) return vec3(0.91, 0.73, 0.57);
    if (k < 0.42) return vec3(0.83, 0.63, 0.45);
    if (k < 0.64) return vec3(0.72, 0.51, 0.35);
    if (k < 0.84) return vec3(0.56, 0.37, 0.24);
    return vec3(0.41, 0.26, 0.16);
  }

  void main() {
    vec2 q = vQ;
    /* shoulders, then a head. Two shapes is all it takes at this size, and a
       shirt colour with no head on it reads as a mannequin. */
    float shoulder = 0.34 - max(0.0, q.y - 0.02) * 0.55;
    float body = step(abs(q.x), shoulder) * step(q.y, 0.17);
    float head = 1.0 - step(0.132, length((q - vec2(0.0, 0.30)) * vec2(1.0, 0.92)));

    /* Below a few pixels tall the silhouette is smaller than the sample grid
       and it stops being a person and starts being noise. Dissolving it into
       a filled block of the average colour is what stops a far bank fizzing
       as the camera moves. */
    float small = 1.0 - smoothstep(2.5, 7.0, vPx);
    float a = max(max(body, head), small * step(abs(q.x), 0.34) * step(q.y, 0.30));
    if (a < 0.5) discard;

    vec3 skin = skinOf(vSeed);
    vec3 c = mix(vCol, skin, head > 0.5 ? 1.0 : 0.0);
    c = mix(c, mix(vCol, skin, 0.22), small);

    /* the bank is lit from above and shaded by the roof above the back rows */
    float shade = 0.60 + 0.40 * fract(vSeed * 3.77);
    c *= 0.72 + 0.42 * shade;

    float d = length(uEye - vW);
    oCol = vec4(grade(applyFog(c, d)), 1.0);
  }
  `;

  /* A rounded-rectangle path around the pitch, sampled by arc length, with the
     outward normal at each sample. Everything in the bowl — the rake, the
     roof, every seat — is this path pushed outward and upward. */
  function perimeterPath(hx, hy, r, K) {
    var lx = 2 * (hx - r), ly = 2 * (hy - r), arc = Math.PI * r / 2;
    var segs = [
      { t: "l", len: ly, a: [hx, -(hy - r)], b: [hx, hy - r], n: [1, 0] },
      { t: "a", len: arc, c: [hx - r, hy - r], a0: 0 },
      { t: "l", len: lx, a: [hx - r, hy], b: [-(hx - r), hy], n: [0, 1] },
      { t: "a", len: arc, c: [-(hx - r), hy - r], a0: Math.PI / 2 },
      { t: "l", len: ly, a: [-hx, hy - r], b: [-hx, -(hy - r)], n: [-1, 0] },
      { t: "a", len: arc, c: [-(hx - r), -(hy - r)], a0: Math.PI },
      { t: "l", len: lx, a: [-(hx - r), -hy], b: [hx - r, -hy], n: [0, -1] },
      { t: "a", len: arc, c: [hx - r, -(hy - r)], a0: 3 * Math.PI / 2 }
    ];
    var total = 0, i;
    for (i = 0; i < segs.length; i++) total += segs[i].len;

    var out = [];
    for (var k = 0; k <= K; k++) {
      var s = (k / K) * total, si = 0;
      while (si < segs.length - 1 && s > segs[si].len) { s -= segs[si].len; si++; }
      var g = segs[si], px, py, nx, ny;
      if (g.t === "l") {
        var u = s / g.len;
        px = g.a[0] + (g.b[0] - g.a[0]) * u;
        py = g.a[1] + (g.b[1] - g.a[1]) * u;
        nx = g.n[0]; ny = g.n[1];
      } else {
        var ang = g.a0 + (s / g.len) * (Math.PI / 2);
        nx = Math.cos(ang); ny = Math.sin(ang);
        px = g.c[0] + nx * r; py = g.c[1] + ny * r;
      }
      out.push({ x: px, y: py, nx: nx, ny: ny, t: k / K });
    }
    return out;
  }

  var BOWL = {
    hx: PITCH.halfW + SURROUND + 2.4,
    hy: PITCH.halfL + SURROUND + 2.4,
    corner: 20,
    K: 148,
    rows: 26,
    rise: 0.46,
    run: 0.84,
    base: 1.25,               // top of the perimeter wall: the front row's floor
    roofLift: 3.6,
    roofOver: 15.0            // how far the roof reaches back over the rake
  };

  /* The rake, as real steps. A smooth ramp with the treads painted on reads
     correctly from the front and falls apart in silhouette at the top edge,
     which is where the crowd meets the sky and where the eye actually looks. */
  function buildBowl() {
    var path = perimeterPath(BOWL.hx, BOWL.hy, BOWL.corner, BOWL.K);
    var pos = [], nrm = [], uv = [], idx = [], v = 0;
    var i, r;

    function quad(p0, p1, p2, p3, n, uvs) {
      pos.push(p0[0],p0[1],p0[2], p1[0],p1[1],p1[2], p2[0],p2[1],p2[2], p3[0],p3[1],p3[2]);
      for (var q = 0; q < 4; q++) nrm.push(n[0], n[1], n[2]);
      for (q = 0; q < 4; q++) uv.push(uvs[q][0], uvs[q][1]);
      /* Wound so the face the pitch can see is the front face. The perimeter
         path runs counter-clockwise seen from above, so p0->p1 is the tangent
         and p0->p3 is up or outward; taking them in that order puts every
         normal on the outside of the bowl, which is the one side no camera in
         this game will ever be on. The whole stand was invisible until this
         was reversed — and it did not look like a culling bug, it looked like
         a stand that had failed to build. */
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
      v += 4;
    }

    for (i = 0; i < BOWL.K; i++) {
      var a = path[i], b = path[i + 1];

      /* the perimeter wall the front row sits on top of */
      /* uv.y runs -1 at the foot to 0 at the top, and a negative row is how
         the shader knows it is looking at the wall rather than the rake */
      quad([a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, BOWL.base], [a.x, a.y, BOWL.base],
           [-a.nx, -a.ny, 0],
           [[a.t, -1], [b.t, -1], [b.t, 0], [a.t, 0]]);

      for (r = 0; r < BOWL.rows; r++) {
        var o0 = r * BOWL.run, o1 = o0 + BOWL.run;
        var z0 = BOWL.base + r * BOWL.rise, z1 = z0 + BOWL.rise;
        var rt = (r + 1) / BOWL.rows;
        var A = [a.x + a.nx * o0, a.y + a.ny * o0, z0];
        var Ab = [b.x + b.nx * o0, b.y + b.ny * o0, z0];
        var B = [a.x + a.nx * o1, a.y + a.ny * o1, z0];
        var Bb = [b.x + b.nx * o1, b.y + b.ny * o1, z0];
        var C = [a.x + a.nx * o1, a.y + a.ny * o1, z1];
        var Cb = [b.x + b.nx * o1, b.y + b.ny * o1, z1];
        /* tread, then the riser behind it */
        quad(A, Ab, Bb, B, [0, 0, 1], [[a.t, rt], [b.t, rt], [b.t, rt], [a.t, rt]]);
        quad(B, Bb, Cb, C, [-a.nx, -a.ny, 0], [[a.t, rt], [b.t, rt], [b.t, rt], [a.t, rt]]);
      }
    }

    MESH.stand = GLX.mesh(P.stand, [
      { name: "aPos", size: 3, data: new Float32Array(pos) },
      { name: "aNrm", size: 3, data: new Float32Array(nrm) },
      { name: "aUv", size: 2, data: new Float32Array(uv) }
    ], new Uint32Array(idx));

    /* ---- roof: an underside and a fascia, nothing else. The top of a roof
       is never in frame from inside a stadium, so it is not built. ---- */
    pos = []; nrm = []; uv = []; idx = []; v = 0;
    var oTop = BOWL.rows * BOWL.run;
    var zTop = BOWL.base + BOWL.rows * BOWL.rise + BOWL.roofLift;
    var oIn = oTop - BOWL.roofOver;
    for (i = 0; i < BOWL.K; i++) {
      var a2 = path[i], b2 = path[i + 1];
      var Ai = [a2.x + a2.nx * oIn, a2.y + a2.ny * oIn, zTop];
      var Bi = [b2.x + b2.nx * oIn, b2.y + b2.ny * oIn, zTop];
      var Ao = [a2.x + a2.nx * (oTop + 2), a2.y + a2.ny * (oTop + 2), zTop + 1.5];
      var Bo = [b2.x + b2.nx * (oTop + 2), b2.y + b2.ny * (oTop + 2), zTop + 1.5];
      /* uv.y runs 1 at the inner lip to 2 at the back, which is what lets the
         shader hang the light banks off the front edge where they belong */
      quad(Bi, Ai, Ao, Bo, [0, 0, -1],
           [[b2.t, 1], [a2.t, 1], [a2.t, 2], [b2.t, 2]]);
      /* the fascia hanging off the front edge — where a ground puts its name */
      var Af = [Ai[0], Ai[1], zTop - 1.7], Bf = [Bi[0], Bi[1], zTop - 1.7];
      quad(Af, Bf, Bi, Ai, [-a2.nx, -a2.ny, 0],
           [[a2.t, 1], [b2.t, 1], [b2.t, 1], [a2.t, 1]]);
    }
    MESH.roof = GLX.mesh(P.stand, [
      { name: "aPos", size: 3, data: new Float32Array(pos) },
      { name: "aNrm", size: 3, data: new Float32Array(nrm) },
      { name: "aUv", size: 2, data: new Float32Array(uv) }
    ], new Uint32Array(idx));

    /* board and seat frequency come from the real arc length of the wall, not
       from a number that looked right — a board is 5.2 m wide wherever it is */
    var wallLen = 0;
    for (i = 0; i < BOWL.K; i++) {
      wallLen += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    }
    var ads = (typeof ADS !== "undefined") ? ADS.length : 1;
    BOARD_REP = Math.max(1, Math.round(wallLen / BOARD_M / ads));
    SEATS_ROUND = Math.round(wallLen / 0.54);
    TEX.boards = boardTexture();

    buildCrowd(path);
  }

  /* The hoardings, as a texture rather than as geometry. render.js draws each
     board as a quad with quadText() over it; here the whole run is one strip
     repeated around the bowl, which is one draw and stays sharp at any angle
     because the sampler is doing anisotropic filtering rather than the
     painter's algorithm.

     Same sponsors, same colours, same order as ADS in render.js — a different
     set of boards in the two renderers would be a tell every time the flag was
     flipped. */
  var BOARD_M = 5.2;              // metres per board, as the canvas renderer uses
  function boardTexture() {
    var ads = (typeof ADS !== "undefined") ? ADS : [{ t: "goal.io", bg: "#f4f7fa", fg: "#12305a" }];
    var PW = 256, PH = 96;
    var c = document.createElement("canvas");
    c.width = PW * ads.length; c.height = PH;
    var x = c.getContext("2d");
    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      x.fillStyle = ad.bg;
      x.fillRect(i * PW, 0, PW, PH);
      x.fillStyle = ad.fg;
      x.font = "900 " + Math.round(PH * 0.52) + "px 'Arial Narrow', Haettenschweiler, Impact, system-ui, sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(ad.t, i * PW + PW / 2, PH * 0.55);
      x.strokeStyle = "rgba(0,0,0,.22)"; x.lineWidth = 3;
      x.strokeRect(i * PW + 1.5, 1.5, PW - 3, PH - 3);
    }
    /* the dark lip along the top, which is what stops a board reading as a
       painted stripe on a wall */
    x.fillStyle = "#20262e";
    x.fillRect(0, 0, c.width, PH * 0.07);
    return GLX.texFromCanvas(c, { repeat: true });
  }

  var BOARD_REP = 8, SEATS_ROUND = 700;
  var CROWD_N = 0;
  function buildCrowd(path) {
    var seats = [], cols = [], seeds = [];
    var pal = (typeof CROWD_COLS !== "undefined") ? CROWD_COLS : ["#d9ab80", "#f3ece1"];
    var palRGB = pal.map(function (c) { return GLX.col3(c, [0, 0, 0]); });
    var home = GLX.col3(COL.us, [0, 0, 0]);
    var homeAlt = GLX.col3(COL.usAlt, [0, 0, 0]);
    var away = GLX.col3(COL.them, [0, 0, 0]);

    /* The away end is deliberately off-centre. A ground with the visiting
       support sitting symmetrically opposite the home end looks like a
       diagram; real away allocations are a wedge in one corner. */
    var awayFrom = 0.615, awayTo = 0.695;

    var spacing = 0.54;
    for (var r = 0; r < BOWL.rows; r++) {
      var o = r * BOWL.run + BOWL.run * 0.55;
      var z = BOWL.base + r * BOWL.rise + 0.30;
      /* arc length of this ring, so seat spacing stays physical as the bowl
         widens toward the back */
      var len = 0, i;
      for (i = 0; i < BOWL.K; i++) {
        var p0 = path[i], p1 = path[i + 1];
        len += Math.hypot((p1.x + p1.nx * o) - (p0.x + p0.nx * o),
                          (p1.y + p1.ny * o) - (p0.y + p0.ny * o));
      }
      var n = Math.max(24, Math.floor(len / spacing));
      for (var s = 0; s < n; s++) {
        var t = (s + 0.5) / n;
        var fi = t * BOWL.K, i0 = Math.floor(fi), fr = fi - i0;
        var pa = path[Math.min(i0, BOWL.K)], pb = path[Math.min(i0 + 1, BOWL.K)];
        var nx = pa.nx + (pb.nx - pa.nx) * fr, ny = pa.ny + (pb.ny - pa.ny) * fr;
        var nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        var px = pa.x + (pb.x - pa.x) * fr + nx * o;
        var py = pa.y + (pb.y - pa.y) * fr + ny * o;

        /* Gangways. A vomitory painted on as a dark quad reads as a sticker
           and a modelled recess reads as a grey chevron — both were tried on
           canvas. What it actually is, seen from the pitch, is a column with
           nobody in it and the steps showing through, so that is what this
           does: it skips the seats and lets the rake be visible. */
        var gw = Math.abs(((t * 16.0) % 1.0) - 0.5);
        if (gw > 0.474) continue;

        /* empty seats, and more of them high in the corners — a bowl filled
           uniformly to the last seat is the tell of a rendered crowd */
        var corner = Math.min(Math.abs(Math.abs(px) - BOWL.hx), Math.abs(Math.abs(py) - BOWL.hy));
        var empty = 0.035 + (r / BOWL.rows) * 0.06 + (corner > 6 ? 0.05 : 0);
        if (Math.random() < empty) continue;

        var c;
        if (t > awayFrom && t < awayTo) {
          c = Math.random() < 0.72 ? away : palRGB[(Math.random() * palRGB.length) | 0];
        } else if (Math.random() < 0.30) {
          c = Math.random() < 0.6 ? home : homeAlt;
        } else {
          c = palRGB[(Math.random() * palRGB.length) | 0];
        }
        seats.push(px + (Math.random() - 0.5) * 0.10,
                   py + (Math.random() - 0.5) * 0.10,
                   z + (Math.random() - 0.5) * 0.05);
        cols.push(c[0], c[1], c[2]);
        seeds.push(Math.random());
      }
    }

    CROWD_N = seeds.length;
    MESH.crowd = GLX.mesh(P.crowd, [
      { name: "aPos", size: 2,
        data: new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
                                -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]) },
      { name: "aIns", size: 3, divisor: 1, data: new Float32Array(seats) },
      { name: "aCol", size: 3, divisor: 1, data: new Float32Array(cols) },
      { name: "aSeed", size: 1, divisor: 1, data: new Float32Array(seeds) }
    ], null, 6);
  }

  /* ==================================================================== */
  /* solid geometry: ball, posts                                           */
  /* ==================================================================== */

  var SOLID_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  uniform mat4 uVP, uModel;
  uniform mat3 uNrm;
  out vec3 vW, vN, vL;
  void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    vW = w.xyz;
    vN = normalize(uNrm * aNrm);
    vL = aPos;                       // object space, for the panel pattern
    gl_Position = uVP * w;
  }
  `;

  var BALL_FS = HEAD + COMMON + `
  in vec3 vW, vN, vL;
  out vec4 oCol;
  uniform vec3 uBase, uPanel;
  uniform mat3 uSpin;

  /* A real football is a truncated icosahedron: twelve pentagons centred on
     the icosahedral directions, hexagons filling the rest. Testing the normal
     against those twelve directions gives the pattern at any resolution with
     no texture and no seam — and it rotates with the ball because the test is
     done in object space. */
  const float PH = 0.52573111;   // 1/sqrt(1+phi^2)
  const float PG = 0.85065081;   // phi/sqrt(1+phi^2)

  float panelMask(vec3 n) {
    vec3 d[6];
    d[0] = vec3( 0.0,  PH,  PG); d[1] = vec3( 0.0, -PH,  PG);
    d[2] = vec3( PH,  PG,  0.0); d[3] = vec3(-PH,  PG,  0.0);
    d[4] = vec3( PG,  0.0,  PH); d[5] = vec3( PG,  0.0, -PH);
    float best = 0.0;
    for (int i = 0; i < 6; i++) best = max(best, abs(dot(n, d[i])));
    return best;
  }

  void main() {
    vec3 N = normalize(vN);
    vec3 V = uEye - vW;
    float dist = length(V);
    V /= dist;

    vec3 n0 = normalize(uSpin * normalize(vL));
    float pm = panelMask(n0);
    /* the seam is the boundary itself, darker than either panel */
    float aa = fwidth(pm) * 1.2 + 0.002;
    float pent = smoothstep(0.9755 - aa, 0.9755 + aa, pm);
    float seam = smoothstep(0.966 - aa, 0.966, pm) * (1.0 - smoothstep(0.985, 0.985 + aa, pm));
    vec3 c = mix(uBase, uPanel, pent);
    c *= 1.0 - seam * 0.45;

    float ndl = max(dot(N, uLight), 0.0);
    vec3 Hv = normalize(uLight + V);
    float spec = pow(max(dot(N, Hv), 0.0), 42.0) * (0.30 + uWet * 0.9);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);

    vec3 lit = c * (0.40 + 0.75 * ndl) + uSkyH * c * 0.22;
    lit += vec3(1.0, 0.98, 0.94) * spec;
    lit += uSkyH * rim * 0.28;

    oCol = vec4(grade(applyFog(lit, dist)), 1.0);
  }
  `;

  var METAL_FS = HEAD + COMMON + `
  in vec3 vW, vN, vL;
  out vec4 oCol;
  uniform vec3 uBase;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = uEye - vW;
    float dist = length(V);
    V /= dist;
    float ndl = max(dot(N, uLight), 0.0);
    vec3 Hv = normalize(uLight + V);
    float spec = pow(max(dot(N, Hv), 0.0), 70.0);
    /* a goalpost is a gloss-white cylinder: the highlight running down it is
       the whole reason it reads as round rather than as a white stripe */
    vec3 lit = uBase * (0.46 + 0.62 * ndl) + uSkyH * uBase * 0.20;
    lit += vec3(1.0) * spec * 0.75;
    oCol = vec4(grade(applyFog(lit, dist)), 1.0);
  }
  `;

  /* The net is a surface, not a texture on a quad: alpha comes from a grid in
     surface coordinates so the cord thickness is right at every distance, and
     the back panel is denser than the sides exactly as a real net is. */
  var NET_FS = HEAD + COMMON + `
  in vec3 vW, vN, vL;
  in vec2 vUv;
  out vec4 oCol;
  uniform float uCell;
  void main() {
    vec3 V = uEye - vW;
    float dist = length(V);
    V /= dist;

    vec2 g = fract(vUv / uCell) - 0.5;
    float aa = max(fwidth(vUv.x), fwidth(vUv.y)) / uCell * 0.9 + 0.02;
    float cord = max(1.0 - smoothstep(0.0, 0.06 + aa, abs(g.x)),
                     1.0 - smoothstep(0.0, 0.06 + aa, abs(g.y)));

    float ndl = abs(dot(normalize(vN), uLight));
    vec3 c = vec3(0.93, 0.95, 0.98) * (0.45 + 0.55 * ndl);
    /* grazing angles see more cord per pixel — this is what makes a net read
       as a volume from the side and as a haze from the front */
    float graze = 1.0 - abs(dot(normalize(vN), V));
    float a = clamp(cord * (0.55 + 0.45 * graze) + graze * 0.10, 0.0, 1.0);
    a *= 1.0 - clamp(fogAmount(dist), 0.0, 0.9);
    oCol = vec4(grade(applyFog(c, dist)) * a, a);
  }
  `;

  var NET_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  in vec2 aUv;
  uniform mat4 uVP, uModel;
  uniform mat3 uNrm;
  out vec3 vW, vN, vL;
  out vec2 vUv;
  void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    vW = w.xyz; vN = normalize(uNrm * aNrm); vL = aPos; vUv = aUv;
    gl_Position = uVP * w;
  }
  `;

  /* THE MOTION TRAIL.

     Taking drawBall() away took the trail with it, and a struck ball with no
     comet behind it reads as slower than the same ball with one — the canvas
     renderer scales its width and opacity by pace for exactly that reason, and
     this keeps the same rule. Built as camera-facing quads in world space so
     it sits correctly in the depth buffer instead of being painted over
     everything the way a 2D stroke has to be. */
  var TRAIL_VS = HEAD + `
  in vec3 aPos;
  in vec2 aUv;                 // x: alpha along the trail
  uniform mat4 uVP;
  out float vA;
  void main() { vA = aUv.x; gl_Position = uVP * vec4(aPos, 1.0); }
  `;

  var TRAIL_FS = HEAD + `
  precision highp float;
  in float vA;
  out vec4 oCol;
  void main() { oCol = vec4(vec3(0.839, 0.925, 1.0) * vA, vA); }
  `;

  /* depth-only pass for the shadow map */
  var DEPTH_VS = HEAD + `
  in vec3 aPos;
  uniform mat4 uVP, uModel;
  void main() { gl_Position = uVP * uModel * vec4(aPos, 1.0); }
  `;
  var DEPTH_FS = HEAD + `
  out vec4 oCol;
  void main() { oCol = vec4(1.0); }
  `;

  /* ==================================================================== */
  /* mesh builders                                                         */
  /* ==================================================================== */

  function sphere(rows, cols) {
    var pos = [], nrm = [], idx = [], r, c;
    for (r = 0; r <= rows; r++) {
      var v = r / rows, th = v * Math.PI, sr = Math.sin(th), cr = Math.cos(th);
      for (c = 0; c <= cols; c++) {
        var u = c / cols, ph = u * Math.PI * 2;
        var x = sr * Math.cos(ph), y = sr * Math.sin(ph), z = cr;
        pos.push(x, y, z); nrm.push(x, y, z);
      }
    }
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        var a = r * (cols + 1) + c, b = a + cols + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm),
             idx: new Uint16Array(idx) };
  }

  /* A capsule-ended cylinder along +z, unit radius, unit length. Posts are
     drawn from it with a scale, which is why the caps are hemispheres: a
     rounded post end is what a modern goal frame actually looks like and a
     flat disc reads as a cut-off pipe. */
  function post(seg) {
    var pos = [], nrm = [], idx = [], i, j;
    var rings = [
      { z: 0.0, r: 1.0, nz: 0 }, { z: 1.0, r: 1.0, nz: 0 }
    ];
    for (i = 0; i <= seg; i++) {
      var a = i / seg * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
      for (j = 0; j < rings.length; j++) {
        pos.push(cx * rings[j].r, cy * rings[j].r, rings[j].z);
        nrm.push(cx, cy, 0);
      }
    }
    for (i = 0; i < seg; i++) {
      var a0 = i * 2, a1 = (i + 1) * 2;
      idx.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1);
    }
    /* end caps, flat but shaded from the side normal so they never flare */
    var base = pos.length / 3;
    pos.push(0, 0, 0); nrm.push(0, 0, -1);
    pos.push(0, 0, 1); nrm.push(0, 0, 1);
    for (i = 0; i < seg; i++) {
      idx.push(base, (i + 1) * 2, i * 2);
      idx.push(base + 1, i * 2 + 1, (i + 1) * 2 + 1);
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm),
             idx: new Uint16Array(idx) };
  }

  /* One net panel: a quad with uv in metres so the cord spacing is physical.
     sag pulls the far edge in, which is what a hung net does. */
  function netPanel(a, b, c, d, sag) {
    var N = 8, pos = [], nrm = [], uv = [], idx = [], i, j;
    function lerp3(p, q, t) {
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    }
    var wide = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var tall = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    for (j = 0; j <= N; j++) {
      var tv = j / N;
      for (i = 0; i <= N; i++) {
        var tu = i / N;
        var p0 = lerp3(a, b, tu), p1 = lerp3(d, c, tu);
        var p = lerp3(p0, p1, tv);
        if (sag) {
          var s = Math.sin(tu * Math.PI) * Math.sin(tv * Math.PI) * sag;
          p[1] += s;
        }
        pos.push(p[0], p[1], p[2]);
        uv.push(tu * wide, tv * tall);
      }
    }
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        var k = j * (N + 1) + i, m = k + N + 1;
        idx.push(k, k + 1, m, k + 1, m + 1, m);
      }
    }
    /* one flat normal for the panel is plenty — the shader only uses it for a
       broad wash and a grazing term */
    var e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    var e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    var nx = e1[1] * e2[2] - e1[2] * e2[1];
    var ny = e1[2] * e2[0] - e1[0] * e2[2];
    var nz = e1[0] * e2[1] - e1[1] * e2[0];
    var mlen = Math.hypot(nx, ny, nz) || 1;
    for (i = 0; i < pos.length / 3; i++) nrm.push(nx / mlen, ny / mlen, nz / mlen);
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm),
             uv: new Float32Array(uv), idx: new Uint16Array(idx) };
  }

  /* ==================================================================== */
  /* boot                                                                  */
  /* ==================================================================== */

  function boot() {
    var host = document.getElementById("game");
    if (!host) return false;

    glc = document.getElementById("gamegl");
    if (!glc) {
      glc = document.createElement("canvas");
      glc.id = "gamegl";
      glc.style.cssText = "position:fixed;inset:0;display:block;z-index:0";
      host.parentNode.insertBefore(glc, host);
      /* the 2D canvas has to stop being opaque or it hides all of this */
      host.style.zIndex = "1";
      host.style.background = "transparent";
    }

    gl = GLX.init(glc);
    if (!gl) { console.warn("[gl] no WebGL2 — staying on canvas"); return false; }

    P.sky    = GLX.prog("sky", SKY_VS, SKY_FS);
    P.ground = GLX.prog("ground", GROUND_VS, groundFrag());
    P.ball   = GLX.prog("ball", SOLID_VS, BALL_FS);
    P.metal  = GLX.prog("metal", SOLID_VS, METAL_FS);
    P.net    = GLX.prog("net", NET_VS, NET_FS);
    P.depth  = GLX.prog("depth", DEPTH_VS, DEPTH_FS);
    P.stand  = GLX.prog("stand", STAND_VS, STAND_FS);
    P.crowd  = GLX.prog("crowd", CROWD_VS, CROWD_FS);
    P.trail  = GLX.prog("trail", TRAIL_VS, TRAIL_FS);
    for (var k in P) {
      if (P.hasOwnProperty(k) && !P[k]) { console.error("[gl] program " + k + " failed"); return false; }
    }

    MESH.sky = GLX.mesh(P.sky, [{ name: "aPos", size: 2,
      data: new Float32Array([-1, -1, 3, -1, -1, 3]) }], null, 3);

    /* the far edge has to sit beyond the point where fog has taken it fully
       to the horizon colour, or the edge of the quad reads as a horizon of
       its own — cheap, because it is two triangles either way */
    var g = PITCH.halfW + SURROUND + 170, gl2 = PITCH.halfL + SURROUND + 170;
    MESH.ground = GLX.mesh(P.ground, [{ name: "aPos", size: 2,
      data: new Float32Array([-g, -gl2, g, -gl2, g, gl2, -g, -gl2, g, gl2, -g, gl2]) }],
      null, 6);

    var sp = sphere(20, 28);
    MESH.ball = GLX.mesh(P.ball,
      [{ name: "aPos", size: 3, data: sp.pos }, { name: "aNrm", size: 3, data: sp.nrm }],
      sp.idx);
    MESH.ballDepth = GLX.mesh(P.depth, [{ name: "aPos", size: 3, data: sp.pos }], sp.idx);

    var po = post(14);
    MESH.post = GLX.mesh(P.metal,
      [{ name: "aPos", size: 3, data: po.pos }, { name: "aNrm", size: 3, data: po.nrm }],
      po.idx);

    buildNets();
    buildBowl();

    /* the trail is rebuilt every frame, so it gets one buffer big enough for
       the longest tape the sim will ever hand over */
    TRAIL_MAX = 96;
    MESH.trail = GLX.mesh(P.trail, [
      { name: "aPos", size: 3, dynamic: true, data: new Float32Array(TRAIL_MAX * 6 * 3) },
      { name: "aUv", size: 2, dynamic: true, data: new Float32Array(TRAIL_MAX * 6 * 2) }
    ], null, 0);

    SHADOW = GLX.depthTarget(SHADOW_SIZE);
    size();
    /* set here rather than in the initRender wrapper so the harness can call
       GLR.boot() on a page that has already started */
    live = true;
    return true;
  }

  /* Both goals. The mouth is 7.32 x 2.44, the net is 1.6 m deep at the foot
     and 0.9 m at the crossbar, which is the standard stanchion shape. */
  var NETS = [];
  function buildNets() {
    NETS = [];
    var gh = PITCH.goalHalf, cb = PITCH.crossbar;
    [-1, 1].forEach(function (s) {
      var gy = s === -1 ? GOAL_Y : OWN_GOAL_Y;
      var dTop = 0.9 * s, dBot = 1.7 * s;   // net depth behind the line
      var panels = [
        /* back */
        netPanel([-gh, gy + dBot, 0], [gh, gy + dBot, 0],
                 [gh, gy + dTop, cb], [-gh, gy + dTop, cb], 0.10 * s),
        /* sides */
        netPanel([-gh, gy, 0], [-gh, gy + dBot, 0],
                 [-gh, gy + dTop, cb], [-gh, gy, cb], 0),
        netPanel([gh, gy + dBot, 0], [gh, gy, 0],
                 [gh, gy, cb], [gh, gy + dTop, cb], 0),
        /* roof */
        netPanel([-gh, gy, cb], [gh, gy, cb],
                 [gh, gy + dTop, cb], [-gh, gy + dTop, cb], -0.06 * s)
      ];
      panels.forEach(function (pan, i) {
        NETS.push({
          mesh: GLX.mesh(P.net,
            [{ name: "aPos", size: 3, data: pan.pos },
             { name: "aNrm", size: 3, data: pan.nrm },
             { name: "aUv", size: 2, data: pan.uv }], pan.idx),
          /* the back panel is the one you look through at a goal, so it is
             denser — a uniform cell size makes the whole thing read as gauze */
          cell: i === 0 ? 0.105 : 0.135,
          y: gy
        });
      });
    });
  }

  function size() {
    var d = Math.min(window.devicePixelRatio || 1, 2.5);
    var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    W = Math.round(w * d); H = Math.round(h * d);
    if (glc.width !== W || glc.height !== H) {
      glc.width = W; glc.height = H;
      glc.style.width = w + "px"; glc.style.height = h + "px";
    }
  }

  /* ==================================================================== */
  /* frame                                                                 */
  /* ==================================================================== */

  function camera() {
    eye[0] = Cam.px; eye[1] = Cam.py; eye[2] = Cam.pz;
    at[0] = Cam.tx;  at[1] = Cam.ty;  at[2] = Cam.tz;
    M4.look(mView, eye, at, up);

    /* Cam.F is focal length in CSS pixels over the portrait play area, and
       FEEL punches it. Converting back to an angle here means the zoom punch
       and the cinematic push drive this renderer with no extra plumbing. */
    var zm = (typeof FEEL !== "undefined") ? FEEL.zoomMul() : 1;
    if (typeof FEEL !== "undefined" && FEEL.cinePush) zm *= 1 + FEEL.cinePush();
    var F = Cam.F * zm;
    FOVY = 2 * Math.atan((VP.h / 2) / F);
    var aspect = VP.w / VP.h;
    M4.persp(mProj, FOVY, aspect, NEARZ, FAR);

    /* shake, applied in clip space so the GL layer and the 2D overlay move as
       one picture. Clip to the viewport first — the same trap as the canvas
       renderer, and here the viewport call has already done it. */
    if (typeof FEEL !== "undefined") {
      var sh = FEEL.shakeOffset();
      if (sh.x || sh.y || sh.rot) {
        M4.rotZ(mTmp, -sh.rot);
        mTmp[12] = 2 * sh.x / VP.w;
        mTmp[13] = -2 * sh.y / VP.h;
        M4.mul(mTmp2, mTmp, mProj);
        mProj.set(mTmp2);
      }
    }

    M4.mul(mVP, mProj, mView);

    /* view basis, for the sky ray */
    var fx = at[0] - eye[0], fy = at[1] - eye[1], fz = at[2] - eye[2];
    var m = Math.hypot(fx, fy, fz) || 1;
    basis.f[0] = fx / m; basis.f[1] = fy / m; basis.f[2] = fz / m;
    var rx = basis.f[1] * up[2] - basis.f[2] * up[1];
    var ry = basis.f[2] * up[0] - basis.f[0] * up[2];
    var rz = basis.f[0] * up[1] - basis.f[1] * up[0];
    m = Math.hypot(rx, ry, rz) || 1;
    basis.r[0] = rx / m; basis.r[1] = ry / m; basis.r[2] = rz / m;
    basis.u[0] = basis.r[1] * basis.f[2] - basis.r[2] * basis.f[1];
    basis.u[1] = basis.r[2] * basis.f[0] - basis.r[0] * basis.f[2];
    basis.u[2] = basis.r[0] * basis.f[1] - basis.r[1] * basis.f[0];
  }

  /* An orthographic light camera centred on the action. Keeping it tight to
     the ball is what buys a sharp contact shadow out of 1024 texels. */
  function lightCamera(world) {
    var cx = world.ball.x, cy = world.ball.y;
    var L = LIGHT;
    var d = 60;
    var le = [cx + L.x * d, cy + L.y * d, L.z * d];
    M4.look(mLightV, le, [cx, cy, 0], [0, 0, 1]);
    M4.ortho(mLightP, -SHADOW_HALF, SHADOW_HALF, -SHADOW_HALF, SHADOW_HALF, 1, d * 2.2);
    M4.mul(mLightVP, mLightP, mLightV);
  }

  function setCommon(prg, dist) {
    var C = cond();
    GLX.col3(C.sky[2], c3);
    gl.uniform3f(prg.u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(prg.u.uLight, LIGHT.x, LIGHT.y, LIGHT.z);
    gl.uniform3f(prg.u.uSkyH, c3[0], c3[1], c3[2]);
    gl.uniform4f(prg.u.uCond, C.light, C.warm, C.flood, C.haze);
    gl.uniform1f(prg.u.uWet, C.wet);
    gl.uniform4f(prg.u.uViewport, vpx(), vpy(), VP.w * dpr(), VP.h * dpr());
    if (prg.u.uVP) gl.uniformMatrix4fv(prg.u.uVP, false, mVP);
  }

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2.5); }
  function vpx() { return Math.round(VP.x * dpr()); }
  function vpy() { return Math.round(H - (VP.y + VP.h) * dpr()); }

  var nrm3 = new Float32Array(9);
  function normalMat(m) {
    /* uniform scales only in this renderer, so the upper 3x3 normalised is the
       correct normal matrix and there is no inverse-transpose to get wrong */
    var sx = 1 / (Math.hypot(m[0], m[1], m[2]) || 1);
    var sy = 1 / (Math.hypot(m[4], m[5], m[6]) || 1);
    var sz = 1 / (Math.hypot(m[8], m[9], m[10]) || 1);
    nrm3[0] = m[0] * sx; nrm3[1] = m[1] * sx; nrm3[2] = m[2] * sx;
    nrm3[3] = m[4] * sy; nrm3[4] = m[5] * sy; nrm3[5] = m[6] * sy;
    nrm3[6] = m[8] * sz; nrm3[7] = m[9] * sz; nrm3[8] = m[10] * sz;
    return nrm3;
  }

  var TRAIL_MAX = 96, trailPos = null, trailUv = null;

  function focalPx() { return (VP.h / 2) / Math.tan(FOVY / 2); }

  /* A CONTINUOUS ribbon along the trail, not one quad per segment.

     Per-segment quads were the first attempt and they stack: the trail runs
     almost straight down the view axis, so consecutive quads overlap heavily
     in screen space, and under additive blending that overlap turns a tapering
     comet into a solid pale bar. Sharing the edge between segments means each
     pixel is written once and the taper survives. */
  function buildTrail(b) {
    var t = b.trail;
    if (!t || t.length < 3) return 0;
    if (!trailPos) {
      trailPos = new Float32Array(TRAIL_MAX * 6 * 3);
      trailUv = new Float32Array(TRAIL_MAX * 6 * 2);
    }
    var speed = b.speed ? b.speed() : Math.hypot(b.vx || 0, b.vy || 0);
    var pace = Math.max(0, Math.min(1, speed / 30));
    var fpx = focalPx();
    var n = Math.min(t.length, TRAIL_MAX);
    var i0 = t.length - n;

    /* one left/right pair per point, then stitch */
    var L = new Float32Array(n * 3), R = new Float32Array(n * 3), A = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var p = t[i0 + i];
      var pa = t[Math.max(i0, i0 + i - 1)], pb = t[Math.min(t.length - 1, i0 + i + 1)];
      var dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
      var ex = p.x - eye[0], ey = p.y - eye[1], ez = p.z + 0.12 - eye[2];
      var sx = dy * ez - dz * ey, sy = dz * ex - dx * ez, sz = dx * ey - dy * ex;
      var m = Math.hypot(sx, sy, sz);
      var a = (i + 1) / n;
      A[i] = a * a * (0.10 + pace * 0.34) * 0.55;
      var w = 0.11 * a * (1 + pace * 1.4);
      /* clamp in PIXELS, as the canvas trail does — a fixed world width turns
         the segments nearest the lens into a wedge across the frame */
      var perPx = (Math.hypot(ex, ey, ez) || 1) / fpx;
      w = Math.max(0.7 * perPx, Math.min(w, 9 * perPx));
      if (m < 1e-6) { sx = 1; sy = 0; sz = 0; m = 1; }
      sx = sx / m * w; sy = sy / m * w; sz = sz / m * w;
      L[i * 3] = p.x - sx; L[i * 3 + 1] = p.y - sy; L[i * 3 + 2] = p.z + 0.12 - sz;
      R[i * 3] = p.x + sx; R[i * 3 + 1] = p.y + sy; R[i * 3 + 2] = p.z + 0.12 + sz;
    }

    var vi = 0, ui = 0, quads = 0;
    for (i = 0; i < n - 1; i++) {
      if (A[i] < 0.003 && A[i + 1] < 0.003) continue;
      var v = [
        [L[i*3], L[i*3+1], L[i*3+2], A[i]],
        [R[i*3], R[i*3+1], R[i*3+2], A[i]],
        [R[(i+1)*3], R[(i+1)*3+1], R[(i+1)*3+2], A[i+1]],
        [L[i*3], L[i*3+1], L[i*3+2], A[i]],
        [R[(i+1)*3], R[(i+1)*3+1], R[(i+1)*3+2], A[i+1]],
        [L[(i+1)*3], L[(i+1)*3+1], L[(i+1)*3+2], A[i+1]]
      ];
      for (var k = 0; k < 6; k++) {
        trailPos[vi++] = v[k][0]; trailPos[vi++] = v[k][1]; trailPos[vi++] = v[k][2];
        trailUv[ui++] = v[k][3]; trailUv[ui++] = 0;
      }
      quads++;
    }
    if (!quads) return 0;
    GLX.update(MESH.trail, "aPos", trailPos);
    GLX.update(MESH.trail, "aUv", trailUv);
    return quads * 6;
  }

  var spin3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  function ballSpin(b) {
    /* roll about the axis across the direction of travel. sim.js already keeps
       ball.rot as the visual roll angle, so this only has to choose an axis
       and turn it into a matrix. */
    var vx = b.vx, vy = b.vy, s = Math.hypot(vx, vy);
    var ax, ay;
    if (s < 0.01) { ax = 1; ay = 0; } else { ax = -vy / s; ay = vx / s; }
    var a = b.rot || 0, c = Math.cos(a), si = Math.sin(a), t = 1 - c;
    var az = 0;
    spin3[0] = t*ax*ax + c;      spin3[1] = t*ax*ay + si*az; spin3[2] = t*ax*az - si*ay;
    spin3[3] = t*ax*ay - si*az;  spin3[4] = t*ay*ay + c;     spin3[5] = t*ay*az + si*ax;
    spin3[6] = t*ax*az + si*ay;  spin3[7] = t*ay*az - si*ax; spin3[8] = t*az*az + c;
    return spin3;
  }

  function drawPosts(prg, depthOnly) {
    var r = 0.06, gh = PITCH.goalHalf, cb = PITCH.crossbar;
    [-1, 1].forEach(function (s) {
      var gy = s === -1 ? GOAL_Y : OWN_GOAL_Y;
      /* uprights */
      [-gh, gh].forEach(function (x) {
        M4.trs(mModel, x, gy, 0, r, r, cb);
        emit(prg, MESH.post, depthOnly);
      });
      /* Crossbar. The unit post runs along +z, so instead of a general
         rotation the columns are written directly: object z becomes world x
         at the bar's length, object x and y become the cross-section. It is a
         cyclic swap, so the determinant stays positive and the winding — and
         therefore the backface culling — survives. */
      mModel[0]  = 0;       mModel[1]  = r;  mModel[2]  = 0;  mModel[3]  = 0;
      mModel[4]  = 0;       mModel[5]  = 0;  mModel[6]  = r;  mModel[7]  = 0;
      mModel[8]  = 2 * gh;  mModel[9]  = 0;  mModel[10] = 0;  mModel[11] = 0;
      mModel[12] = -gh;     mModel[13] = gy; mModel[14] = cb; mModel[15] = 1;
      emit(prg, MESH.post, depthOnly);
    });
  }

  function emit(prg, mesh, depthOnly) {
    gl.uniformMatrix4fv(prg.u.uModel, false, mModel);
    if (!depthOnly && prg.u.uNrm) gl.uniformMatrix3fv(prg.u.uNrm, false, normalMat(mModel));
    GLX.draw(mesh);
  }

  function frame(world, drag, dt) {
    if (!live || !world) return;
    size();
    camera();
    lightCamera(world);

    var b = world.ball, R = PHYS.BALL_R;

    /* ---- shadow pass -------------------------------------------------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, SHADOW.fb);
    gl.viewport(0, 0, SHADOW.size, SHADOW.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    var D = GLX.use(P.depth);
    gl.uniformMatrix4fv(D.u.uVP, false, mLightVP);
    M4.trs(mModel, b.x, b.y, b.z + R, R, R, R);
    emit(D, MESH.ballDepth, true);
    drawPosts(D, true);
    gl.colorMask(true, true, true, true);

    /* ---- main pass ---------------------------------------------------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* everything is drawn inside the portrait play area, exactly like VP */
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(vpx(), vpy(), Math.round(VP.w * dpr()), Math.round(VP.h * dpr()));
    gl.scissor(vpx(), vpy(), Math.round(VP.w * dpr()), Math.round(VP.h * dpr()));

    var C = cond();

    /* sky */
    var S = GLX.use(P.sky);
    setCommon(S);
    GLX.col3(C.sky[0], c1); GLX.col3(C.sky[1], c2);
    gl.uniform3f(S.u.uSkyZ, c1[0], c1[1], c1[2]);
    gl.uniform3f(S.u.uSkyM, c2[0], c2[1], c2[2]);
    gl.uniform3f(S.u.uCamR, basis.r[0], basis.r[1], basis.r[2]);
    gl.uniform3f(S.u.uCamU, basis.u[0], basis.u[1], basis.u[2]);
    gl.uniform3f(S.u.uCamF, basis.f[0], basis.f[1], basis.f[2]);
    var ty = Math.tan(FOVY / 2);
    gl.uniform2f(S.u.uTan, ty * (VP.w / VP.h), ty);
    gl.depthMask(false);
    if (DBG.sky) GLX.draw(MESH.sky);
    gl.depthMask(true);

    /* the bowl. Furthest thing away, so it goes down first — and unlike the
       canvas renderer that ordering is only a cache hint, not correctness. */
    var St = GLX.use(P.stand);
    setCommon(St);
    GLX.bindTex(1, TEX.boards);
    gl.uniform1i(St.u.uBoards, 1);
    gl.uniform1f(St.u.uBoardRep, BOARD_REP);
    gl.uniform1f(St.u.uSeats, SEATS_ROUND);
    gl.uniform2f(St.u.uRake, BOWL.base, BOWL.rise);
    GLX.col3(COL.us, c4);
    gl.uniform3f(St.u.uSeat, c4[0] * 0.82, c4[1] * 0.82, c4[2] * 0.82);
    if (DBG.stand) {
      gl.uniform3f(St.u.uBase, 0.60, 0.615, 0.635);
      gl.uniform1f(St.u.uRoof, 0);
      GLX.draw(MESH.stand);
    }
    if (DBG.roof) {
      gl.uniform3f(St.u.uBase, 0.42, 0.44, 0.47);
      gl.uniform1f(St.u.uRoof, 1);
      gl.disable(gl.CULL_FACE);
      GLX.draw(MESH.roof);
      gl.enable(gl.CULL_FACE);
    }

    var Cw = GLX.use(P.crowd);
    setCommon(Cw);
    gl.uniform3f(Cw.u.uCamR, basis.r[0], basis.r[1], basis.r[2]);
    gl.uniform3f(Cw.u.uEyeV, eye[0], eye[1], eye[2]);
    gl.uniform1f(Cw.u.uFocal, (VP.h / 2) / Math.tan(FOVY / 2) * dpr());
    gl.uniform2f(Cw.u.uCrowd,
      (typeof CROWD_T !== "undefined") ? CROWD_T : 0,
      (typeof CROWD_SURGE !== "undefined") ? CROWD_SURGE : 0);
    gl.disable(gl.CULL_FACE);
    if (DBG.crowd) GLX.draw(MESH.crowd, gl.TRIANGLES, CROWD_N);
    gl.enable(gl.CULL_FACE);

    /* turf */
    var G = GLX.use(P.ground);
    setCommon(G);
    GLX.col3(COL.grass1, c1); GLX.col3(COL.grass2, c2);
    gl.uniform3f(G.u.uG1, c1[0], c1[1], c1[2]);
    gl.uniform3f(G.u.uG2, c2[0], c2[1], c2[2]);
    gl.uniform1f(G.u.uBands, 20);
    gl.uniformMatrix4fv(G.u.uLightVP, false, mLightVP);
    gl.uniform1f(G.u.uShadowTexel, 1 / SHADOW.size);
    GLX.bindTex(0, SHADOW.tex);
    gl.uniform1i(G.u.uShadow, 0);
    if (DBG.ground) GLX.draw(MESH.ground);

    /* posts */
    var Mt = GLX.use(P.metal);
    setCommon(Mt);
    gl.uniform3f(Mt.u.uBase, 0.97, 0.98, 1.0);
    if (DBG.posts) drawPosts(Mt, false);

    /* ball */
    var B = GLX.use(P.ball);
    setCommon(B);
    gl.uniform3f(B.u.uBase, 0.97, 0.975, 0.98);
    gl.uniform3f(B.u.uPanel, 0.10, 0.12, 0.16);
    gl.uniformMatrix3fv(B.u.uSpin, false, ballSpin(b));
    M4.trs(mModel, b.x, b.y, b.z + R, R, R, R);
    emit(B, MESH.ball, false);

    /* the trail, additive and depth-tested but not depth-written, so it can
       pass behind a post without punching a hole in it */
    var tn = buildTrail(b);
    if (tn) {
      var T = GLX.use(P.trail);
      gl.uniformMatrix4fv(T.u.uVP, false, mVP);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      MESH.trail.count = tn;
      GLX.draw(MESH.trail);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    /* nets last: translucent, so depth-tested but not depth-written */
    var N = GLX.use(P.net);
    setCommon(N);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    M4.trs(mModel, 0, 0, 0, 1, 1, 1);
    gl.uniformMatrix4fv(N.u.uModel, false, mModel);
    gl.uniformMatrix3fv(N.u.uNrm, false, normalMat(mModel));
    for (var i = 0; i < NETS.length; i++) {
      gl.uniform1f(N.u.uCell, NETS[i].cell);
      GLX.draw(NETS[i].mesh);
    }
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  /* ==================================================================== */
  /* attach                                                                */
  /* ==================================================================== */

  /* The canvas world passes this file takes over. Replacing them rather than
     editing render.js means the canvas renderer is untouched and one line
     flips the whole thing back. */
  var TAKEN = ["drawSky", "drawStadium", "drawDepthHaze", "drawPitch",
               "drawFloodPools", "drawGrain", "drawRings", "drawGoal",
               "drawCornerFlags", "drawBall", "drawGrade"];

  var ORIG = {};        // the canvas passes, kept so they can be put back
  var usingGL = true;

  /* Swap the two renderers inside a single page load.

     This exists for measurement, not for gameplay. Frame times on this machine
     move by up to 5 ms run to run for identical code — wider than most of the
     differences worth measuring — so comparing a GL page load against a canvas
     page load compares thermal states, not renderers. Interleaving them in one
     process is the only honest way to do it. */
  function useCanvas(yes) {
    usingGL = !yes;
    for (var i = 0; i < TAKEN.length; i++) {
      var k = TAKEN[i];
      if (!ORIG[k]) continue;
      window[k] = yes ? ORIG[k] : function () {};
    }
    return { gl: usingGL };
  }

  function attach() {
    var i;
    for (i = 0; i < TAKEN.length; i++) {
      if (typeof window[TAKEN[i]] === "function") {
        ORIG[TAKEN[i]] = window[TAKEN[i]];
        window[TAKEN[i]] = function () {};
      }
    }

    var initCanvas = window.initRender;
    window.initRender = function () {
      initCanvas();
      live = boot();
      if (!live) {
        console.warn("[gl] boot failed — reverting to the canvas renderer");
        location.search = location.search.replace(/[?&]gl=1/, "");
      }
    };

    var render2D = window.renderWorld;
    window.renderWorld = function (world, drag, dt) {
      if (usingGL) frame(world, drag, dt);
      render2D(world, drag, dt);
    };
  }

  on = flagged();
  if (on && typeof window !== "undefined") {
    if (document.readyState === "loading") {
      /* attach before game.js calls initRender(), which it does on load */
      attach();
    } else { attach(); }
  }

  return {
    get on() { return on; },
    get live() { return live; },
    gl: function () { return gl; },
    canvas: function () { return glc; },
    progs: P,
    dbg: DBG,
    useCanvas: useCanvas,
    stats: function () { return { crowd: CROWD_N, rows: BOWL.rows, K: BOWL.K }; },
    frame: frame,
    boot: boot,
    on_: function () { try { localStorage.setItem("goalio_gl", "1"); } catch (e) {} location.reload(); },
    off: function () { try { localStorage.setItem("goalio_gl", "0"); } catch (e) {} location.reload(); }
  };
})();
