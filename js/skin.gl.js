/* goal.io — skinned, textured players.

   THE POINT OF THIS FILE
   ----------------------
   Players were ~35 analytic primitives each: cylinders for limbs, spheres for
   joints, an analytic face. That reads acceptably at gameplay distance and is
   the single biggest thing making the game look like a prototype — no faces,
   no cloth, no kit detail, a head floating over a collar band.

   docs/GRAPHICS-AUDIT.md called this the hard ceiling and said the assets to
   lift it "cannot be produced from inside the project". They already existed:
   football-characters/ has four rigged, textured, LOD'd glTF footballers and
   the pure-Python generator that made them. They are now in assets/models/.

   These are the first textures of any kind in this project.

   HOW THE ANIMATION MAPS, AND WHY IT NEEDS NO EULER CONVERSION
   -----------------------------------------------------------
   The obvious approach — convert anim.js's per-joint [pitch, yaw, roll] into
   glTF-local rotations — is a trap. The two rigs put their bones on different
   local axes: goal.io bones all extend along their own -U, glTF bones extend
   along +Y for the spine, +X for the arms and -Y for the legs, because glTF
   joints are axis-aligned with the model in bind pose. A pitch about "the
   joint's own right axis" is a different rotation in each rig, per bone.

   The way through is that solveRig() does not return Euler angles. It returns
   a world-space orthonormal basis (R, F, U) per joint. And BOTH rigs are
   identity in bind pose: solveRig with a neutral pose gives every joint the
   player's base basis, and every glTF joint has no bind rotation (the loader
   asserts this). So one fixed correspondence holds for every joint:

       glTF local +X  ->  -R      (glTF faces +Z with +Y up, so its right is -X;
       glTF local +Y  ->   U       goal.io faces +F with +U up and right +R)
       glTF local +Z  ->   F

   A joint's world matrix is therefore just [-R | U | F | position], built
   straight from the solver's output. No angles are converted anywhere.

   Positions walk the glTF hierarchy using the glTF bind translations, NOT
   goal.io's rig offsets. The two skeletons have near-identical proportions
   (0.42 vs 0.422 thigh, 0.26 vs 0.282 upper arm) but "near" is not "equal",
   and the skin has to match the mesh it deforms, not the stick figure that
   inspired it.

   Sanity check on the whole scheme: with a neutral pose every Q collapses to
   the base basis and skin = translate(root) * B * translate(bind) *
   translate(-bind) = translate(root) * B. Every vertex lands at the player's
   position with the player's facing, which is exactly right.

   TURN IT OFF
     ?skin=0, or SKIN.off(). The primitive players are still there and still
     work; if the models fail to load, boot() returns false and nothing here
     runs.
*/
"use strict";

var SKIN = (function () {

  var gl = null;
  var ready = false;          // models loaded, buffers built
  var enabled = true;         // flag
  var failed = false;
  var P = {};                 // programs
  var MODELS = {};            // key -> gpu model
  var JOINTS = 27;            // uniform array size; asserted against the models

  /* Which of the 27 Unity-Humanoid joints anim.js actually drives. The other
     ten — UpperChest, both shoulders, both sets of toes and the five *_End
     tips — inherit their parent, which is what a zero local rotation means. */
  var MAP = {
    Hips: "pelvis", Spine: "spine", Chest: "chest", Neck: "neck", Head: "head",
    LeftUpperArm: "shL", LeftLowerArm: "elL", LeftHand: "haL",
    RightUpperArm: "shR", RightLowerArm: "elR", RightHand: "haR",
    LeftUpperLeg: "hipL", LeftLowerLeg: "knL", LeftFoot: "anL",
    RightUpperLeg: "hipR", RightLowerLeg: "knR", RightFoot: "anR"
  };

  /* goal.io's left is -x in its own frame and glTF's Left is +x in its own,
     and the basis map above already flips x — so LeftUpperArm really does take
     shL and no side swap is needed. Getting this backwards produces a player
     who is subtly, unplaceably wrong: mirrored kit, wrong standing foot. */

  /* ---------------------------------------------------------- bind fixups
     THE T-POSE BUG, AND WHY IT IS NOT A HARDCODED TABLE.

     The first version of this file rendered a player standing with both arms
     straight out sideways. The basis mapping was right; what was wrong is an
     assumption underneath it — that a joint's bone points the same way in both
     rigs at bind.

     It does for the legs and the spine: glTF's LeftUpperLeg runs to its child
     along local -Y, and goal.io's hipL runs to knL along -U, which the axis map
     sends to -Y. Identical. But glTF is authored in a T-pose, so LeftUpperArm
     runs along +X, while goal.io's neutral arm HANGS, running along -U. The
     idle clip's small shoulder angles are adjustments to a hanging arm, not to
     a T-pose, so applying them to a T-pose arm leaves it out sideways.

     So each mapped joint needs the rotation that takes its glTF bind bone
     direction to its goal.io bind bone direction. Both are in the files, so
     this derives the correction from the two rigs rather than hardcoding
     ±90 degrees per arm — which would be four more numbers to get backwards,
     and would silently break if either rig were re-authored. */

  function normalize3(v) {
    var m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  }

  /* Minimal rotation taking unit a to unit b (Rodrigues), as a 3x3 in column
     order. Returns null for "already aligned", which keeps the common case
     free. */
  function alignRot(a, b) {
    var c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (c > 0.99999) return null;
    var vx = a[1] * b[2] - a[2] * b[1];
    var vy = a[2] * b[0] - a[0] * b[2];
    var vz = a[0] * b[1] - a[1] * b[0];
    var s = Math.hypot(vx, vy, vz);
    if (s < 1e-6) {
      /* exactly opposed: spin a half turn about any perpendicular */
      var ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      vx = a[1] * ax[2] - a[2] * ax[1];
      vy = a[2] * ax[0] - a[0] * ax[2];
      vz = a[0] * ax[1] - a[1] * ax[0];
      s = Math.hypot(vx, vy, vz) || 1;
      vx /= s; vy /= s; vz /= s;
      return [2*vx*vx-1, 2*vx*vy, 2*vx*vz,
              2*vy*vx, 2*vy*vy-1, 2*vy*vz,
              2*vz*vx, 2*vz*vy, 2*vz*vz-1];
    }
    var k = 1 / (1 + c);
    /* columns of I + [v]x + [v]x^2 * k */
    return [
      1 + k*(-vz*vz - vy*vy),      vz + k*(vx*vy),            -vy + k*(vx*vz),
      -vz + k*(vx*vy),             1 + k*(-vz*vz - vx*vx),     vx + k*(vy*vz),
      vy + k*(vx*vz),              -vx + k*(vy*vz),            1 + k*(-vy*vy - vx*vx)
    ];
  }

  /* A goal.io offset is [along R, along F, along U]. The axis map sends
     R -> -x, F -> +z, U -> +y in glTF-local terms. */
  function goalioDirToGltf(o) {
    return normalize3([-o[0], o[2], o[1]]);
  }

  /* Precompute one correction per joint, once per model. Static data: it
     depends only on the two skeletons, never on the pose. */
  function buildFixups(joints) {
    var childOf = {};
    joints.forEach(function (j, i) { if (j.parent >= 0 && childOf[j.parent] == null) childOf[j.parent] = i; });

    var rigChild = {};
    if (typeof RIG !== "undefined") {
      RIG.forEach(function (r) { if (r.p && rigChild[r.p] == null) rigChild[r.p] = r; });
    }

    for (var i = 0; i < joints.length; i++) {
      var j = joints[i];
      var g = MAP[j.name];
      var kid = childOf[i];
      var rc = g ? rigChild[g] : null;
      j.fix = null;

      if (g && rc && kid != null) {
        var gltfDir = normalize3(joints[kid].t);
        var rigDir = goalioDirToGltf(rc.o);
        if (Math.hypot(joints[kid].t[0], joints[kid].t[1], joints[kid].t[2]) > 1e-6) {
          j.fix = alignRot(gltfDir, rigDir);
        }
      }
      /* A leaf in goal.io's rig — hands, head, feet — has no bone to align, so
         it takes whatever its parent did. Without this the hand keeps the
         T-pose twist while the forearm swings down, and the wrist shears. */
      if (!j.fix && g && j.parent >= 0) j.fix = joints[j.parent].fix || null;
      if (!g && j.parent >= 0) j.fix = joints[j.parent].fix || null;
    }
    return joints;
  }

  var FILES = {
    us:   "assets/models/Defender.glb",     // red, plain      -> COL.us
    them: "assets/models/Forward.glb",      // blue halves     -> COL.them
    gk:   "assets/models/Goalkeeper.glb"    // teal, sash      -> COL.gk
  };

  function flagged() {
    try {
      if (/[?&]skin=0/.test(location.search)) return false;
      if (/[?&]skin=1/.test(location.search)) return true;
      return localStorage.getItem("goalio_skin") !== "0";
    } catch (e) { return true; }
  }

  /* ==================================================================== */
  /* shaders                                                               */
  /* ==================================================================== */

  function shaders() {
    var G = (typeof GLR !== "undefined" && GLR.glsl) ? GLR.glsl : null;
    if (!G) return null;

    var VS = G.HEAD + `
    in vec3 aPos;
    in vec3 aNrm;
    in vec2 aUv;
    in vec4 aJoint;      // uploaded as float: WebGL2 integer attributes buy
    in vec4 aWeight;     // nothing here and cost a second attribute format
    uniform mat4 uVP;
    uniform mat4 uJoints[${JOINTS}];
    out vec3 vW, vN;
    out vec2 vUv;
    void main() {
      mat4 sk = uJoints[int(aJoint.x)] * aWeight.x
              + uJoints[int(aJoint.y)] * aWeight.y
              + uJoints[int(aJoint.z)] * aWeight.z
              + uJoints[int(aJoint.w)] * aWeight.w;
      vec4 w = sk * vec4(aPos, 1.0);
      vW = w.xyz;
      /* The skin matrix is a weighted blend of rigid transforms, so it is not
         orthonormal mid-blend and the normal needs the same treatment as the
         position rather than a bare mat3 cast — at the elbow and the hip the
         difference is visible as a shading crease. Uniform scale throughout
         means normalising the mat3 is sufficient; no inverse-transpose. */
      vN = normalize(mat3(sk) * aNrm);
      vUv = aUv;
      gl_Position = uVP * w;
    }
    `;

    var FS = G.HEAD + G.COMMON + G.PBR + G.SHADOW + `
    in vec3 vW, vN;
    in vec2 vUv;
    out vec4 oCol;
    uniform sampler2D uBase;     // base colour
    uniform sampler2D uMR;       // glTF packing: G = roughness, B = metallic
    uniform vec4 uTint;          // baseColorFactor
    uniform vec2 uMRFactor;      // roughness, metallic multipliers
    void main() {
      vec4 base = texture(uBase, vUv) * uTint;
      vec4 mr = texture(uMR, vUv);
      float rough = clamp(mr.g * uMRFactor.x, 0.04, 1.0);
      float metal = clamp(mr.b * uMRFactor.y, 0.0, 1.0);

      vec3 n = normalize(vN);
      vec3 V = normalize(uEye - vW);
      float ndl = dot(n, uLight);

      /* Same normal-offset shadow lookup the primitive players use. Players
         cast into the shadow map and therefore sample it at their own surface;
         a depth bias alone left the torso shadowing itself. */
      float sh = shadowAt(vW + n * 0.045, ndl);
      float ao = mix(0.74, 1.0, clamp(vW.z / 1.4, 0.0, 1.0));

      vec3 lit = surfacePBR(vW, n, V, base.rgb, rough, metal, ao, sh);
      lit = grade(lit);
      oCol = vec4(applyFog(lit, length(uEye - vW)), 1.0);
    }
    `;

    var DEPTH_FS = G.HEAD + `
    out vec4 oCol;
    void main() { oCol = vec4(1.0); }
    `;

    return { VS: VS, FS: FS, DEPTH_FS: DEPTH_FS };
  }

  /* ==================================================================== */
  /* gpu upload                                                            */
  /* ==================================================================== */

  function upload(model) {
    var i, k;
    if (model.joints.length > JOINTS) {
      console.warn("[skin] " + model.url + " has " + model.joints.length +
                   " joints, shader holds " + JOINTS + " — skipping");
      return null;
    }

    var tex = model.images.map(function (img) {
      return GLX.texFromCanvas(img, { repeat: true });
    });

    var lods = model.meshes.map(function (mesh) {
      return mesh.prims.map(function (p) {
        /* JOINTS_0 arrives as Uint16. Widening to float here keeps one
           attribute format across every buffer in the renderer. */
        var jf = new Float32Array(p.joints.length);
        for (k = 0; k < p.joints.length; k++) jf[k] = p.joints[k];

        var m = GLX.mesh(P.shade, [
          { name: "aPos", size: 3, data: p.pos },
          { name: "aNrm", size: 3, data: p.nrm },
          { name: "aUv", size: 2, data: p.uv },
          { name: "aJoint", size: 4, data: jf },
          { name: "aWeight", size: 4, data: p.weights }
        ], p.idx);

        var mat = model.materials[p.material] || {};
        return {
          mesh: m,
          base: tex[mat.baseTex] || null,
          mr: tex[mat.mrTex] || null,
          tint: mat.baseColor || [1, 1, 1, 1],
          rough: mat.roughness == null ? 1 : mat.roughness,
          metal: mat.metallic == null ? 1 : mat.metallic,
          doubleSided: !!mat.doubleSided,
          name: mat.name || "",
          /* The kit is the one material a player can change. Matching on the
             name is fragile if the generator is renamed, so a miss just means
             the baked kit keeps showing — never a crash, never a blank shirt. */
          isKit: /kit/i.test(mat.name || "")
        };
      });
    });

    return { joints: buildFixups(model.joints), lods: lods, tex: tex, url: model.url };
  }

  /* ==================================================================== */
  /* the skin matrices                                                     */
  /* ==================================================================== */

  /* Scratch, sized on first use. A renderer that allocates per frame hands the
     GC a sawtooth, and the sawtooth is judder. */
  var Qs = null, Os = null, SKM = null, LASTMODEL = null;

  function ensureScratch(n) {
    if (!Qs || Qs.length < n * 9) {
      Qs = new Float32Array(n * 9);
      Os = new Float32Array(n * 3);
      SKM = new Float32Array(n * 16);
    }
  }

  /* J is solveRig()'s output: name -> {o, R, F, U} in world space.
     root/R/F/U are the player's placement, exactly as emitPlayer built them. */
  function solveSkin(model, J, root, R, F, U) {
    var joints = model.joints, n = joints.length;
    ensureScratch(n);
    LASTMODEL = model;

    /* the placement basis: glTF local x,y,z -> world -R, U, F */
    var bx0 = -R.x, bx1 = -R.y, bx2 = -R.z;
    var by0 = U.x, by1 = U.y, by2 = U.z;
    var bz0 = F.x, bz1 = F.y, bz2 = F.z;

    for (var i = 0; i < n; i++) {
      var j = joints[i], p = j.parent;
      var q0, q1, q2, q3, q4, q5, q6, q7, q8, px, py, pz;

      if (p < 0) {
        q0 = bx0; q1 = bx1; q2 = bx2;
        q3 = by0; q4 = by1; q5 = by2;
        q6 = bz0; q7 = bz1; q8 = bz2;
        px = root.x; py = root.y; pz = root.z;
      } else {
        var b = p * 9, o = p * 3;
        q0 = Qs[b]; q1 = Qs[b + 1]; q2 = Qs[b + 2];
        q3 = Qs[b + 3]; q4 = Qs[b + 4]; q5 = Qs[b + 5];
        q6 = Qs[b + 6]; q7 = Qs[b + 7]; q8 = Qs[b + 8];
        px = Os[o]; py = Os[o + 1]; pz = Os[o + 2];
      }

      /* position: parent origin + parent basis * this joint's bind offset */
      var t = j.t;
      var ox = px + q0 * t[0] + q3 * t[1] + q6 * t[2];
      var oy = py + q1 * t[0] + q4 * t[1] + q7 * t[2];
      var oz = pz + q2 * t[0] + q5 * t[1] + q8 * t[2];
      Os[i * 3] = ox; Os[i * 3 + 1] = oy; Os[i * 3 + 2] = oz;

      /* orientation: from the solved joint if anim.js drives it, else inherit */
      var g = MAP[j.name], jj = g ? J[g] : null;
      var a0, a1, a2, a3, a4, a5, a6, a7, a8;
      if (jj) {
        a0 = -jj.R.x; a1 = -jj.R.y; a2 = -jj.R.z;
        a3 = jj.U.x; a4 = jj.U.y; a5 = jj.U.z;
        a6 = jj.F.x; a7 = jj.F.y; a8 = jj.F.z;
      } else {
        a0 = q0; a1 = q1; a2 = q2; a3 = q3; a4 = q4; a5 = q5; a6 = q6; a7 = q7; a8 = q8;
      }
      /* Q' = Q * fix, so the bone the mesh was authored around ends up
         pointing where anim.js's bone points. Children read Q' too, which is
         what puts the elbow below the shoulder instead of out beside it. */
      var fx = j.fix;
      if (fx) {
        var n0 = a0*fx[0] + a3*fx[1] + a6*fx[2];
        var n1 = a1*fx[0] + a4*fx[1] + a7*fx[2];
        var n2 = a2*fx[0] + a5*fx[1] + a8*fx[2];
        var n3 = a0*fx[3] + a3*fx[4] + a6*fx[5];
        var n4 = a1*fx[3] + a4*fx[4] + a7*fx[5];
        var n5 = a2*fx[3] + a5*fx[4] + a8*fx[5];
        var n6 = a0*fx[6] + a3*fx[7] + a6*fx[8];
        var n7 = a1*fx[6] + a4*fx[7] + a7*fx[8];
        var n8 = a2*fx[6] + a5*fx[7] + a8*fx[8];
        a0=n0; a1=n1; a2=n2; a3=n3; a4=n4; a5=n5; a6=n6; a7=n7; a8=n8;
      }

      var qb = i * 9;
      Qs[qb] = a0; Qs[qb + 1] = a1; Qs[qb + 2] = a2;
      Qs[qb + 3] = a3; Qs[qb + 4] = a4; Qs[qb + 5] = a5;
      Qs[qb + 6] = a6; Qs[qb + 7] = a7; Qs[qb + 8] = a8;

      /* skin = [Q | o] * inverseBind, written straight into the upload array */
      var ib = j.ibm, m = i * 16;
      if (!ib) {
        SKM[m] = a0; SKM[m + 1] = a1; SKM[m + 2] = a2; SKM[m + 3] = 0;
        SKM[m + 4] = a3; SKM[m + 5] = a4; SKM[m + 6] = a5; SKM[m + 7] = 0;
        SKM[m + 8] = a6; SKM[m + 9] = a7; SKM[m + 10] = a8; SKM[m + 11] = 0;
        SKM[m + 12] = ox; SKM[m + 13] = oy; SKM[m + 14] = oz; SKM[m + 15] = 1;
        continue;
      }
      for (var c = 0; c < 4; c++) {
        var i0 = ib[c * 4], i1 = ib[c * 4 + 1], i2 = ib[c * 4 + 2], i3 = ib[c * 4 + 3];
        SKM[m + c * 4]     = a0 * i0 + a3 * i1 + a6 * i2 + ox * i3;
        SKM[m + c * 4 + 1] = a1 * i0 + a4 * i1 + a7 * i2 + oy * i3;
        SKM[m + c * 4 + 2] = a2 * i0 + a5 * i1 + a8 * i2 + oz * i3;
        SKM[m + c * 4 + 3] = i3;
      }
    }
    return SKM;
  }

  /* ==================================================================== */
  /* per-frame collection                                                  */
  /* ==================================================================== */

  var queue = [], qn = 0;

  /* GPU textures for painted kits, keyed the same way KIT caches its canvases.
     A match shows three or four distinct kits, so this stays tiny. */
  var kitTex = {};
  function kitTextureFor(p) {
    if (typeof KIT === "undefined" || !KIT.ready()) return null;
    var team = p.role === "gk" ? "gk" : (p.team === "us" ? "us" : "them");
    var season = 1;
    if (typeof world !== "undefined" && world && world.level && world.level.season) {
      season = world.level.season;
    }
    var spec = KIT.specFor(team, p.role, season);
    if (!spec) return null;
    /* Levels only name numbers for the player's own side, so opponents arrive
       as 0 and would all run out wearing a nought. Derive one from where they
       stand: deterministic, so a player keeps his number across a rewind. */
    var num = (p.num != null && p.num > 0)
      ? p.num
      : 2 + (Math.abs(Math.round(p.x * 7 + p.y * 3)) % 9);
    var key = team + "|" + season + "|" + num;
    if (kitTex[key] !== undefined) return kitTex[key];
    var canvas = KIT.get(spec, num);
    kitTex[key] = canvas ? GLX.texFromCanvas(canvas, { repeat: true }) : null;
    return kitTex[key];
  }

  function collect(p, J, root, R, F, U) {
    if (!ready) return false;
    var key = p.role === "gk" ? "gk" : (p.team === "us" ? "us" : "them");
    var model = MODELS[key];
    if (!model) return false;

    var mats = solveSkin(model, J, root, R, F, U);
    var slot = queue[qn];
    if (!slot) { slot = queue[qn] = { m: new Float32Array(JOINTS * 16) }; }
    slot.m.set(mats.subarray(0, model.joints.length * 16));
    slot.model = model;
    slot.nj = model.joints.length;
    slot.x = p.x; slot.y = p.y;
    slot.kit = kitTextureFor(p);
    qn++;
    return true;
  }

  function reset() { qn = 0; }

  /* ==================================================================== */
  /* draw                                                                  */
  /* ==================================================================== */

  function draw(depthOnly, lightVP) {
    if (!ready || !qn) return;
    var prg = depthOnly ? P.depth : P.shade;
    if (!prg) return;
    GLX.use(prg);

    if (depthOnly) {
      gl.uniformMatrix4fv(prg.u.uVP, false, lightVP);
    } else if (typeof GLR !== "undefined" && GLR.bindCommon) {
      GLR.bindCommon(prg);
    }

    for (var i = 0; i < qn; i++) {
      var q = queue[i];
      gl.uniformMatrix4fv(prg.u.uJoints, false, q.m);

      /* LOD. The models ship LOD1 at 26% of LOD0's triangles; past about 18 m
         on a 390 px-wide frame the difference is under a pixel. The shadow
         pass always takes LOD1 — nothing in a 1024 shadow map resolves the
         difference and it is a straight saving. */
      var d = Math.hypot(q.x - CAMX, q.y - CAMY);
      var lod = (depthOnly || d > 18) && q.model.lods.length > 1 ? 1 : 0;
      var prims = q.model.lods[lod];

      for (var k = 0; k < prims.length; k++) {
        var pr = prims[k];
        if (!depthOnly) {
          /* a painted kit overrides the baked one; everything else — skin,
             boots, hair — keeps the texture that shipped with the model */
          GLX.bindTex(6, (pr.isKit && q.kit) ? q.kit : pr.base);
          gl.uniform1i(prg.u.uBase, 6);
          GLX.bindTex(7, pr.mr);
          gl.uniform1i(prg.u.uMR, 7);
          gl.uniform4f(prg.u.uTint, pr.tint[0], pr.tint[1], pr.tint[2], pr.tint[3]);
          gl.uniform2f(prg.u.uMRFactor, pr.rough, pr.metal);
          if (pr.doubleSided) gl.disable(gl.CULL_FACE);
        }
        GLX.draw(pr.mesh);
        if (!depthOnly && pr.doubleSided) gl.enable(gl.CULL_FACE);
      }
    }
  }

  /* the LOD test needs the camera, and Cam is a global from render.js */
  var CAMX = 0, CAMY = 0;
  function setCamera(x, y) { CAMX = x; CAMY = y; }

  /* ==================================================================== */
  /* boot                                                                  */
  /* ==================================================================== */

  function boot(glctx) {
    if (failed || ready) return ready;
    enabled = flagged();
    if (!enabled) return false;
    if (typeof GLTF === "undefined" || typeof GLX === "undefined") return false;

    gl = glctx;
    var src = shaders();
    if (!src) { console.warn("[skin] GLR.glsl not exported — cannot share the light rig"); return false; }

    P.shade = GLX.prog("skin", src.VS, src.FS);
    P.depth = GLX.prog("skinDepth", src.VS, src.DEPTH_FS);
    if (!P.shade || !P.depth) { failed = true; return false; }

    /* Load in the background. Until every model is in, collect() returns false
       and the primitive players keep drawing — so the game is never waiting on
       1.4 MB of character models to show a pitch. */
    var keys = Object.keys(FILES);
    Promise.all(keys.map(function (k) { return GLTF.load(FILES[k]); }))
      .then(function (models) {
        models.forEach(function (m, i) {
          var g = upload(m);
          if (g) MODELS[keys[i]] = g;
        });
        ready = Object.keys(MODELS).length === keys.length;
        if (!ready) failed = true;
        console.info("[skin] " + Object.keys(MODELS).length + "/" + keys.length +
                     " models ready");
      })
      .catch(function (e) {
        failed = true;
        console.warn("[skin] models failed to load, primitive players stay:", e.message);
      });
    return true;
  }

  /* Joint world positions for the last player solved, by name. This exists
     because "the arm looks wrong" is not a measurement, and in this project a
     confident wrong theory has preceded the actual cause more than once. A
     symmetric pose must produce mirror-symmetric hands. */
  function debugJoints() {
    var out = {}, m = LASTMODEL;
    if (!m) return out;
    for (var i = 0; i < m.joints.length; i++) {
      out[m.joints[i].name] = [ +Os[i*3].toFixed(4), +Os[i*3+1].toFixed(4), +Os[i*3+2].toFixed(4) ];
    }
    return out;
  }

  return {
    boot: boot,
    debugJoints: debugJoints,
    collect: collect,
    reset: reset,
    draw: draw,
    setCamera: setCamera,
    get ready() { return ready; },
    get enabled() { return enabled && !failed; },
    /* Swap skinned and primitive players inside one page load. Same reason
       GLR.useCanvas exists: this machine moves up to 5 ms run to run for
       identical code, so comparing two page loads compares thermal states
       rather than renderers. */
    setEnabled: function (v) { enabled = !!v; },
    stats: function () {
      return { ready: ready, failed: failed, queued: qn,
               models: Object.keys(MODELS), joints: JOINTS };
    },
    off: function () { try { localStorage.setItem("goalio_skin", "0"); } catch (e) {} location.reload(); },
    on: function () { try { localStorage.setItem("goalio_skin", "1"); } catch (e) {} location.reload(); }
  };
})();
