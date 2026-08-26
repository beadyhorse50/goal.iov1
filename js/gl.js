/* goal.io — WebGL2 device layer. NOT a renderer; it owns the context, shaders,
   buffers and matrix maths so js/render.gl.js can be about football.

   Why this exists at all: js/render.js is a hand-written rasteriser on a 2D
   canvas, and that is the ceiling — no PBR, no shadow maps, no real post. This
   is the floor of the replacement, built behind a flag so the finished canvas
   renderer keeps shipping while this one is still ugly.

   WebGL2 only, and that is deliberate: instancing, depth textures and
   non-power-of-two mipmaps are all core there, so the crowd and the shadow map
   need no extension dance. init() returns null if the device cannot give us
   one, and the flag falls back to canvas.
*/
"use strict";

/* ------------------------------------------------------------------ mat4
   Column-major, the layout WebGL wants, so nothing is transposed on upload.
   out = a * b with column vectors: the rightmost matrix applies first. */
var M4 = {
  ident: function () {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  },

  mul: function (out, a, b) {
    var a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    for (var i = 0; i < 4; i++) {
      var b0=b[i*4], b1=b[i*4+1], b2=b[i*4+2], b3=b[i*4+3];
      out[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
      out[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
      out[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
      out[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
    }
    return out;
  },

  /* Vertical-FOV perspective. The canvas renderer works in focal pixels
     (Cam.F), so the caller converts: fovY = 2*atan((VP.h/2)/Cam.F). Doing it
     that way means FEEL's zoom punch and cinematic push drive this for free. */
  persp: function (out, fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    out[0]=f/aspect; out[1]=0; out[2]=0;  out[3]=0;
    out[4]=0; out[5]=f; out[6]=0;         out[7]=0;
    out[8]=0; out[9]=0; out[10]=(far+near)*nf; out[11]=-1;
    out[12]=0;out[13]=0;out[14]=2*far*near*nf; out[15]=0;
    return out;
  },

  /* Orthographic, for the shadow map's light camera. */
  ortho: function (out, l, r, b, t, near, far) {
    var lr=1/(l-r), bt=1/(b-t), nf=1/(near-far);
    out[0]=-2*lr; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=-2*bt; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=2*nf; out[11]=0;
    out[12]=(l+r)*lr; out[13]=(t+b)*bt; out[14]=(far+near)*nf; out[15]=1;
    return out;
  },

  /* Right-handed look-at. The world is z-up (x across the pitch, y down its
     length, z into the sky), so up is (0,0,1) everywhere except a camera
     looking straight down — which nothing here does. */
  look: function (out, eye, at, up) {
    var zx=eye[0]-at[0], zy=eye[1]-at[1], zz=eye[2]-at[2];
    var m = Math.hypot(zx,zy,zz) || 1; zx/=m; zy/=m; zz/=m;
    var xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
    m = Math.hypot(xx,xy,xz);
    if (m < 1e-6) { xx=1; xy=0; xz=0; } else { xx/=m; xy/=m; xz/=m; }
    var yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
    out[0]=xx; out[1]=yx; out[2]=zx; out[3]=0;
    out[4]=xy; out[5]=yy; out[6]=zy; out[7]=0;
    out[8]=xz; out[9]=yz; out[10]=zz; out[11]=0;
    out[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    out[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    out[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    out[15]=1;
    return out;
  },

  trs: function (out, tx, ty, tz, sx, sy, sz) {
    out[0]=sx; out[1]=0;  out[2]=0;  out[3]=0;
    out[4]=0;  out[5]=sy; out[6]=0;  out[7]=0;
    out[8]=0;  out[9]=0;  out[10]=sz;out[11]=0;
    out[12]=tx;out[13]=ty;out[14]=tz;out[15]=1;
    return out;
  },

  /* Rotation about z in clip space, used for camera-shake roll. */
  rotZ: function (out, a) {
    var c = Math.cos(a), s = Math.sin(a);
    out[0]=c; out[1]=s; out[2]=0; out[3]=0;
    out[4]=-s;out[5]=c; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=1;out[11]=0;
    out[12]=0;out[13]=0;out[14]=0;out[15]=1;
    return out;
  }
};

var GLX = (function () {
  var gl = null;
  var progs = {};
  var lastProg = null;

  /* ---------------------------------------------------------------- init */
  function init(el) {
    if (!el || !el.getContext) return null;
    /* preserveDrawingBuffer is on for a reason specific to this project: the
       dev browser never composites, so the only way to see a frame is to read
       it back after the fact (toDataURL / readPixels). It costs bandwidth on
       mobile — turn it off for a release build. */
    gl = el.getContext("webgl2", {
      alpha: true, depth: true, stencil: false, antialias: true,
      premultipliedAlpha: true, preserveDrawingBuffer: true,
      powerPreference: "high-performance"
    });
    if (!gl) return null;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    return gl;
  }

  function ctx() { return gl; }

  /* -------------------------------------------------------------- shaders */
  function compile(type, src, tag) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      /* Print the offending line with its neighbours. A bare GLSL log with a
         line number and no source is close to useless when the shader was
         assembled from pieces. */
      var log = gl.getShaderInfoLog(s) || "";
      var n = parseInt((log.match(/:(\d+):/) || [])[1], 10);
      var lines = src.split("\n"), near = "";
      if (n) {
        for (var i = Math.max(0, n - 4); i < Math.min(lines.length, n + 3); i++) {
          near += (i + 1 === n ? " >> " : "    ") + (i + 1) + "  " + lines[i] + "\n";
        }
      }
      console.error("[gl] " + tag + " shader failed\n" + log + "\n" + near);
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  /* Attribute slots are fixed across every program on purpose. A VAO bakes in
     the locations it was built with, so the ball mesh can only be drawn by
     both the shading pass and the depth-only shadow pass if aPos means slot 0
     in both — and the linker is free to number them differently otherwise.
     One table here is the difference between sharing meshes and duplicating
     every one of them per program. */
  var ATTR = { aPos: 0, aNrm: 1, aUv: 2, aIns: 3, aIns2: 4, aCol: 5, aSeed: 6 };

  /* Compile, link, then introspect every active uniform and attribute so the
     renderer can write P.u.mvp instead of carrying location handles around. */
  function prog(tag, vsSrc, fsSrc) {
    if (progs[tag]) return progs[tag];
    var vs = compile(gl.VERTEX_SHADER, vsSrc, tag + ".vert");
    var fs = compile(gl.FRAGMENT_SHADER, fsSrc, tag + ".frag");
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    for (var k in ATTR) if (ATTR.hasOwnProperty(k)) gl.bindAttribLocation(p, ATTR[k], k);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("[gl] " + tag + " link failed\n" + gl.getProgramInfoLog(p));
      return null;
    }
    var o = { p: p, tag: tag, u: {}, a: {} };
    var i, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (i = 0; i < n; i++) {
      var ui = gl.getActiveUniform(p, i);
      o.u[ui.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, ui.name);
    }
    n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (i = 0; i < n; i++) {
      var ai = gl.getActiveAttrib(p, i);
      o.a[ai.name] = gl.getAttribLocation(p, ai.name);
    }
    progs[tag] = o;
    return o;
  }

  function use(o) {
    if (lastProg !== o) { gl.useProgram(o.p); lastProg = o; }
    return o;
  }

  /* --------------------------------------------------------------- buffers
     attrs: [{name, data, size, divisor, dynamic}]   idx: Uint16Array|null */
  function mesh(P, attrs, idx, count) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var bufs = {};
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i], loc = ATTR[a.name] != null ? ATTR[a.name] : P.a[a.name];
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, a.data, a.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      bufs[a.name] = b;
      /* An attribute the compiler optimised away links to -1. Skipping it is
         normal, not an error — a debug shader that ignores uv must not explode
         the mesh builder. */
      if (loc == null || loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, 0, 0);
      if (a.divisor) gl.vertexAttribDivisor(loc, a.divisor);
    }
    var ib = null;
    if (idx) {
      ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return {
      vao: vao, bufs: bufs, ib: ib,
      count: idx ? idx.length : (count || 0),
      type: idx ? (idx.BYTES_PER_ELEMENT === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT) : 0
    };
  }

  /* Re-upload one dynamic attribute — per-frame instance data. */
  function update(m, name, data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, m.bufs[name]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  function draw(m, mode, instances) {
    gl.bindVertexArray(m.vao);
    mode = mode == null ? gl.TRIANGLES : mode;
    if (instances != null) {
      if (m.ib) gl.drawElementsInstanced(mode, m.count, m.type, 0, instances);
      else gl.drawArraysInstanced(mode, 0, m.count, instances);
    } else {
      if (m.ib) gl.drawElements(mode, m.count, m.type, 0);
      else gl.drawArrays(mode, 0, m.count);
    }
  }

  /* -------------------------------------------------------------- textures */
  function texFromCanvas(c, opts) {
    opts = opts || {};
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    var wrap = opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (opts.mip === false) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      var af = gl.getExtension("EXT_texture_filter_anisotropic");
      if (af) {
        gl.texParameterf(gl.TEXTURE_2D, af.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(af.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
    }
    return t;
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /* --------------------------------------------------------- render target
     A depth-texture FBO: the shadow map. */
  function depthTarget(size) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0,
                  gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /* hardware PCF: sampler2DShadow returns a filtered 0..1 comparison for the
       price of one tap, which is most of a soft shadow for free */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { console.warn("[gl] depth target incomplete"); return null; }
    return { fb: fb, tex: tex, size: size };
  }

  /* ----------------------------------------------------------------- misc */
  /* "#rrggbb" or "rgb(r,g,b)" -> [r,g,b] in 0..1. render.js learned this the
     hard way (its colour helpers return rgb() and used to accept only hex), so
     this takes both forms from the start. */
  function col3(c, out) {
    out = out || [0, 0, 0];
    if (!c) return out;
    if (c.charAt(0) === "#") {
      var v = parseInt(c.slice(1), 16);
      if (c.length === 4) {
        out[0] = ((v >> 8) & 15) / 15; out[1] = ((v >> 4) & 15) / 15; out[2] = (v & 15) / 15;
      } else {
        out[0] = ((v >> 16) & 255) / 255; out[1] = ((v >> 8) & 255) / 255; out[2] = (v & 255) / 255;
      }
      return out;
    }
    var m = c.match(/-?[\d.]+/g);
    if (m) { out[0] = (+m[0]) / 255; out[1] = (+m[1]) / 255; out[2] = (+m[2]) / 255; }
    return out;
  }

  function err(where) {
    var e = gl.getError();
    if (e) console.error("[gl] error 0x" + e.toString(16) + " at " + where);
    return e;
  }

  return {
    init: init, ctx: ctx, prog: prog, use: use, mesh: mesh, update: update,
    draw: draw, texFromCanvas: texFromCanvas, bindTex: bindTex,
    depthTarget: depthTarget, col3: col3, err: err
  };
})();
