/* goal.io — the post-processing chain for the WebGL renderer.

   The scene renders into an RGBA16F target instead of the back buffer, and this
   file turns that buffer into the finished picture. It is the reason the WebGL
   rewrite was worth doing: none of it is reachable on a 2D canvas, because all
   of it needs either values brighter than white or per-pixel scene depth.

   The chain, in order:

     1  bright pass      half res, everything above the knee
     2  blur A           separable Gaussian, half res
     3  blur B           separable Gaussian, quarter res -> the wide glow
     4  composite        tonemap, bloom, DoF, motion blur, grade, vignette

   Why each one is here rather than being faked in 2D:

   BLOOM needs to know which pixels are genuinely brighter than white. An 8-bit
   target clamps at 1.0 and that information is gone, so blurring it gives you a
   soft copy of the image instead of light spilling off the floodlights. Two blur
   levels rather than one because a single radius reads as a halo; a tight one
   plus a wide one reads as glare.

   TONEMAP is what stops the advertising hoardings blowing out to flat white,
   which the pre-release review flagged. A clamp crushes everything above 1 to
   the same value; an ACES-style curve keeps the roll-off and the hue.

   DEPTH OF FIELD needs scene depth per pixel. The focus distance is driven from
   the ball, so the ball is always sharp and the crowd behind it goes soft —
   which is the single strongest cue that a camera is a lens and not a window.

   MOTION BLUR is reprojected, not faked. Each pixel's world position is
   reconstructed from depth, projected with the PREVIOUS frame's view-projection,
   and the difference is that pixel's screen velocity. Blurring along it gives
   real camera blur that is correct for rotation, translation and the zoom punch
   at once. A radial smear from the frame centre — the cheap version — is wrong
   the moment the camera pans.

   All of it is driven by CONDITIONS, so a floodlit night grades differently from
   a golden-hour afternoon rather than having a filter laid over the top.
*/
"use strict";

var GPOST = (function () {

  var gl = null;
  var P = {};                    // programs
  var scene = null;              // RGBA16F + depth texture
  /* Three half-res targets, not two. The depth-of-field blur and the bloom
     blur cannot share a scratch buffer: whichever runs second clobbers the
     first one's result, and the symptom is bloom appearing in the out-of-focus
     mix (or the reverse) rather than an obvious error. */
  var bloomH = null, dofH = null, tmpH = null;
  var bloomQ = null, tmpQ = null;
  var quad = null;
  var W = 0, H = 0;
  var ready = false;

  /* previous frame's view-projection, for reprojected motion blur */
  var prevVP = new Float32Array(16);
  var havePrev = false;

  var HEAD = "#version 300 es\nprecision highp float;\n";

  /* Fullscreen triangle from gl_VertexID: no buffers, no VAO contents. The
     single big triangle covers the screen with fewer vertices than a quad and
     avoids the diagonal seam some drivers show on a two-triangle quad. */
  var FS_VS = HEAD + `
  out vec2 vUv;
  void main(){
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  /* ---- 1. bright pass -------------------------------------------------
     A soft knee rather than a hard threshold. A hard cut makes bloom pop on
     and off as a highlight crosses the threshold, which reads as flickering
     on anything moving — and the floodlights and the ball both move. */
  var BRIGHT_FS = HEAD + `
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uSrc;
  uniform vec2 uKnee;            // x = threshold, y = knee width
  void main(){
    vec3 c = texture(uSrc, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    float t = uKnee.x, k = max(uKnee.y, 1e-4);
    /* quadratic knee: 0 below t-k, smooth through t, linear above t+k */
    float s = clamp((l - t + k) / (2.0 * k), 0.0, 1.0);
    float w = max(l - t, s * s * k);
    oCol = vec4(c * (w / max(l, 1e-4)), 1.0);
  }`;

  /* ---- 2/3. separable Gaussian ---------------------------------------
     Nine taps using linear-filtered pairs, so it costs five samples for a
     thirteen-pixel kernel. */
  var BLUR_FS = HEAD + `
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uSrc;
  uniform vec2 uDir;             // texel-sized step, one axis at a time
  void main(){
    vec3 c = texture(uSrc, vUv).rgb * 0.227027;
    c += texture(uSrc, vUv + uDir * 1.384615).rgb * 0.316216;
    c += texture(uSrc, vUv - uDir * 1.384615).rgb * 0.316216;
    c += texture(uSrc, vUv + uDir * 3.230769).rgb * 0.070270;
    c += texture(uSrc, vUv - uDir * 3.230769).rgb * 0.070270;
    oCol = vec4(c, 1.0);
  }`;

  /* ---- downsample ---------------------------------------------------- */
  var DOWN_FS = HEAD + `
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uSrc;
  uniform vec2 uTexel;
  void main(){
    /* four-tap box, on texel centres, so the downsample does not alias */
    vec3 c  = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
    c += texture(uSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    oCol = vec4(c * 0.25, 1.0);
  }`;

  /* ---- 4. composite --------------------------------------------------- */
  var COMP_FS = HEAD + `
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uScene;
  uniform sampler2D uBloomA;     // tight glow
  uniform sampler2D uBloomB;     // wide glow
  uniform sampler2D uBlur;       // half-res blurred scene, for DoF
  uniform highp sampler2D uDepth;

  uniform vec2  uTexel;
  uniform float uBloom;          // strength
  uniform float uExposure;
  uniform vec3  uTint;           // colour temperature / grade
  uniform float uSat;
  uniform float uContrast;
  uniform vec2  uVig;            // x = amount, y = softness
  uniform float uGrain;
  uniform float uTime;

  /* depth of field */
  uniform vec2  uNearFar;
  uniform vec2  uFocus;          // x = focus distance (m), y = strength
  /* motion blur */
  uniform mat4  uInvVP;          // clip -> world, this frame
  uniform mat4  uPrevVP;         // world -> clip, previous frame
  uniform float uMBlur;          // strength, 0 disables
  uniform vec3  uEye;

  float linearDepth(float d){
    float z = d * 2.0 - 1.0;
    return (2.0 * uNearFar.x * uNearFar.y) /
           (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
  }

  /* HIGHLIGHT SHOULDER, not a full tonemap.

     A full filmic curve (ACES and friends) assumes a scene-referred input:
     linear radiance where mid-grey sits near 0.18. This renderer's shaders
     output DISPLAY-referred colour — they were tuned to look correct as the
     final image. Running ACES over that is double-tonemapping, and it is not
     subtle: measured here, it lifted the turf's red channel from 86 to 140 and
     cut saturation from 0.58 to 0.32. The picture went milky.

     What is actually wanted is only the top end: leave everything below the
     knee exactly as the shader intended, and roll off above it so a bright
     hoarding or a floodlight compresses instead of clipping flat. Identity
     below k, asymptotic to 1.0 above it, C1 continuous at the join. */
  vec3 shoulder(vec3 c){
    const float k = 0.74;
    vec3 over = max(c - k, 0.0);
    vec3 roll = k + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
    return mix(c, roll, step(vec3(k), c));
  }

  void main(){
    float d = texture(uDepth, vUv).r;
    float dist = linearDepth(d);

    /* ---- motion blur, reprojected ---------------------------------- */
    vec3 col;
    vec2 vel = vec2(0.0);
    if (uMBlur > 0.001 && d < 1.0){
      vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 wp = uInvVP * clip;
      wp /= wp.w;
      vec4 pc = uPrevVP * wp;
      if (pc.w > 0.0){
        vec2 pUv = (pc.xy / pc.w) * 0.5 + 0.5;
        vel = (vUv - pUv) * uMBlur;
        /* cap it: an unbounded velocity smears the whole frame on a hard cut */
        float m = length(vel);
        if (m > 0.045) vel *= 0.045 / m;
      }
    }

    if (dot(vel, vel) > 1e-8){
      /* seven taps along the velocity, centred, so the blur is symmetric and
         the sharp image still dominates */
      col = vec3(0.0);
      float wsum = 0.0;
      for (int i = -3; i <= 3; i++){
        float t = float(i) / 3.0;
        float w = 1.0 - abs(t) * 0.65;
        col += texture(uScene, vUv + vel * t * 0.5).rgb * w;
        wsum += w;
      }
      col /= wsum;
    } else {
      col = texture(uScene, vUv).rgb;
    }

    /* ---- depth of field -------------------------------------------- */
    if (uFocus.y > 0.001){
      /* circle of confusion from the focus plane, in metres, normalised. The
         far side is allowed to go much softer than the near side because that
         is how a long lens behaves and it keeps the pitch crisp. */
      float dz = dist - uFocus.x;
      float coc = dz > 0.0 ? dz / 55.0 : -dz / 14.0;
      coc = clamp(coc, 0.0, 1.0) * uFocus.y;
      if (d >= 1.0) coc = uFocus.y;          // sky: always at infinity
      vec3 soft = texture(uBlur, vUv).rgb;
      col = mix(col, soft, coc);
    }

    /* ---- bloom ------------------------------------------------------ */
    vec3 bl = texture(uBloomA, vUv).rgb * 0.62 + texture(uBloomB, vUv).rgb * 0.38;
    col += bl * uBloom;

    /* ---- exposure, contrast, shoulder, grade ------------------------ */
    col *= uExposure;
    col *= uTint;

    /* CONTRAST BEFORE THE SHOULDER, not after.

       It used to run after, which undoes the shoulder's whole job: the roll-off
       lands a highlight at 0.90, contrast about mid grey pushes it back to 0.95
       or past 1.0, and the frame clips again at exactly the values that were
       just rescued. Ordered this way the contrast is free to push highlights
       over 1.0 because the shoulder is downstream to catch them, which is what
       lets the curve be strong enough to see. */
    col = (col - 0.5) * uContrast + 0.5;
    col = shoulder(col);

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, uSat);

    /* ---- vignette --------------------------------------------------- */
    vec2 q = vUv - 0.5;
    float r = length(q * vec2(1.0, 1.12));
    col *= 1.0 - uVig.x * smoothstep(uVig.y, 0.78, r);

    /* ---- grain ------------------------------------------------------ */
    if (uGrain > 0.0){
      float n = fract(sin(dot(vUv * vec2(1234.5, 6789.1) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
    }

    oCol = vec4(max(col, 0.0), 1.0);
  }`;

  /* ------------------------------------------------------------------ setup */

  function build(glc) {
    gl = glc;
    P.bright = GLX.prog("post.bright", FS_VS, BRIGHT_FS);
    P.blur   = GLX.prog("post.blur",   FS_VS, BLUR_FS);
    P.down   = GLX.prog("post.down",   FS_VS, DOWN_FS);
    P.comp   = GLX.prog("post.comp",   FS_VS, COMP_FS);
    quad = GLX.fullscreen();
    ready = !!(P.bright && P.blur && P.down && P.comp);
    return ready;
  }

  function resize(w, h) {
    if (w === W && h === H && scene) return true;
    W = w; H = h;
    GLX.freeTarget(scene);
    GLX.freeTarget(bloomH); GLX.freeTarget(dofH); GLX.freeTarget(tmpH);
    GLX.freeTarget(bloomQ); GLX.freeTarget(tmpQ);
    var hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    var qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    scene  = GLX.colorTarget(w, h, { hdr: true, depth: true });
    bloomH = GLX.colorTarget(hw, hh, { hdr: true, depth: false });
    dofH   = GLX.colorTarget(hw, hh, { hdr: true, depth: false });
    tmpH   = GLX.colorTarget(hw, hh, { hdr: true, depth: false });
    bloomQ = GLX.colorTarget(qw, qh, { hdr: true, depth: false });
    tmpQ   = GLX.colorTarget(qw, qh, { hdr: true, depth: false });
    havePrev = false;
    return !!(scene && bloomH && dofH && tmpH && bloomQ && tmpQ);
  }

  /* bind the scene target — the renderer draws into this instead of the screen */
  function begin() {
    if (!ready || !scene) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb);
    gl.viewport(0, 0, scene.w, scene.h);
    return true;
  }

  function blit(prg, dstFb, dw, dh) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb);
    gl.viewport(0, 0, dw, dh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    GLX.draw(quad, gl.TRIANGLES);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  function gauss(src, dst, tmp, w, h, radius) {
    var B = GLX.use(P.blur);
    /* horizontal into tmp */
    GLX.bindTex(0, src.tex); gl.uniform1i(B.u.uSrc, 0);
    gl.uniform2f(B.u.uDir, radius / w, 0);
    blit(B, tmp.fb, w, h);
    /* vertical back into dst */
    GLX.bindTex(0, tmp.tex); gl.uniform1i(B.u.uSrc, 0);
    gl.uniform2f(B.u.uDir, 0, radius / h);
    blit(B, dst.fb, w, h);
  }

  /* ------------------------------------------------------------------- end
     opts: { vp, invVP, near, far, focus, exposure, tint, sat, contrast,
             bloom, vig, grain, mblur, eye, viewport:[x,y,w,h] } */
  function end(opts) {
    if (!ready || !scene) return false;
    opts = opts || {};
    var hw = bloomH.w, hh = bloomH.h, qw = bloomQ.w, qh = bloomQ.h;

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);

    /* 1. depth-of-field source FIRST, while the scratch buffer is free.
          Downsample the SCENE (not the bright pass — a bright pass would send
          out-of-focus dark areas to black instead of soft) and blur it. */
    var Dn = GLX.use(P.down);
    GLX.bindTex(0, scene.tex); gl.uniform1i(Dn.u.uSrc, 0);
    gl.uniform2f(Dn.u.uTexel, 1 / W, 1 / H);
    blit(Dn, dofH.fb, hw, hh);
    gauss(dofH, dofH, tmpH, hw, hh, 2.1);

    /* 2. bright pass, scene -> bloomH */
    var Br = GLX.use(P.bright);
    GLX.bindTex(0, scene.tex); gl.uniform1i(Br.u.uSrc, 0);
    gl.uniform2f(Br.u.uKnee, opts.knee == null ? 0.92 : opts.knee, 0.42);
    blit(Br, bloomH.fb, hw, hh);

    /* 3. tight glow (tmpH is reusable now that DoF is done) */
    gauss(bloomH, bloomH, tmpH, hw, hh, 1.35);

    /* 4. wide glow: quarter res, blurred harder */
    var Dn2 = GLX.use(P.down);
    GLX.bindTex(0, bloomH.tex); gl.uniform1i(Dn2.u.uSrc, 0);
    gl.uniform2f(Dn2.u.uTexel, 1 / hw, 1 / hh);
    blit(Dn2, bloomQ.fb, qw, qh);
    gauss(bloomQ, bloomQ, tmpQ, qw, qh, 2.6);

    /* 5. composite to the screen, inside the play area */
    var C = GLX.use(P.comp);
    GLX.bindTex(0, scene.tex);  gl.uniform1i(C.u.uScene, 0);
    GLX.bindTex(1, bloomH.tex); gl.uniform1i(C.u.uBloomA, 1);
    GLX.bindTex(2, bloomQ.tex); gl.uniform1i(C.u.uBloomB, 2);
    GLX.bindTex(3, dofH.tex);   gl.uniform1i(C.u.uBlur, 3);
    GLX.bindTex(4, scene.depth); gl.uniform1i(C.u.uDepth, 4);

    gl.uniform2f(C.u.uTexel, 1 / W, 1 / H);
    gl.uniform1f(C.u.uBloom, opts.bloom == null ? 0.55 : opts.bloom);
    gl.uniform1f(C.u.uExposure, opts.exposure == null ? 1 : opts.exposure);
    var t = opts.tint || [1, 1, 1];
    gl.uniform3f(C.u.uTint, t[0], t[1], t[2]);
    gl.uniform1f(C.u.uSat, opts.sat == null ? 1.0 : opts.sat);
    gl.uniform1f(C.u.uContrast, opts.contrast == null ? 1.0 : opts.contrast);
    var v = opts.vig || [0.24, 0.35];
    gl.uniform2f(C.u.uVig, v[0], v[1]);
    gl.uniform1f(C.u.uGrain, opts.grain == null ? 0.012 : opts.grain);
    gl.uniform1f(C.u.uTime, (opts.time || 0) % 1000);

    gl.uniform2f(C.u.uNearFar, opts.near || 0.35, opts.far || 400);
    var f = opts.focus || [30, 0];
    gl.uniform2f(C.u.uFocus, f[0], f[1]);

    gl.uniformMatrix4fv(C.u.uInvVP, false, opts.invVP || IDENT);
    gl.uniformMatrix4fv(C.u.uPrevVP, false, havePrev ? prevVP : (opts.vp || IDENT));
    gl.uniform1f(C.u.uMBlur, havePrev ? (opts.mblur == null ? 0 : opts.mblur) : 0);
    var e = opts.eye || [0, 0, 0];
    gl.uniform3f(C.u.uEye, e[0], e[1], e[2]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    var vpr = opts.viewport;
    if (vpr) {
      gl.viewport(vpr[0], vpr[1], vpr[2], vpr[3]);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(vpr[0], vpr[1], vpr[2], vpr[3]);
    } else {
      gl.viewport(0, 0, W, H);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    GLX.draw(quad, gl.TRIANGLES);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    if (opts.vp) { prevVP.set(opts.vp); havePrev = true; }
    return true;
  }

  var IDENT = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

  return {
    build: build, resize: resize, begin: begin, end: end,
    ready: function () { return ready; },
    target: function () { return scene; },
    reset: function () { havePrev = false; }
  };
})();
