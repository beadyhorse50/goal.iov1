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
  var MAX_TEX = 4096;         // driver ceiling, read once the context exists

  /* scratch matrices — allocated once, a renderer that allocates per frame
     hands the GC a sawtooth and the sawtooth is judder */
  var mView = M4.ident(), mProj = M4.ident(), mVP = M4.ident();
  var mInvVP = M4.ident();          // clip -> world, for the post chain
  var prevEye = [0, 0, 0], prevFwd = [0, -1, 0];   // for cut detection
  var POSTING = false;              // did this frame render into the HDR target
  var usePost = true;               // GLR.dbg.post toggles it
  var mTmp = M4.ident(), mTmp2 = M4.ident(), mModel = M4.ident();
  var mLightVP = M4.ident(), mLightV = M4.ident(), mLightP = M4.ident();

  var eye = [0, 0, 0], at = [0, 0, 0], up = [0, 0, 1];
  var basis = { f: [0, 0, -1], r: [1, 0, 0], u: [0, 0, 1] };
  var c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0], c4 = [0, 0, 0];

  var FAR = 400, NEARZ = 0.30, FOVY = 0.9;

  /* ?aa=0 turns FXAA off; it is on by default. */
  var AA = (function () {
    try { return !/[?&]aa=0/.test(location.search); } catch (e) { return true; }
  })();

  /* Per-pass switches. The canvas renderer found its black pitch by disabling
     passes one at a time and reading pixels back, after two confident theories
     about the cause were both wrong. Same trick, made permanent. */
  var DBG = { sky: 1, stand: 1, roof: 1, crowd: 1, ground: 1, posts: 1, ball: 1, net: 1,
              /* post: 0 renders straight to the back buffer, which is how you
                 tell a grading problem from a geometry problem */
              post: 1,
              /* players: 0 hands the actors back to the canvas layer, which is
                 how the hybrid ran before the GL player pass existed */
              players: 1 };
  var SHADOW_SIZE = 1024;
  var SHADOW_HALF = 22;       // metres either side of the shadow camera centre

  /* DEFAULT ON.

     This was opt-in while the renderer was partial. It is the default now
     because it finally wins on both axes at once, measured interleaved in a
     single page load with a readPixels per frame to force GPU completion:

       level 1   GL 7.18 ms   canvas 8.21 ms
       level 5   GL 6.01 ms   canvas 11.06 ms
       level 10  GL 6.20 ms   canvas 10.24 ms

     and the GL frame is doing considerably more work while being cheaper — the
     players, 18,000 individually simulated spectators, a real shadow map, and
     the whole post chain, against a canvas frame with a stride-thinned crowd
     and no post-processing at all.

     `?gl=0` still forces the canvas renderer, and boot() falls back to it
     automatically if WebGL2 or any program fails, so a device that cannot run
     this still gets a working game rather than a black screen. */
  function flagged() {
    try {
      if (/[?&]gl=0/.test(location.search)) return false;
      if (/[?&]gl=1/.test(location.search)) return true;
      var pref = localStorage.getItem("goalio_gl");
      if (pref === "0") return false;
      return true;
    } catch (e) { return true; }
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
  uniform vec3  uSkyZenith;  // the top of the sky, for the ambient probe
  uniform vec3  uSunCol;     // key light radiance, graded by the condition
  uniform float uAmb;        // global ambient scale
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
  /* =====================================================================
     PBR
     =====================================================================

     Before this, every lit shader in the file carried its own lighting: a
     hand-picked ambient constant, a hand-picked Blinn-Phong exponent, and a
     rim term where a Fresnel should have been. Eight shaders, eight different
     models, none of them energy-conserving. Changing the light meant editing
     eight places and re-tuning each one by eye, and a material could not be
     described — only hard-coded.

     This is one model, driven by two numbers per surface: roughness and
     metalness. It is the standard microfacet BRDF — GGX distribution, Smith
     height-correlated visibility, Schlick Fresnel — plus an analytic ambient
     that stands in for an environment probe.

     Why analytic IBL rather than a real cubemap: the sky here IS analytic. It
     is three colours and a gradient, evaluated in the sky shader. Rendering
     that to a cubemap, convolving it for irradiance and prefiltering it for
     specular would be three extra passes to reconstruct information the
     shader already has in closed form. Sampling the same gradient directly
     costs a handful of instructions and is exact rather than filtered.

     The floodlights are real point lights now. Previously the "floodlight
     pools" were a falloff function painted into the ground shader only, so
     the four rigs lit the grass and nothing else — players, the ball and the
     goal frame were entirely unaffected by the lights that are supposedly
     illuminating them. Four overlapping speculars from four rigs is the
     signature of night football and it was absent. */

  var PBR = `
  /* ---- the four floodlight rigs, at their real positions ------------- */
  const vec3 RIG[4] = vec3[4](
    vec3(-37.0, -44.0, 31.0), vec3( 37.0, -44.0, 31.0),
    vec3(-37.0,  44.0, 31.0), vec3( 37.0,  44.0, 31.0)
  );

  const float PI = 3.14159265;

  float d_ggx(float ndh, float a) {
    float a2 = a * a;
    float d = ndh * ndh * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-7);
  }

  /* Smith height-correlated visibility, already divided by the 4*ndl*ndv of
     the BRDF denominator — which is why the specular term below has no
     division in it. */
  float v_smith(float ndv, float ndl, float a) {
    float a2 = a * a;
    float lv = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
    float ll = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
    return 0.5 / max(lv + ll, 1e-6);
  }

  vec3 f_schlick(vec3 f0, float u) {
    float f = pow(1.0 - u, 5.0);
    return f0 + (vec3(1.0) - f0) * f;
  }

  /* One light's contribution. 'rough' is perceptual (0 mirror, 1 matte) and is
     squared into the GGX alpha, which is what makes the parameter behave
     linearly to the eye. */
  vec3 lightPBR(vec3 N, vec3 V, vec3 L, vec3 albedo, float rough, float metal,
                vec3 radiance) {
    float raw = dot(N, L);

    /* WRAPPED DIFFUSE, and why it is not a cheat here.

       Measured on a standing player at noon: ndl on the torso was exactly 0.
       The key light sits at 58 degrees elevation, so a vertical surface is
       edge-on to it and receives no direct sun at all — every player was lit
       purely by ambient, which is achromatic, which is why the whole squad
       rendered as grey chrome regardless of kit colour.

       Wrap is the standard treatment for cloth and skin: both scatter light
       beneath the surface and re-emit it, so the terminator is genuinely softer
       than Lambert predicts. It is applied to the DIFFUSE lobe only. Specular
       still uses the true geometric ndl, because a highlight that wraps past
       the terminator is just wrong. */
    const float WRAP = 0.30;
    float ndlD = clamp((raw + WRAP) / (1.0 + WRAP), 0.0, 1.0);
    float ndl = max(raw, 0.0);
    if (ndlD <= 0.0) return vec3(0.0);
    float ndv = max(dot(N, V), 1e-4);
    vec3  H   = normalize(L + V);
    float ndh = max(dot(N, H), 0.0);
    float vdh = max(dot(V, H), 0.0);

    float a = max(rough * rough, 0.0015);
    vec3  f0 = mix(vec3(0.04), albedo, metal);

    vec3  F = f_schlick(f0, vdh);
    float D = d_ggx(ndh, a);
    float Vs = v_smith(ndv, ndl, a);

    vec3 spec = F * D * Vs * ndl;        // true ndl: highlights do not wrap
    /* energy conservation: what is not reflected specularly is available to
       diffuse, and metals have no diffuse at all */
    vec3 kd = (vec3(1.0) - F) * (1.0 - metal);
    vec3 diff = kd * albedo / PI * ndlD;  // wrapped: cloth and skin scatter

    return (diff + spec) * radiance;
  }

  /* ---- analytic environment ------------------------------------------
     Two hemispheres and a horizon band. Sky above, ground bounce below, the
     horizon colour where they meet — which is exactly the information the sky
     shader already works from. Diffuse takes the irradiance in the normal's
     direction; specular takes it in the reflection's, widened by roughness so
     a rough surface gathers a broad average and a smooth one a narrow one. */
  /* The sweep width: 1.0 walks the whole ground-to-zenith range, 0.30 stays
     near the horizon colour. */
  vec3 envSweep(vec3 dir, float w) {
    float up = dir.z;
    float t = clamp(up * w * 0.5 + 0.5, 0.0, 1.0);
    vec3 ground = uSkyH * 0.42 * vec3(0.86, 0.94, 0.82);   // grass bounce
    vec3 horizon = uSkyH;
    vec3 zenith  = uSkyZenith;
    vec3 c = t < 0.5 ? mix(ground, horizon, t * 2.0)
                     : mix(horizon, zenith, (t - 0.5) * 2.0);
    return c;
  }

  /* Specular: a rough reflection gathers a broad average, a smooth one a narrow
     one, so the sweep narrows as roughness rises. */
  vec3 envAt(vec3 dir, float rough) {
    return envSweep(dir, mix(1.0, 0.30, clamp(rough, 0.0, 1.0)));
  }

  /* AMBIENT IRRADIANCE, and this is not the same lookup.

     Diffuse ambient was calling envAt(N, 1.0), which -- because roughness 1.0
     narrows the sweep to 0.30 -- evaluated the sky gradient across only
     t = 0.35..0.65 no matter which way the surface faced. The consequence was
     that the ambient term was very nearly CONSTANT over a whole figure, and
     since the camera sits behind the players and the sun in front of them, that
     constant was most of what lit them. They came out flat: a red shirt with no
     top-to-bottom falloff, which is exactly the look of a cut-out.

     Irradiance is a cosine-weighted integral over the hemisphere, so it does
     vary strongly with the normal -- an upward face collects sky, a downward
     face collects grass bounce. 0.70 is that integral's effective sweep over a
     linear gradient: not the full range, because the cosine weighting pulls in
     light from around the normal, but nowhere near as narrow as 0.30. This is
     where a figure's form comes from when it is not in direct sun. */
  vec3 envIrradiance(vec3 N) {
    return envSweep(N, 0.70);
  }

  /* PRE-INTEGRATED ENVIRONMENT BRDF (Karis' analytic fit).

     This exists because the obvious thing is wrong. Using a bare Schlick
     Fresnel for the ambient specular sends F to 1.0 at grazing angles, so
     every curved dielectric surface becomes a mirror around its silhouette —
     and a footballer is nothing but curved surfaces. The result rendered the
     whole squad as polished chrome: the kit colour vanished under a white
     rim and the players looked like robots.

     A real split-sum IBL multiplies by a pre-integrated DFG term that folds in
     the distribution and the geometry factor as well as Fresnel, and that term
     does NOT approach 1. This is the standard closed-form fit to it, so the
     ambient specular stays bounded without a lookup texture. */
  vec2 envBRDF(float ndv, float rough) {
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    const vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.040);
    vec4 r = rough * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
    return vec2(-1.04, 1.04) * a004 + r.zw;
  }

  vec3 ambientPBR(vec3 N, vec3 V, vec3 albedo, float rough, float metal, float ao) {
    float ndv = max(dot(N, V), 1e-4);
    vec3 f0 = mix(vec3(0.04), albedo, metal);
    /* diffuse still uses a plain Fresnel complement — that part is correct */
    vec3 F = f_schlick(f0, ndv);

    vec3 irr = envIrradiance(N);
    /* FLOODLIT BOUNCE.

       At night the sky contributes almost nothing — the probe colours are near
       black by design — so a player lit only by four point lights and a dead
       sky came out at RGB(51,48,52): dark and, worse, desaturated, because the
       specular was carrying the whole surface and the diffuse had nothing to
       work with.

       A floodlit stadium is not a dark room with four lamps in it. It is a
       bright bowl: the light hits the turf and the stands and bounces back up
       from every direction, which is why players on television at night are
       evenly lit rather than dramatically side-lit. This is that bounce, and
       it is what puts the colour back in the kit. */
    irr += vec3(0.62, 0.66, 0.72) * uCond.z * 0.30;
    vec3 kd = (vec3(1.0) - F) * (1.0 - metal);
    vec3 diff = kd * albedo * irr;

    vec3 R = reflect(-V, N);
    vec3 pre = envAt(R, rough);
    vec2 ab = envBRDF(ndv, rough);
    vec3 spec = pre * (f0 * ab.x + ab.y);

    return (diff + spec) * ao * uAmb;
  }

  /* ---- the floodlights ------------------------------------------------
     Four point lights, no shadows. Intensity follows the condition's flood
     term, so they are almost nothing at three in the afternoon and are doing
     all the work at night. Inverse-square with a soft minimum so a surface
     directly under a rig does not blow out.

     No shadow maps for these on purpose: four more depth passes would cost
     more than the whole rest of the frame, and the one directional shadow
     already anchors every object to the ground. What these buy is the
     four-way specular and the four-way falloff, which is what the eye reads
     as floodlighting. */
  vec3 floodPBR(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, float metal) {
    float amt = uCond.z;
    if (amt < 0.02) return vec3(0.0);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec3 d = RIG[i] - P;
      float dist2 = max(dot(d, d), 36.0);
      vec3 L = d * inversesqrt(dist2);
      /* 1/r^2, normalised so a rig at ~55 m reads as one unit */
      float atten = 3000.0 / dist2;
      sum += lightPBR(N, V, L, albedo, rough, metal,
                      vec3(1.0, 0.972, 0.906) * atten * amt * 0.55);
    }
    return sum;
  }

  /* The whole surface, in one call. Everything lit in this renderer goes
     through here, so the light rig is described once. */
  vec3 surfacePBR(vec3 P, vec3 N, vec3 V, vec3 albedo,
                  float rough, float metal, float ao, float sh) {
    vec3 sun = lightPBR(N, V, uLight, albedo, rough, metal, uSunCol) * sh;
    vec3 amb = ambientPBR(N, V, albedo, rough, metal, ao);
    vec3 fld = floodPBR(P, N, V, albedo, rough, metal);
    return sun + amb + fld;
  }
  `;

  var SHADOW_CHUNK = `
  uniform highp sampler2DShadow uShadow;
  uniform mat4 uLightVP;
  uniform float uShadowTexel;
  uniform vec4 uStand;        // xy = occluding lip half-extents, z = its height, w = penumbra

  /* THE STAND SHADOW.

     A stand 17 m high with the sun at 40 degrees throws about twenty metres of
     shadow onto the grass. In real football that band is one of the most
     recognisable things in the frame: it splits the pitch, it tells you the
     time of day, and it is the reason a wide shot has any depth in it at all.
     Every frame this renderer produced was lit as though the bowl were made of
     glass, and a uniformly lit pitch from touchline to touchline is a strong,
     immediate tell that a stadium is not real.

     It does not belong in the shadow map. That map is a 2048 ortho sized to the
     play area to keep player self-shadowing sharp; widening it to enclose a
     190 m bowl would cost most of its resolution and blur exactly the contact
     shadows it exists for. The occluder here is also known in closed form -- a
     rounded rectangle at a fixed height -- so it can simply be intersected.

     Ray-box exit against the roof's inner lip: march from the surface toward
     the sun, and find where that ray crosses the vertical plane through the
     lip. If it gets there below the lip, the lip is in the way. The corner
     radius is ignored on purpose -- at 20 m it changes the band by less than
     its own penumbra.

     This lives inside shadowAt() so that the ground, the players, the ball and
     the goal frame all pick it up from the call sites they already have, and so
     that a player running into the shadow darkens with the grass underneath
     them instead of staying lit on top of it. */
  float standShadow(vec3 wp) {
    if (uLight.z < 0.05) return 0.0;
    vec2 L = uLight.xy;
    float tx = L.x > 0.0 ? (uStand.x - wp.x) / max(L.x,  1e-4)
                         : (-uStand.x - wp.x) / min(L.x, -1e-4);
    float ty = L.y > 0.0 ? (uStand.y - wp.y) / max(L.y,  1e-4)
                         : (-uStand.y - wp.y) / min(L.y, -1e-4);
    /* the nearer crossing is the one that matters */
    float t = min(tx, ty);
    if (t <= 0.0) return 0.0;
    float h = wp.z + uLight.z * t;
    /* A penumbra that widens with distance to the occluder. The sun is 0.53
       degrees across, so the umbra grows by tan(0.53) ~ 0.0092 per metre of
       throw -- and that coefficient is not a free parameter. A first attempt
       used 0.055, six times too wide, and multiplied it again by 1.6: at a 9
       degree sun the ray runs 100 m to the roof lip, so the half-penumbra came
       out at 9.4 m of HEIGHT, which at that elevation smears across 56 m of
       grass in each direction. The edge did not soften, it dissolved -- and
       what was left was a 50% dimming of the entire pitch that looked like a
       flat exposure change rather than a shadow. */
    float soft = uStand.w * (0.25 + t * 0.0092);
    return 1.0 - smoothstep(uStand.z - soft, uStand.z + soft, h);
  }

  float shadowAt(vec3 wp, float ndl) {
    float stand = standShadow(wp);
    vec4 lp = uLightVP * vec4(wp, 1.0);
    vec3 q = lp.xyz / lp.w * 0.5 + 0.5;
    if (q.x < 0.001 || q.x > 0.999 || q.y < 0.001 || q.y > 0.999 || q.z > 1.0)
      return 1.0 - stand;
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
    return s * 0.25 * (1.0 - stand);
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

    return HEAD + COMMON + PBR + SHADOW_CHUNK + `
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

    /* TURF NORMALS.

       A pitch is not a plane. The mow bands are grass lying in alternating
       directions, and that is a NORMAL difference, not a colour difference —
       which is why the stripes on a real pitch invert as you walk round it and
       why painting them as two greens never quite reads. Tilting the normal
       along the band direction gives the alternation for free from the
       lighting, and gives the anisotropic sheen that makes it look like grass
       rather than felt. */
    float bandPhase = p.y / (${HL} * 2.0 / uBands);
    float bandDir = mod(floor(bandPhase), 2.0) * 2.0 - 1.0;
    vec3 N = normalize(vec3(0.0, bandDir * 0.13, 1.0));
    /* fine blade noise, so the surface is not mirror-flat between bands */
    N = normalize(N + vec3(sin(p.x * 31.0) * 0.03, cos(p.y * 27.0) * 0.03, 0.0));

    float ndl = max(dot(N, uLight), 0.0);
    float sh = shadowAt(vW, ndl);

    /* Grass: rough and fully dielectric. Wet grass is much smoother, which is
       the entire reason a wet pitch reads as wet — it is a roughness change,
       not a colour change. */
    float rough = mix(0.86, 0.30, uWet);
    if (uWet > 0.01) base *= 1.0 - uWet * 0.18;
    vec3 lit = surfacePBR(vW, N, V, base, rough, 0.0, 1.0, sh);

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
    /* The rigs are real point lights in surfacePBR() now, so this is only the
       broad wash on the grass that a point light cannot give: the diffuse
       spill across the whole pool, which on a pitch this size is much wider
       than inverse-square from a 31 m rig would produce. */
    lit += vec3(1.0, 0.988, 0.886) * pool * (0.008 + uCond.z * 0.030) * (1.0 - apron);

    float m = markings(p, aa) * (1.0 - apron) * (1.0 - wear * 0.45);
    /* markings are matte paint, so they get the same model at high roughness */
    vec3 lineC = surfacePBR(vW, vec3(0.0, 0.0, 1.0), V, vec3(0.95, 0.96, 0.95),
                            0.72, 0.0, 1.0, sh);
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

  var STAND_FS = HEAD + COMMON + PBR + `
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

  var CROWD_FS = HEAD + COMMON + PBR + `
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

    /* ---- LIGHTING THE BOWL ---------------------------------------------

       This used to be  c *= 0.72 + 0.42 * shade  -- a multiplier that lands
       between 0.97 and 1.14 -- so every spectator was drawn at full albedo,
       always, in every condition. In daylight that merely looked flat. At
       night it was ruinous: measured, the stands came out BRIGHTER than the
       floodlit pitch. A stadium never looks like that. The pitch is the lit
       object and the bowl is the dark surround, and getting that one
       relationship backwards is what stopped these frames reading as
       broadcast football more than any missing texture did.

       The bowl is now lit by the same rig as everything else. The row index
       comes back out of the seat's height, which is all that is needed to
       know how far back into the rake -- and therefore how far under the roof
       -- a spectator sits. */
    float row  = clamp((vW.z - 1.55) / 0.46, 0.0, 26.0);
    float back = row * 0.84 + 0.46;              // metres back along the rake
    float roof = smoothstep(3.5, 14.0, back);    // a gradient, not a line

    /* A seat does not see a hemisphere of sky: the rake in front cuts off the
       bottom of it and the roof cuts off the top, so skylight falls away as the
       rows go back. That is the gradient in every televised stand.

       It must be a GRADIENT though. A first attempt took skylight down to 0.14
       under the roof on a smoothstep only 3.5 m wide, and the upper tier went
       to flat silhouette along a hard straight line -- worse than the flat
       crowd it replaced, because now the stadium looked broken rather than
       merely unlit. */
    float skyVis = mix(0.95, 0.40, roof);
    vec3 amb = envIrradiance(vec3(0.0, 0.0, 1.0)) * skyVis * uAmb * 0.70;

    /* And the pitch is a very large, very bright lambertian reflector filling
       the lower half of every spectator's view. It reaches under the roof where
       the sky cannot, which is the actual reason a covered stand still reads as
       twenty thousand people and not as a black band. */
    amb += envIrradiance(vec3(0.0, 0.0, -1.0)) * uAmb * 0.34;

    /* Direct sun reaches the open front rows only: the band of light across
       the lower tier that reads as an afternoon kick-off in a single glance. */
    vec3 key = uSunCol * (1.0 - roof) * (0.28 + 0.52 * uCond.x) * 0.40;

    /* At night the rigs are above and behind the roof line, so the bowl is lit
       indirectly -- dim, even, and cooler than the pitch. */
    vec3 fld = vec3(0.82, 0.87, 1.0) * uCond.z * 0.26;

    /* per-seat variation, kept small: this is cloth and posture, not lighting */
    float jit = 0.88 + 0.24 * fract(vSeed * 3.77);

    c *= (amb + key + fld) * jit;

    /* The back of the bowl falls away further still. Real stands do, and it is
       what places the pitch IN FRONT OF the crowd instead of pasted onto it. */
    c *= mix(1.0, 0.78, smoothstep(1.0, 22.0, row));

    /* Finally pull a little saturation out, so that with eighteen thousand
       shirts on screen no single one competes with a kit on the pitch. */
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 0.84);

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
    /* 512 across a 5.2 m board. At the old 256 the boards were the softest
       thing in a 4K frame, and they sit right behind the goal where the eye
       already is. */
    var PW = 512, PH = 192;
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

  /* ---- player shaders -------------------------------------------------
     Instanced. aIns/aIns2/aIns3 are the three rows of a 3x4 matrix: the xyz of
     each is a scaled basis vector and the w is that row's translation, so one
     attribute triple carries orientation, size and position together.

     The normal matrix is not passed in. These instances are built from an
     orthonormal basis scaled per axis, so the correct normal transform is the
     basis with the scales divided out — which the shader can do itself from
     the same three rows. Sending a per-instance mat3 would be three more
     attributes for information already present. */
  var PLAYER_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  in vec4 aIns;      // row 0: R * hw   , tx
  in vec4 aIns2;     // row 1: -U * halfLen, ty
  in vec4 aIns3;     // row 2: F * hd   , tz
  in vec4 aCol;      // rgb = albedo, a = roughness
  in vec4 aTap;      // x = taper at y=-1, y = taper at y=+1
  uniform mat4 uVP;
  out vec3 vW, vN;
  out vec3 vCol;
  out float vRough;
  void main() {
    /* taper across the bone's length, in object space */
    float t = (aPos.y + 1.0) * 0.5;
    float k = mix(aTap.x, aTap.y, t);
    vec3 lp = vec3(aPos.x * k, aPos.y, aPos.z * k);

    vec3 c0 = aIns.xyz, c1 = aIns2.xyz, c2 = aIns3.xyz;
    vec3 w = vec3(aIns.w, aIns2.w, aIns3.w)
           + c0 * lp.x + c1 * lp.y + c2 * lp.z;

    /* normals: divide the scale out of each basis vector */
    vec3 n0 = normalize(c0), n1 = normalize(c1), n2 = normalize(c2);
    vec3 nn = n0 * (aNrm.x * k) + n1 * aNrm.y + n2 * (aNrm.z * k);

    vW = w;
    vN = normalize(nn);
    vCol = aCol.rgb;
    vRough = aCol.a;
    gl_Position = uVP * vec4(w, 1.0);
  }
  `;

  var PLAYER_FS = HEAD + COMMON + PBR + SHADOW_CHUNK + `
  in vec3 vW, vN;
  in vec3 vCol;
  in float vRough;
  out vec4 oCol;
  void main() {
    vec3 n = normalize(vN);
    vec3 V = normalize(uEye - vW);
    float ndl = dot(n, uLight);

    /* NORMAL-OFFSET SHADOW LOOKUP.

       Players cast into the shadow map, which means they also SAMPLE it at
       their own surface — and a depth bias alone is not enough at this scale.
       Measured before this: the striker's shirt rendered at 44% of its base
       colour because the torso was shadowing itself. Pushing the sample point
       out along the normal moves it clear of the surface that wrote the depth. */
    float sh = shadowAt(vW + n * 0.045, ndl);

    /* Contact occlusion from height: a boot is in more contact with the turf
       than a head is, so it receives less sky. */
    float ao = mix(0.74, 1.0, clamp(vW.z / 1.4, 0.0, 1.0));

    /* MATERIALS. vRough carries the surface: a shirt is matte, skin has a
       little sheen, a boot is near-patent. These are now real roughness values
       feeding a real BRDF rather than an exponent picked by eye per shader. */
    vec3 lit = surfacePBR(vW, n, V, vCol, vRough, 0.0, ao, sh);
    lit = grade(lit);
    oCol = vec4(applyFog(lit, length(uEye - vW)), 1.0);
  }
  `;

  /* Spheres: aIns is xyz = centre, w = radius. Same lighting as the limbs so a
     joint cap does not read as a different material from the bone it joins. */
  var PSPHERE_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  in vec4 aIns;
  in vec4 aCol;      // rgb = albedo, a = roughness
  uniform mat4 uVP;
  out vec3 vW, vN;
  out vec3 vCol;
  out float vRough;
  void main() {
    vec3 w = aIns.xyz + aPos * aIns.w;
    vW = w; vN = normalize(aNrm); vCol = aCol.rgb; vRough = aCol.a;
    gl_Position = uVP * vec4(w, 1.0);
  }
  `;

  /* ---- the head -------------------------------------------------------
     Its own program, because a head is the one part of a footballer that has
     to carry identity and a sphere with a hair-coloured sphere on top cannot.
     Everything is analytic in HEAD-LOCAL space, which the instance basis gives
     for free: object X maps to the head's right, Y to its up, Z to its facing.
     So the fragment shader knows where the face is without a texture, a UV
     unwrap, or a second mesh.

     Doing it per-pixel rather than as screen-space marks (which is what the
     canvas renderer does) means it stays correct at any zoom and rotates with
     the head instead of sliding across it. The canvas version had to be
     switched off below 74 px because the marks merged into a dark band; this
     just gets smaller. */
  var HEAD_FS = HEAD + COMMON + PBR + SHADOW_CHUNK + `
  in vec3 vW, vN;
  in vec3 vCol;      // skin
  in vec3 vHair;
  in vec3 vLocal;    // position on the unit sphere, head-local
  in float vStyle;
  out vec4 oCol;

  void main() {
    vec3 q = normalize(vLocal);
    vec3 base = vCol;

    /* ---- hair -------------------------------------------------------
       A cap above a latitude, with a fringe that sits lower at the back than
       the front so there is a hairline rather than a bowl. Style shifts the
       latitude and the fringe: 0 fade, 1 fuller crop, 2 topknot, 3 shaved. */
    float st = vStyle;
    float lat  = st < 0.5 ? 0.16 : (st < 1.5 ? 0.02 : (st < 2.5 ? 0.10 : 0.34));
    float back = st < 0.5 ? 0.16 : (st < 1.5 ? 0.30 : (st < 2.5 ? 0.22 : 0.06));
    /* q.z > 0 is the face side: raise the boundary there */
    float edge = lat + back * (-q.z) * 0.5;
    float hairMask = smoothstep(edge - 0.05, edge + 0.05, q.y);
    if (st > 2.5) hairMask *= 0.55;            // shaved: a shadow, not a cap
    base = mix(base, vHair, hairMask);

    /* topknot: a small blob behind the crown */
    if (st > 1.5 && st < 2.5) {
      float k = 1.0 - smoothstep(0.0, 0.42, length(q - normalize(vec3(0.0, 0.95, -0.45))));
      base = mix(base, vHair, k);
    }

    /* ---- the face, only on the facing hemisphere -------------------- */
    float faceSide = smoothstep(0.18, 0.42, q.z);
    if (faceSide > 0.001) {
      /* brow: a band across, above the eye line. Carries more identity than
         any other single mark on a face this small. */
      float brow = (1.0 - smoothstep(0.030, 0.075, abs(q.y - 0.235)))
                 * (1.0 - smoothstep(0.30, 0.56, abs(q.x)));
      base = mix(base, base * 0.42, brow * faceSide * 0.85);

      /* eyes: two almonds either side of centre */
      vec2 e = vec2(abs(q.x) - 0.235, q.y - 0.075);
      float eye = 1.0 - smoothstep(0.055, 0.105, length(e * vec2(1.0, 1.45)));
      base = mix(base, vec3(0.11, 0.09, 0.07), eye * faceSide);

      /* a catch light in the upper inner corner of each eye */
      vec2 g = vec2(abs(q.x) - 0.205, q.y - 0.110);
      float glint = 1.0 - smoothstep(0.014, 0.030, length(g));
      base = mix(base, vec3(0.92, 0.95, 1.0), glint * faceSide * 0.8);

      /* mouth: a slight downward set */
      float mo = (1.0 - smoothstep(0.020, 0.048, abs(q.y + 0.235 + q.x * q.x * 0.34)))
               * (1.0 - smoothstep(0.11, 0.22, abs(q.x)));
      base = mix(base, base * 0.60, mo * faceSide * 0.7);
    }

    vec3 n = normalize(vN);
    vec3 V = normalize(uEye - vW);
    float ndl = dot(n, uLight);
    float sh = shadowAt(vW + n * 0.045, ndl);
    /* Skin is a dielectric with a broad sheen; hair is rougher and darker.
       Blending the roughness with the hair mask means the crown catches light
       differently from the forehead, which is most of what stops a head
       reading as a painted ball. */
    float rough = mix(0.52, 0.78, hairMask);
    vec3 lit = surfacePBR(vW, n, V, base, rough, 0.0, 1.0, sh);
    lit = grade(lit);
    oCol = vec4(applyFog(lit, length(uEye - vW)), 1.0);
  }
  `;

  var HEAD_VS = HEAD + `
  in vec3 aPos;
  in vec3 aNrm;
  in vec4 aIns;      // row 0: R * r, tx
  in vec4 aIns2;     // row 1: U * r, ty
  in vec4 aIns3;     // row 2: F * r, tz
  in vec4 aCol;      // skin
  in vec4 aTap;      // rgb = hair, w = style
  uniform mat4 uVP;
  out vec3 vW, vN, vCol, vHair, vLocal;
  out float vStyle;
  void main() {
    vec3 c0 = aIns.xyz, c1 = aIns2.xyz, c2 = aIns3.xyz;
    vec3 w = vec3(aIns.w, aIns2.w, aIns3.w)
           + c0 * aPos.x + c1 * aPos.y + c2 * aPos.z;
    vW = w;
    vN = normalize(normalize(c0) * aNrm.x + normalize(c1) * aNrm.y + normalize(c2) * aNrm.z);
    vCol = aCol.rgb;
    vHair = aTap.rgb;
    vStyle = aTap.w;
    vLocal = aPos;
    gl_Position = uVP * vec4(w, 1.0);
  }
  `;

  /* depth-only variants for the shadow pass. Same attribute layout, which is
     why the locations are bound explicitly in GLX.prog. */
  var PLAYER_DEPTH_VS = HEAD + `
  in vec3 aPos;
  in vec4 aIns;
  in vec4 aIns2;
  in vec4 aIns3;
  in vec4 aTap;
  uniform mat4 uVP;
  void main() {
    float t = (aPos.y + 1.0) * 0.5;
    float k = mix(aTap.x, aTap.y, t);
    vec3 lp = vec3(aPos.x * k, aPos.y, aPos.z * k);
    vec3 w = vec3(aIns.w, aIns2.w, aIns3.w)
           + aIns.xyz * lp.x + aIns2.xyz * lp.y + aIns3.xyz * lp.z;
    gl_Position = uVP * vec4(w, 1.0);
  }
  `;

  var PSPHERE_DEPTH_VS = HEAD + `
  in vec3 aPos;
  in vec4 aIns;
  uniform mat4 uVP;
  void main() {
    gl_Position = uVP * vec4(aIns.xyz + aPos * aIns.w, 1.0);
  }
  `;

  var DEPTH_ONLY_FS = HEAD + `
  void main() {}
  `;

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

  var BALL_FS = HEAD + COMMON + PBR + SHADOW_CHUNK + `
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

    /* A match ball is coated polyurethane: smooth, dielectric, and it picks up
       a wet sheen. The seams are slightly rougher than the panels. */
    float ndl = max(dot(N, uLight), 0.0);
    float sh = shadowAt(vW, ndl);
    float rough = mix(0.34, 0.16, uWet) + seam * 0.22;
    vec3 lit = surfacePBR(vW, N, V, c, rough, 0.0, 1.0, sh);

    oCol = vec4(grade(applyFog(lit, dist)), 1.0);
  }
  `;

  var METAL_FS = HEAD + COMMON + PBR + SHADOW_CHUNK + `
  in vec3 vW, vN, vL;
  out vec4 oCol;
  uniform vec3 uBase;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = uEye - vW;
    float dist = length(V);
    V /= dist;
    /* A goalpost is gloss-painted aluminium: very smooth, dielectric. The
       highlight running down it is the whole reason it reads as round rather
       than as a white stripe, and a real BRDF gives that highlight the right
       shape instead of a tuned exponent. */
    float ndl = max(dot(N, uLight), 0.0);
    float sh = shadowAt(vW, ndl);
    vec3 lit = surfacePBR(vW, N, V, uBase, 0.20, 0.0, 1.0, sh);
    oCol = vec4(grade(applyFog(lit, dist)), 1.0);
  }
  `;

  /* The net is a surface, not a texture on a quad: alpha comes from a grid in
     surface coordinates so the cord thickness is right at every distance, and
     the back panel is denser than the sides exactly as a real net is. */
  var NET_FS = HEAD + COMMON + PBR + `
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

    /* What this driver will actually allocate. A 4K portrait buffer is 3840 on
       its long edge and plenty of mobile GPUs stop at 4096, so this is a real
       constraint rather than a formality — and exceeding it fails silently. */
    MAX_TEX = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE),
                       gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]) || 4096;
    if (typeof RES !== "undefined") { RES.limit(MAX_TEX); RES.target(RES.T4K); }

    P.sky    = GLX.prog("sky", SKY_VS, SKY_FS);
    P.ground = GLX.prog("ground", GROUND_VS, groundFrag());
    P.ball   = GLX.prog("ball", SOLID_VS, BALL_FS);
    P.metal  = GLX.prog("metal", SOLID_VS, METAL_FS);
    P.net    = GLX.prog("net", NET_VS, NET_FS);
    P.depth  = GLX.prog("depth", DEPTH_VS, DEPTH_FS);
    P.player            = GLX.prog("player", PLAYER_VS, PLAYER_FS);
    P.playerSphere      = GLX.prog("playerSphere", PSPHERE_VS, PLAYER_FS);
    P.playerDepth       = GLX.prog("playerDepth", PLAYER_DEPTH_VS, DEPTH_ONLY_FS);
    P.playerSphereDepth = GLX.prog("playerSphereDepth", PSPHERE_DEPTH_VS, DEPTH_ONLY_FS);
    P.head              = GLX.prog("head", HEAD_VS, HEAD_FS);
    P.headDepth         = GLX.prog("headDepth", PLAYER_DEPTH_VS, DEPTH_ONLY_FS);
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

    /* after the programs exist, so SKIN can borrow the GLSL chunks */
    if (typeof SKIN !== "undefined") SKIN.boot(gl);

    SHADOW = GLX.depthTarget(SHADOW_SIZE);
    size();
    /* set here rather than in the initRender wrapper so the harness can call
       GLR.boot() on a page that has already started */
    if (!buildPlayerMeshes()) {
      console.warn("[gl] player meshes failed — players stay on canvas");
      DBG.players = 0;
    }

    /* the post chain is optional: if the float target or any of its programs
       fail we fall back to rendering straight to the back buffer */
    if (typeof GPOST !== "undefined" && GPOST.build(gl)) {
      if (!GPOST.resize(glc.width || 2, glc.height || 2)) {
        console.warn("[gl] post targets unavailable — rendering direct");
      }
    } else {
      console.warn("[gl] post chain unavailable — rendering direct");
    }

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
    var d = dpr();
    var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    W = Math.round(w * d); H = Math.round(h * d);
    if (glc.width !== W || glc.height !== H) {
      glc.width = W; glc.height = H;
      glc.style.width = w + "px"; glc.style.height = h + "px";
    }
    sizeShadow();
  }

  /* The shadow map has to keep pace with the picture. At 4K a 1024 map over a
     44 m box puts roughly one shadow texel under every four screen pixels of
     the ball's contact shadow, and it reads as a staircase. Reallocating is a
     depth texture and a framebuffer, and RES only moves the ratio every 30-odd
     frames at the fastest, so this is not a per-frame cost. */
  function sizeShadow() {
    if (typeof RES === "undefined" || !SHADOW) return;
    var want = RES.shadow(MAX_TEX);
    if (want === SHADOW.size) return;
    var next = GLX.depthTarget(want);
    if (!next) return;                 // keep the one that works
    GLX.freeTarget(SHADOW);
    SHADOW = next;
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
    /* A 22 m box is ample at 40 degrees, where a standing player throws a 2 m
       shadow. At golden hour the sun is at 15 and that same player throws 6.7 m,
       so a fixed box clips the far end of every shadow -- and shadowAt() returns
       1.0 outside the map, meaning the shadow does not soften at the edge, it
       simply stops. Widen with the sun's own cotangent and the box always holds
       whatever the light is doing. */
    var reach = SHADOW_HALF * clamp(0.84 / Math.max(L.z, 0.20), 1.0, 2.1);
    M4.ortho(mLightP, -reach, reach, -reach, reach, 1, d * 2.6);
    M4.mul(mLightVP, mLightP, mLightV);
  }

  function setCommon(prg, dist) {
    var C = cond();
    GLX.col3(C.sky[2], c3);
    gl.uniform3f(prg.u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(prg.u.uLight, LIGHT.x, LIGHT.y, LIGHT.z);
    gl.uniform3f(prg.u.uSkyH, c3[0], c3[1], c3[2]);

    /* THE LIGHT RIG, as radiance rather than as a set of tuned constants.

       The key light's colour and strength come from the condition: bright and
       warm at golden hour, dim and blue-ish at night when the sun is gone and
       the rigs are doing the work. The zenith feeds the ambient probe, so the
       sky lights the scene from above and the grass bounces up from below —
       which is what a real environment probe would give, evaluated in closed
       form because this sky IS closed form. */
    GLX.col3(C.sky[0], c1);
    gl.uniform3f(prg.u.uSkyZenith, c1[0], c1[1], c1[2]);

    /* Sun radiance. Above 1 on a bright day on purpose: the post chain has an
       HDR buffer and a highlight shoulder, so a specular can be brighter than
       white and roll off instead of clipping. That is the whole point of it. */
    var warm = C.warm;
    var sunI = (0.55 + C.light * 1.05) * (1 - C.flood * 0.45);
    gl.uniform3f(prg.u.uSunCol,
                 sunI * (1 + (warm - 0.5) * 0.34),
                 sunI * (1 + (warm - 0.5) * 0.06),
                 sunI * (1 - (warm - 0.5) * 0.40));

    /* Ambient scale. A floodlit ground has very little skylight, so the probe
       is dialled back and the rigs take over. */
    gl.uniform1f(prg.u.uAmb, 0.42 + C.light * 0.62);

    gl.uniform4f(prg.u.uCond, C.light, C.warm, C.flood, C.haze);
    gl.uniform1f(prg.u.uWet, C.wet);
    gl.uniform4f(prg.u.uViewport, vpx(), vpy(), VP.w * dpr(), VP.h * dpr());
    if (prg.u.uVP) gl.uniformMatrix4fv(prg.u.uVP, false, mVP);

    /* Shadow map, for any program that samples it. This is centralised because
       an unbound shadow sampler does NOT raise an error — it reads zero, which
       shadowAt() reads as "fully shadowed", so the surface silently renders
       black. Adding shadowAt() to the ball and the goal frame is exactly the
       kind of change that would otherwise look like a lighting bug. */
    /* The stand's occluding silhouette, derived from the bowl rather than dialled
       in: the roof's inner lip sits roofBack metres back from the perimeter,
       at the roof's own height. Passing the lip's own half-extents (not the
       perimeter's) is what makes the band land in the right place -- the lip
       overhangs, so its shadow reaches further onto the pitch than a wall at
       the perimeter would. */
    var roofBack = BOWL.rows * BOWL.run - BOWL.roofOver;
    gl.uniform4f(prg.u.uStand,
                 BOWL.hx + roofBack, BOWL.hy + roofBack,
                 BOWL.base + BOWL.rows * BOWL.rise + BOWL.roofLift,
                 1.0);

    if (prg.u.uShadow) {
      gl.uniformMatrix4fv(prg.u.uLightVP, false, mLightVP);
      gl.uniform1f(prg.u.uShadowTexel, 1 / SHADOW.size);
      GLX.bindTex(0, SHADOW.tex);
      gl.uniform1i(prg.u.uShadow, 0);
    }
  }

  /* Read, never compute: RES.ratio() is a cached getter and the number is
     fixed for the frame. Deriving it here independently is how the GL
     viewport and the 2D overlay end up at different scales. */
  function dpr() {
    return (typeof RES !== "undefined") ? RES.ratio()
                                        : Math.min(window.devicePixelRatio || 1, 2.5);
  }
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
    /* players cast too — this is the thing the canvas renderer could never do,
       and it is what makes a figure look like it is standing on the grass
       rather than floating above a decal */
    if (DBG.players) { collectPlayers(world); drawPlayers(true); }
    gl.colorMask(true, true, true, true);

    /* ---- main pass ----------------------------------------------------
       Into the HDR scene target when post-processing is available, otherwise
       straight to the back buffer. Keeping both paths means a driver that
       cannot give us a float target still renders the game. */
    var vw = Math.round(VP.w * dpr()), vh = Math.round(VP.h * dpr());
    POSTING = usePost && DBG.post && typeof GPOST !== "undefined" &&
              GPOST.ready() && GPOST.resize(W, H) && GPOST.begin();
    if (!POSTING) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* everything is drawn inside the portrait play area, exactly like VP */
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(vpx(), vpy(), vw, vh);
    gl.scissor(vpx(), vpy(), vw, vh);

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

    /* players, in the same depth buffer as everything else */
    if (DBG.players) drawPlayers(false);

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

    /* ---- post-processing ---------------------------------------------- */
    if (POSTING) runPost(world, dt);
  }

  /* The grade. Every number here is derived from the condition rather than
     being a look chosen once, so a floodlit night and a golden-hour afternoon
     tonemap differently instead of sharing one filter.

     Focus is pinned to the ball. That is the whole reason depth of field is
     worth having in a football game: the ball is what the player is tracking,
     so keeping it sharp while the crowd behind it goes soft reads as a long
     lens following the action. Focusing on the camera's centre distance
     instead would blur the ball whenever it left the middle of the frame. */
  function runPost(world, dt) {
    var C = cond();
    var b = world.ball;

    /* distance from eye to ball, for the focus plane */
    var fx = b.x - eye[0], fy = b.y - eye[1], fz = (b.z + PHYS.BALL_R) - eye[2];
    var focusDist = Math.max(2, Math.hypot(fx, fy, fz));

    /* Bloom rides on how much of the light is artificial. By day the sun is
       broad and the glare is modest; under floodlights every lamp is a point
       source and the air does the rest. */
    var bloom = 0.30 + C.flood * 0.55 + (C.wet || 0) * 0.18;
    var knee  = 0.98 - C.flood * 0.20;

    /* Exposure sits at 1.0 by default and only nudges. The scene shaders
       already grade for the condition, so anything more than a nudge here
       double-applies it — the same mistake as double-tonemapping, just
       quieter. */
    var expo = 0.94 + C.light * 0.06;

    /* colour temperature: warm pulls red, cool pulls blue */
    var w = (C.warm - 0.5);
    var tint = [1 + w * 0.10, 1 + w * 0.012, 1 - w * 0.13];

    /* Depth of field is deliberately gentle. On a 390 px-wide frame a strong
       blur reads as a smeared mess rather than as a lens, and the crowd is
       already the busiest thing in the picture. */
    var dof = 0.34 + (1 - C.light) * 0.16;

    /* Motion blur scales with how fast the camera is actually moving, which is
       what the reprojection measures anyway — this is just a ceiling. Cut it
       during hit-stop: freezing the frame and blurring it is contradictory. */
    var frozen = (typeof FEEL !== "undefined" && FEEL.timeScale() < 0.02);
    var mblur = frozen ? 0 : 0.55;

    /* CUTS.

       Reprojected motion blur cannot tell a fast pan from a cut: both put a
       large screen-space velocity on every pixel. On a cut that is wrong in the
       worst way — the whole frame smears into unreadable streaks, and this game
       cuts twice on every attempt (into the goal camera's first beat, and into
       the miss camera).

       So a cut is detected geometrically and the blur is skipped for that
       frame. The threshold is generous because the play camera never moves this
       far in a sixtieth of a second: it is a follow, not a teleport. */
    var moved = Math.hypot(eye[0] - prevEye[0], eye[1] - prevEye[1], eye[2] - prevEye[2]);
    var turned = 1 - (basis.f[0] * prevFwd[0] + basis.f[1] * prevFwd[1] + basis.f[2] * prevFwd[2]);
    if (moved > 2.2 || turned > 0.010) mblur = 0;
    prevEye[0] = eye[0]; prevEye[1] = eye[1]; prevEye[2] = eye[2];
    prevFwd[0] = basis.f[0]; prevFwd[1] = basis.f[1]; prevFwd[2] = basis.f[2];

    M4.invert(mInvVP, mVP);

    GPOST.end({
      vp: mVP, invVP: mInvVP,
      near: NEARZ, far: FAR,
      focus: [focusDist, dof],
      bloom: bloom, knee: knee,
      exposure: expo, tint: tint,
      /* THE CURVE.

         These were 1.00 and 1.00 in daylight, which is to say the frame got no
         shaping at all: no contrast, no saturation, straight out of the
         shoulder. Measured on an afternoon frame, that produced turf at 157,
         white shorts at 245 and a kit red whose saturation had fallen from 0.62
         at source to 0.50 on screen -- a bright, pastel, low-contrast picture,
         and the specific look that separates a phone game from a broadcast.

         An ambient probe that reaches everywhere is what causes it: every
         surface gets lifted toward the sky colour, so shadows are never dark and
         nothing is ever fully saturated. That is correct lighting and the wrong
         picture, and the place to fix it is the curve, not the light. */
      sat: 1.07 + (1 - C.light) * 0.10,
      contrast: 1.12 + C.flood * 0.03,
      vig: [0.20 + (1 - C.light) * 0.14, 0.34],
      grain: 0.010 + (1 - C.light) * 0.010,
      /* AMBIENT OCCLUSION.

         The graphics audit called this "the cheapest remaining real gain in
         the project" and it got cheaper still once players became meshes:
         a jointed solid has no creases to occlude, a skinned body does.
         0.32 m is about the gap between a boot and the turf.

         Strength is tied to how much of the light is ambient. Under a hard
         afternoon sun the key light already carves the shape and heavy AO
         reads as dirt; under floodlights or heavy cloud the probe reaches
         everywhere and AO is the only thing left doing the grounding. */
      ao: 0.34 + (1 - C.light) * 0.20 + C.flood * 0.10,
      aoRadius: 0.32,
      aoBias: 0.022,
      aoPower: 1.0,
      /* FXAA. The renderer has no geometric AA — MSAA is unavailable on the
         framebuffer the post chain requires — so every silhouette is a hard
         staircase held together by resolution alone. See docs/WEBGL.md for
         the measured resolution trade this buys. */
      fxaa: AA,
      mblur: mblur,
      time: (typeof CROWD_T !== "undefined") ? CROWD_T : 0,
      eye: eye,
      viewport: [vpx(), vpy(), Math.round(VP.w * dpr()), Math.round(VP.h * dpr())]
    });
  }

  /* ==================================================================== */
  /* PLAYERS                                                               */
  /* ==================================================================== */

  /* The last thing on the canvas layer, and the reason the hybrid had a seam:
     canvas players drew soft blob shadows next to the ball's hard cast one, a
     player in front of the ball painted over it, and none of them received the
     depth of field, the bloom or the grade that everything else in the frame
     did.

     They are built from the SAME rig anim.js already drives. solveRig() gives
     joint frames on the CPU; each bone becomes one instance of a unit tapered
     cylinder, each joint cap one instance of a unit sphere. Roughly 26 limb
     instances and 9 sphere instances per player, so a full squad is two draw
     calls of a few hundred instances — nothing.

     Not GPU skinning. Skinning would matter if these were smooth meshes with
     weighted vertices; they are jointed solids, and the canvas renderer
     established that jointed solids read correctly at this camera distance.
     Rebuilding them as a skinned mesh would cost a great deal and change
     almost nothing on screen.

     What DOES change, and is the whole point: they are now in the depth buffer.
     No painter's bias, no "geometry that is permanently hidden is simply not
     built", real cast shadows onto the turf and onto each other, and every
     post-processing pass applies to them. */

  var PLI = null;              // limb instance buffers
  var PSI = null;              // joint-cap sphere instance buffers
  var PHI = null;              // head instance buffers
  var PL_MAX = 640, PS_MAX = 240, PH_MAX = 32;
  var pl_m0, pl_m1, pl_m2, pl_col, pl_tap, pl_n;
  var ps_m0, ps_col, ps_n;
  var ph_m0, ph_m1, ph_m2, ph_col, ph_tap, ph_n;

  /* A unit tapered cylinder: axis along Y from -1 to +1, radius 1 in X and Z.
     The taper is applied in the vertex shader from aTap so one mesh serves a
     thigh, a sleeve and a neck.

     WINDING MATTERS HERE, and it silently did not for a long time. Culling is
     BACK/CCW globally, and this mesh originally wound every triangle the other
     way: the outer wall was the back face and got culled, so what actually
     rasterised was the INSIDE of the far wall. The silhouette of a cylinder is
     identical either way, so the shape looked perfectly correct — but every
     shaded pixel carried an outward normal belonging to the far side, pointing
     AWAY from the camera.

     Under the old hand-tuned shader that was invisible: it wrapped its diffuse
     and added a flat 0.34 ambient, so a back-facing normal just read as
     slightly flat. Under a real BRDF it is fatal. dot(N,V) came out negative
     across the whole limb, clamped to 1e-4, which drove Schlick's Fresnel to
     0.9995 -- so kd = 1-F went to ~0, the diffuse term vanished entirely, and
     each limb rendered from ambient specular alone at RGB(5,5,5). Measured
     before this fix: torso ambient 5/255, joint-cap spheres 184/255, from the
     same fragment shader with byte-identical uniforms.

     Verify with a normal-visualisation pass, not by eye. */
  function unitCyl(sides) {
    var pos = [], nrm = [], idx = [], i;
    for (i = 0; i < sides; i++) {
      var a = i / sides * Math.PI * 2;
      var cx = Math.cos(a), cz = Math.sin(a);
      pos.push(cx, -1, cz); nrm.push(cx, 0, cz);
      pos.push(cx,  1, cz); nrm.push(cx, 0, cz);
    }
    for (i = 0; i < sides; i++) {
      var a0 = i * 2, a1 = a0 + 1;
      var b0 = ((i + 1) % sides) * 2, b1 = b0 + 1;
      idx.push(a0, a1, b0, a1, b1, b0);
    }
    /* caps, so a limb end seen head-on is not a hole */
    var base = pos.length / 3;
    pos.push(0, -1, 0); nrm.push(0, -1, 0);
    pos.push(0,  1, 0); nrm.push(0,  1, 0);
    for (i = 0; i < sides; i++) {
      var c0 = i * 2, c1 = ((i + 1) % sides) * 2;
      idx.push(base, c0, c1);
      idx.push(base + 1, c1 + 1, c0 + 1);
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm),
             idx: new Uint16Array(idx) };
  }

  function buildPlayerMeshes() {
    var cyl = unitCyl(10);
    pl_m0 = new Float32Array(PL_MAX * 4);
    pl_m1 = new Float32Array(PL_MAX * 4);
    pl_m2 = new Float32Array(PL_MAX * 4);
    pl_col = new Float32Array(PL_MAX * 4);
    pl_tap = new Float32Array(PL_MAX * 4);
    PLI = GLX.mesh(P.player, [
      { name: "aPos", data: cyl.pos, size: 3 },
      { name: "aNrm", data: cyl.nrm, size: 3 },
      { name: "aIns",  data: pl_m0,  size: 4, divisor: 1, dynamic: true },
      { name: "aIns2", data: pl_m1,  size: 4, divisor: 1, dynamic: true },
      { name: "aIns3", data: pl_m2,  size: 4, divisor: 1, dynamic: true },
      { name: "aCol",  data: pl_col, size: 4, divisor: 1, dynamic: true },
      { name: "aTap",  data: pl_tap, size: 4, divisor: 1, dynamic: true }
    ], cyl.idx);

    var sp = sphere(10, 14);

    /* the head gets more segments than a joint cap: it is the one sphere the
       player actually looks at, and the face is drawn per-pixel on it */
    var hsp = sphere(18, 26);
    ph_m0 = new Float32Array(PH_MAX * 4);
    ph_m1 = new Float32Array(PH_MAX * 4);
    ph_m2 = new Float32Array(PH_MAX * 4);
    ph_col = new Float32Array(PH_MAX * 4);
    ph_tap = new Float32Array(PH_MAX * 4);
    PHI = GLX.mesh(P.head, [
      { name: "aPos", data: hsp.pos, size: 3 },
      { name: "aNrm", data: hsp.nrm, size: 3 },
      { name: "aIns",  data: ph_m0,  size: 4, divisor: 1, dynamic: true },
      { name: "aIns2", data: ph_m1,  size: 4, divisor: 1, dynamic: true },
      { name: "aIns3", data: ph_m2,  size: 4, divisor: 1, dynamic: true },
      { name: "aCol",  data: ph_col, size: 4, divisor: 1, dynamic: true },
      { name: "aTap",  data: ph_tap, size: 4, divisor: 1, dynamic: true }
    ], hsp.idx);

    ps_m0 = new Float32Array(PS_MAX * 4);
    ps_col = new Float32Array(PS_MAX * 4);
    PSI = GLX.mesh(P.playerSphere, [
      { name: "aPos", data: sp.pos, size: 3 },
      { name: "aNrm", data: sp.nrm, size: 3 },
      { name: "aIns", data: ps_m0,  size: 4, divisor: 1, dynamic: true },
      { name: "aCol", data: ps_col, size: 4, divisor: 1, dynamic: true }
    ], sp.idx);
    return !!(PLI && PSI && PHI);
  }

  /* One head. The basis rows carry the head's own right/up/facing scaled by the
     radius, which is what lets the fragment shader put the face on the front. */
  function headIns(o, R, U, F, r, skin, hair, style) {
    if (ph_n >= PH_MAX) return;
    var i = ph_n * 4;
    ph_m0[i] = R.x * r; ph_m0[i+1] = R.y * r; ph_m0[i+2] = R.z * r; ph_m0[i+3] = o.x;
    ph_m1[i] = U.x * r; ph_m1[i+1] = U.y * r; ph_m1[i+2] = U.z * r; ph_m1[i+3] = o.y;
    ph_m2[i] = F.x * r; ph_m2[i+1] = F.y * r; ph_m2[i+2] = F.z * r; ph_m2[i+3] = o.z;
    GLX.col3(skin, _c);
    ph_col[i] = _c[0]; ph_col[i+1] = _c[1]; ph_col[i+2] = _c[2]; ph_col[i+3] = 1;
    GLX.col3(hair, _c);
    ph_tap[i] = _c[0]; ph_tap[i+1] = _c[1]; ph_tap[i+2] = _c[2]; ph_tap[i+3] = style;
    ph_n++;
  }

  /* --- instance emitters ------------------------------------------------ */

  var _c = [0, 0, 0];

  /* A bone: from f to t metres down the joint's own -U axis, half-width hw
     across R and hd across F, tapering from ta to tb. */
  /* ROUGHNESS PER MATERIAL. Packed into the instance colour's alpha, so a
     shirt, a boot and a shin all reach the same BRDF with the right surface
     instead of one shared exponent. */
  var ROUGH = {
    kit:   0.74,   // knitted polyester: matte, slight sheen
    skin:  0.52,
    sock:  0.80,
    boot:  0.22,   // modern boots are near-patent
    sole:  0.46,
    short: 0.70,
    glove: 0.62
  };

  function limbIns(j, hw, hd, f, t, ta, tb, colour, rough) {
    if (pl_n >= PL_MAX) return;
    var o = pl_n * 4;
    var halfL = (t - f) * 0.5, mid = (t + f) * 0.5;
    /* X -> R * hw, Y -> -U * halfL (bones extend along -U), Z -> F * hd */
    pl_m0[o]   = j.R.x * hw; pl_m0[o+1] = j.R.y * hw; pl_m0[o+2] = j.R.z * hw;
    pl_m0[o+3] = j.o.x - j.U.x * mid;
    pl_m1[o]   = -j.U.x * halfL; pl_m1[o+1] = -j.U.y * halfL; pl_m1[o+2] = -j.U.z * halfL;
    pl_m1[o+3] = j.o.y - j.U.y * mid;
    pl_m2[o]   = j.F.x * hd; pl_m2[o+1] = j.F.y * hd; pl_m2[o+2] = j.F.z * hd;
    pl_m2[o+3] = j.o.z - j.U.z * mid;
    GLX.col3(colour, _c);
    pl_col[o] = _c[0]; pl_col[o+1] = _c[1]; pl_col[o+2] = _c[2];
    pl_col[o+3] = rough == null ? ROUGH.kit : rough;
    /* taper runs along +Y in object space, which is -U in the world, so the
       ends swap: tb belongs at y=-1 */
    pl_tap[o] = tb; pl_tap[o+1] = ta; pl_tap[o+2] = 0; pl_tap[o+3] = 0;
    pl_n++;
  }

  function sphereIns(p, r, colour, rough) {
    if (ps_n >= PS_MAX) return;
    var o = ps_n * 4;
    ps_m0[o] = p.x; ps_m0[o+1] = p.y; ps_m0[o+2] = p.z; ps_m0[o+3] = r;
    GLX.col3(colour, _c);
    ps_col[o] = _c[0]; ps_col[o+1] = _c[1]; ps_col[o+2] = _c[2];
    ps_col[o+3] = rough == null ? ROUGH.skin : rough;
    ps_n++;
  }

  /* --- one player ------------------------------------------------------- */

  /* Mirrors drawPlayer()'s body frame exactly. Any drift between the two shows
     up as players standing at a different angle in the two renderers, which is
     the kind of thing that is very hard to see and very hard to un-see. */
  function emitPlayer(p, ball, world) {
    if (typeof solveRig !== "function" || typeof Animator !== "function") return;

    var kit  = p.role === "gk" ? COL.gk     : (p.team === "us" ? COL.us     : COL.them);
    var alt  = p.role === "gk" ? COL.gkAlt  : (p.team === "us" ? COL.usAlt  : COL.themAlt);
    var sock = p.role === "gk" ? COL.gkSock : (p.team === "us" ? COL.usSock : COL.themSock);
    var seed = (p.num * 7 + (p.team === "us" ? 3 : 11) + (p.role === "gk" ? 5 : 0));
    var sleeve = kit;
    var skin = COL.skins[seed % COL.skins.length];
    var hair = COL.hairs[(seed * 3) % COL.hairs.length];

    if (!p._id) {
      p._id = {
        hair: (seed * 5) % 4,
        broad: 0.94 + ((seed * 17) % 13) / 100,
        boot: COL.bootFlash[(seed * 23) % COL.bootFlash.length]
      };
    }
    var ID = p._id;

    /* animation state is shared with the canvas renderer, so a player keeps
       its clip and crossfade phase across a renderer swap */
    if (!p._an) { p._an = new Animator(); p._rig = {}; p._an.cur = pickClip(p, world); }
    var an = p._an;
    var want = pickClip(p, world);
    an.play(want, false);
    if (an.cur === "strike" || an.cur === "chip" || an.cur === "pass") {
      an.amp = 0.66 + (p.kickPower == null ? 0.7 : p.kickPower) * 0.42;
    } else { an.amp = 1; }
    if (an.cur === "run") an.t = p.anim * 0.115;
    if (an.prev === "run") an.prevT = p.anim * 0.115;
    var pose = an.pose();

    var fa = p.face;
    if (ball && (p.speed() < 0.6 || (p.role === "gk" && p.dive > 0.05))) {
      fa = Math.atan2(ball.y - p.y, ball.x - p.x);
    }
    var F = { x: Math.cos(fa), y: Math.sin(fa), z: 0 };
    var R = { x: F.y, y: -F.x, z: 0 };
    var U = { x: 0, y: 0, z: 1 };

    var roll = (p.role === "gk" ? p.dive : 0) * p.diveDir * 1.45;
    if (roll) {
      var cs = Math.cos(roll), sn = Math.sin(roll);
      var R2 = { x: R.x * cs + U.x * sn, y: R.y * cs + U.y * sn, z: R.z * cs + U.z * sn };
      var U2 = { x: U.x * cs - R.x * sn, y: U.y * cs - R.y * sn, z: U.z * cs - R.z * sn };
      R = R2; U = U2;
    }

    var lift = (p.role === "gk" ? p.dive : 0) * 0.52;
    var run = Math.min(1, p.speed() / 6.5);
    var bob = Math.abs(Math.sin(p.anim * 0.72)) * run * 0.045;
    var root = { x: p.x + U.x * bob, y: p.y + U.y * bob, z: lift + U.z * bob };

    var J = solveRig(pose, root, R, F, U, p._rig);

    /* The skinned mesh takes the same solved rig. If the models are still
       loading, or the flag is off, this returns false and the primitive body
       below draws instead — so there is never a frame with no players. */
    if (typeof SKIN !== "undefined" && SKIN.enabled &&
        SKIN.collect(p, J, root, R, F, U)) return;

    var LTH = boneLen("knL"), SHN = boneLen("anL");
    var UA = boneLen("elL"), FA2 = boneLen("haL");
    var TOR = boneLen("chest") + boneLen("spine");

    /* legs */
    [["hipL", "knL", "anL"], ["hipR", "knR", "anR"]].forEach(function (t) {
      var hip = J[t[0]], kn = J[t[1]], an2 = J[t[2]];
      limbIns(hip, 0.091, 0.095, 0.16, LTH, 0.94, 0.78, skin, ROUGH.skin);
      limbIns(kn, 0.074, 0.078, 0.0, SHN * 0.30, 1.0, 0.96, skin, ROUGH.skin);
      limbIns(kn, 0.078, 0.082, SHN * 0.26, SHN * 0.88, 0.98, 0.88, sock, ROUGH.sock);
      /* boot: a short box on the foot joint, projecting along its own F */
      var bo = { o: { x: an2.o.x + an2.F.x * 0.05,
                      y: an2.o.y + an2.F.y * 0.05,
                      z: an2.o.z + an2.F.z * 0.05 },
                 R: an2.R, F: an2.F, U: an2.U };
      limbIns(bo, 0.072, 0.126, -0.05, 0.02, 0.86, 1.0, COL.boot, ROUGH.boot);
      limbIns(bo, 0.074, 0.128, -0.028, -0.008, 0.84, 0.96, "#e8eef4", ROUGH.sole);
      sphereIns(kn.o, 0.075, skin, ROUGH.skin);
      sphereIns(hip.o, 0.092, alt, ROUGH.short);
    });

    /* SHORTS.

       Was 0.345 m long with the taper widening downward -- 1.02 at the waist to
       1.13 at the hem. A 35 cm garment that gets wider as it descends is a
       skirt, and that is exactly what it read as: the hem reached mid-thigh, the
       legs never separated, and the figure lost its silhouette at the one place
       a footballer's proportions are most recognisable.

       Now 0.275 m and tapering IN toward the hem, so the thigh clears the fabric
       and the two legs read as two legs. */
    limbIns({ o: J.pelvis.o, R: J.pelvis.R, F: J.pelvis.F, U: J.pelvis.U },
            0.170, 0.125, -0.17, 0.105, 0.98, 1.06,
            p.team === "us" ? "#e4eaf0" : alt, ROUGH.short);
    limbIns(J.spine, 0.166 * ID.broad, 0.108, -TOR, 0.05, 1.40 * ID.broad, 0.96, kit, ROUGH.kit);
    limbIns(J.spine, 0.166 * ID.broad, 0.108, -TOR, -(TOR - 0.010), 1.35, 1.335, alt, ROUGH.kit);

    /* arms */
    [["shL", "elL", "haL"], ["shR", "elR", "haR"]].forEach(function (t) {
      var sh = J[t[0]], el = J[t[1]], ha = J[t[2]];
      limbIns(el, 0.053, 0.056, -UA * 0.16, FA2, 1.02, 0.86, skin, ROUGH.skin);
      limbIns(sh, 0.066 * ID.broad, 0.069, 0.0, UA * 0.86, 1.06, 0.92, sleeve, ROUGH.kit);
      limbIns(sh, 0.064, 0.067, UA * 0.80, UA * 0.90, 0.94, 0.90, alt, ROUGH.kit);
      sphereIns(el.o, 0.055, skin, ROUGH.skin);
      sphereIns(sh.o, 0.062, sleeve, ROUGH.kit);
      sphereIns(ha.o, 0.057, p.role === "gk" ? "#f2f4f7" : skin,
                p.role === "gk" ? ROUGH.glove : ROUGH.skin);
    });

    /* neck and head */
    limbIns(J.neck, 0.068, 0.066, -(boneLen("head") + 0.01), 0.06, 0.86, 1.05, skin, ROUGH.skin);
    var hd = J.head;
    var hc = { x: hd.o.x + hd.U.x * 0.068,
               y: hd.o.y + hd.U.y * 0.068,
               z: hd.o.z + hd.U.z * 0.068 };
    /* One instance, and the shader puts the hair and the face on it. The first
       attempt stacked a hair sphere on top of the head sphere at a SMALLER
       radius, so it was entirely inside the skull and invisible — the head just
       looked bald. Analytic beats stacked geometry here. */
    headIns(hc, hd.R, hd.U, hd.F, 0.127, skin, hair, ID.hair);
  }

  function collectPlayers(world) {
    pl_n = 0; ps_n = 0; ph_n = 0;
    if (typeof SKIN !== "undefined" && SKIN.enabled) {
      SKIN.reset();
      SKIN.setCamera(Cam.px, Cam.py);
    }
    var all = world.us.concat(world.them);
    for (var i = 0; i < all.length; i++) emitPlayer(all[i], world.ball, world);
    if (pl_n) {
      GLX.update(PLI, "aIns", pl_m0);  GLX.update(PLI, "aIns2", pl_m1);
      GLX.update(PLI, "aIns3", pl_m2); GLX.update(PLI, "aCol", pl_col);
      GLX.update(PLI, "aTap", pl_tap);
    }
    if (ps_n) {
      GLX.update(PSI, "aIns", ps_m0); GLX.update(PSI, "aCol", ps_col);
    }
    if (ph_n) {
      GLX.update(PHI, "aIns", ph_m0);  GLX.update(PHI, "aIns2", ph_m1);
      GLX.update(PHI, "aIns3", ph_m2); GLX.update(PHI, "aCol", ph_col);
      GLX.update(PHI, "aTap", ph_tap);
    }
  }

  function drawPlayers(depthOnly) {
    if (typeof SKIN !== "undefined" && SKIN.enabled) SKIN.draw(depthOnly, mLightVP);
    if (!pl_n && !ps_n) return;
    var L = GLX.use(depthOnly ? P.playerDepth : P.player);
    if (depthOnly) gl.uniformMatrix4fv(L.u.uVP, false, mLightVP);
    else setCommon(L);
    if (pl_n) GLX.draw(PLI, gl.TRIANGLES, pl_n);

    var S = GLX.use(depthOnly ? P.playerSphereDepth : P.playerSphere);
    if (depthOnly) gl.uniformMatrix4fv(S.u.uVP, false, mLightVP);
    else setCommon(S);
    if (ps_n) GLX.draw(PSI, gl.TRIANGLES, ps_n);

    var Hd = GLX.use(depthOnly ? P.headDepth : P.head);
    if (depthOnly) gl.uniformMatrix4fv(Hd.u.uVP, false, mLightVP);
    else setCommon(Hd);
    if (ph_n) GLX.draw(PHI, gl.TRIANGLES, ph_n);
  }

  /* ==================================================================== */
  /* attach                                                                */
  /* ==================================================================== */

  /* The canvas world passes this file takes over. Replacing them rather than
     editing render.js means the canvas renderer is untouched and one line
     flips the whole thing back. */
  var TAKEN = ["drawSky", "drawStadium", "drawDepthHaze", "drawPitch",
               "drawFloodPools", "drawGrain", "drawRings", "drawGoal",
               "drawCornerFlags", "drawBall", "drawGrade",
               /* the actors moved to GL, so the canvas pass has to stop drawing
                  them or every player is rendered twice — once correctly in the
                  depth buffer and once as a flat sprite over the top */
               "drawPlayer"];

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
    /* the 2D renderer is fill-bound on the CPU: a 4K budget there is a
       slideshow, so hand it back the one it was written for */
    if (typeof RES !== "undefined") RES.target(yes ? RES.T2K : RES.T4K);
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
        /* Fall back for THIS SESSION only — do not persist the opt-out.

           Persisting it was a real bug: a single transient failure (a shader
           typo during development, a context lost because too many tabs were
           open) wrote goalio_gl="0" and disabled the renderer permanently, so
           fixing the actual fault changed nothing and the game silently stayed
           on canvas. If the device genuinely cannot run this, boot fails again
           next load and falls back again — same outcome, no dead end. */
        console.warn("[gl] boot failed — canvas renderer for this session");
        useCanvas(true);
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
    /* The shared GLSL. js/skin.gl.js compiles its own programs and has to be
       lit by the same rig as everything else — a second copy of these chunks
       would drift, and a player lit differently from the pitch he stands on is
       the most obvious wrongness a renderer can produce. */
    glsl: { HEAD: HEAD, COMMON: COMMON, PBR: PBR, SHADOW: SHADOW_CHUNK },
    bindCommon: function (prg) { setCommon(prg); },
    useCanvas: useCanvas,
    stats: function () {
      return { crowd: CROWD_N, rows: BOWL.rows, K: BOWL.K,
               post: !!(typeof GPOST !== "undefined" && GPOST.ready()),
               posting: POSTING };
    },
    frame: frame,
    boot: boot,
    on_: function () { try { localStorage.setItem("goalio_gl", "1"); } catch (e) {} location.reload(); },
    off: function () { try { localStorage.setItem("goalio_gl", "0"); } catch (e) {} location.reload(); }
  };
})();
