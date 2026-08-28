/* goal.io — glTF 2.0 binary (.glb) loader.

   Pure data: no WebGL calls, no game knowledge. It turns a .glb into typed
   arrays and ImageBitmaps and stops there. js/skin.gl.js turns that into
   buffers and textures.

   THIS IS NOT A GENERAL glTF IMPLEMENTATION, ON PURPOSE.

   It supports exactly what the four models in assets/models/ actually use,
   which was determined by reading the files rather than by reading the spec:

     - single buffer, embedded in the BIN chunk (no external .bin, no data:)
     - tightly packed bufferViews (byteStride is handled, but none are strided)
     - accessors: SCALAR/VEC2/VEC3/VEC4 float, VEC4 ushort, SCALAR ushort, MAT4
     - no sparse accessors
     - no extensions, required or otherwise
     - one skin, joints as a flat list with inverse bind matrices
     - bind pose is translation-only: no joint has a rotation or a scale
     - PNG images in bufferViews, one sampler, REPEAT/LINEAR

   Anything outside that throws with a message naming what it found, rather
   than half-loading and producing a mesh that is subtly wrong. A model that
   fails to load leaves the primitive players running, which is a working game.

   Usage:
     GLTF.load("assets/models/Forward.glb").then(function (m) { ... });
*/
"use strict";

var GLTF = (function () {

  var MAGIC = 0x46546C67;      // "glTF"
  var CHUNK_JSON = 0x4E4F534A;
  var CHUNK_BIN = 0x004E4942;

  var COMP = {
    5120: { array: Int8Array,    size: 1 },
    5121: { array: Uint8Array,   size: 1 },
    5122: { array: Int16Array,   size: 2 },
    5123: { array: Uint16Array,  size: 2 },
    5125: { array: Uint32Array,  size: 4 },
    5126: { array: Float32Array, size: 4 }
  };
  var NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  function fail(msg) { throw new Error("[gltf] " + msg); }

  /* ------------------------------------------------------------ container */
  function parseGLB(buf) {
    if (buf.byteLength < 20) fail("file is too short to be a glb");
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) fail("not a glb (bad magic)");
    var ver = dv.getUint32(4, true);
    if (ver !== 2) fail("glTF version " + ver + ", only 2 is supported");

    var total = dv.getUint32(8, true);
    var off = 12, json = null, bin = null;
    while (off + 8 <= Math.min(total, buf.byteLength)) {
      var len = dv.getUint32(off, true);
      var type = dv.getUint32(off + 4, true);
      off += 8;
      if (type === CHUNK_JSON) {
        json = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(buf, off, len)));
      } else if (type === CHUNK_BIN) {
        /* keep the offset rather than copying — these are ~460 KB each and
           every accessor is a view into this same range */
        bin = { buf: buf, off: off, len: len };
      }
      off += len + ((4 - (len % 4)) % 4);   // chunks are 4-byte aligned
    }
    if (!json) fail("no JSON chunk");
    if (!bin) fail("no BIN chunk (external buffers are not supported)");
    return { json: json, bin: bin };
  }

  /* ------------------------------------------------------------ accessors */
  function readAccessor(g, index) {
    var a = g.json.accessors[index];
    if (a.sparse) fail("accessor " + index + " is sparse, which is not supported");
    var c = COMP[a.componentType];
    if (!c) fail("accessor " + index + " has component type " + a.componentType);
    var n = NUM[a.type];
    if (!n) fail("accessor " + index + " has type " + a.type);

    if (a.bufferView == null) {
      /* legal glTF: means "all zeroes". Nothing here uses it, but returning
         zeroes is cheaper than a special case downstream. */
      return new c.array(a.count * n);
    }
    var bv = g.json.bufferViews[a.bufferView];
    var base = g.bin.off + (bv.byteOffset || 0) + (a.byteOffset || 0);
    var stride = bv.byteStride || 0;

    if (!stride || stride === n * c.size) {
      /* tightly packed: one view, no copy loop */
      return new c.array(g.bin.buf, base, a.count * n);
    }
    /* strided: de-interleave. None of the current models hit this path. */
    var out = new c.array(a.count * n);
    var src = new DataView(g.bin.buf);
    var get = {
      5120: "getInt8", 5121: "getUint8", 5122: "getInt16",
      5123: "getUint16", 5125: "getUint32", 5126: "getFloat32"
    }[a.componentType];
    for (var i = 0; i < a.count; i++) {
      for (var k = 0; k < n; k++) {
        out[i * n + k] = src[get](base + i * stride + k * c.size, true);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- images */
  function readImage(g, index) {
    var img = g.json.images[index];
    if (img.uri) fail("image " + index + " is a URI; only bufferView images are supported");
    var bv = g.json.bufferViews[img.bufferView];
    var bytes = new Uint8Array(g.bin.buf, g.bin.off + (bv.byteOffset || 0), bv.byteLength);
    var blob = new Blob([bytes], { type: img.mimeType || "image/png" });
    if (typeof createImageBitmap === "function") {
      /* premultiply none: the PBR shader wants straight alpha, and these are
         opaque anyway. flipY false — glTF UVs already have origin top-left. */
      return createImageBitmap(blob, { premultiplyAlpha: "none", imageOrientation: "none" });
    }
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); res(im); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error("image decode failed")); };
      im.src = url;
    });
  }

  /* ---------------------------------------------------------------- build */
  function build(g) {
    var J = g.json;

    /* --- skeleton. Bind pose is translation-only in these files; anything
       else would mean the joint frames no longer match the model axes, which
       is the assumption the whole animation mapping rests on, so it is
       checked rather than silently accepted. --- */
    var skin = (J.skins || [])[0];
    if (!skin) fail("no skin — this loader is only for skinned characters");
    var jointNodes = skin.joints;
    var parentOf = {};
    (J.nodes || []).forEach(function (n, i) {
      (n.children || []).forEach(function (c) { parentOf[c] = i; });
    });

    var jointIndexOf = {};
    jointNodes.forEach(function (nodeIdx, j) { jointIndexOf[nodeIdx] = j; });

    var ibm = skin.inverseBindMatrices != null
      ? readAccessor(g, skin.inverseBindMatrices) : null;

    var joints = jointNodes.map(function (nodeIdx, j) {
      var n = J.nodes[nodeIdx];
      if (n.rotation && n.rotation.some(function (v, i) { return v !== (i === 3 ? 1 : 0); })) {
        fail("joint " + (n.name || nodeIdx) + " has a bind rotation; " +
             "this loader assumes an axis-aligned bind pose");
      }
      if (n.scale && n.scale.some(function (v) { return v !== 1; })) {
        fail("joint " + (n.name || nodeIdx) + " has a bind scale");
      }
      var p = parentOf[nodeIdx];
      return {
        name: n.name || ("joint" + j),
        node: nodeIdx,
        parent: (p != null && jointIndexOf[p] != null) ? jointIndexOf[p] : -1,
        t: n.translation ? n.translation.slice() : [0, 0, 0],
        ibm: ibm ? Array.prototype.slice.call(ibm, j * 16, j * 16 + 16) : null
      };
    });

    /* Joints must appear before their children so one forward pass can solve
       the hierarchy. glTF does not guarantee it; these files happen to comply,
       and a violation would produce a skeleton that looks almost right. */
    for (var ji = 0; ji < joints.length; ji++) {
      if (joints[ji].parent > ji) {
        fail("joint " + joints[ji].name + " precedes its parent; " +
             "the joint list is not topologically ordered");
      }
    }

    /* --- meshes. Each mesh is one LOD; each primitive is one material. --- */
    var meshes = (J.meshes || []).map(function (m, mi) {
      return {
        name: m.name || ("mesh" + mi),
        prims: m.primitives.map(function (p) {
          var at = p.attributes;
          if (at.POSITION == null) fail("primitive without POSITION");
          if (p.mode != null && p.mode !== 4) fail("primitive mode " + p.mode + ", only triangles");
          return {
            material: p.material,
            pos: readAccessor(g, at.POSITION),
            nrm: at.NORMAL != null ? readAccessor(g, at.NORMAL) : null,
            uv: at.TEXCOORD_0 != null ? readAccessor(g, at.TEXCOORD_0) : null,
            joints: at.JOINTS_0 != null ? readAccessor(g, at.JOINTS_0) : null,
            weights: at.WEIGHTS_0 != null ? readAccessor(g, at.WEIGHTS_0) : null,
            idx: p.indices != null ? readAccessor(g, p.indices) : null,
            count: J.accessors[at.POSITION].count
          };
        })
      };
    });

    /* --- materials --- */
    var materials = (J.materials || []).map(function (m) {
      var pbr = m.pbrMetallicRoughness || {};
      function texSource(t) {
        if (!t) return -1;
        var tex = J.textures[t.index];
        return tex && tex.source != null ? tex.source : -1;
      }
      return {
        name: m.name || "material",
        baseColor: pbr.baseColorFactor || [1, 1, 1, 1],
        metallic: pbr.metallicFactor == null ? 1 : pbr.metallicFactor,
        roughness: pbr.roughnessFactor == null ? 1 : pbr.roughnessFactor,
        baseTex: texSource(pbr.baseColorTexture),
        mrTex: texSource(pbr.metallicRoughnessTexture),
        doubleSided: !!m.doubleSided,
        alphaMode: m.alphaMode || "OPAQUE"
      };
    });

    return {
      joints: joints,
      meshes: meshes,
      materials: materials,
      imageCount: (J.images || []).length
    };
  }

  /* ----------------------------------------------------------------- load */
  function load(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("[gltf] " + url + " -> HTTP " + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var g = parseGLB(buf);
      var model = build(g);
      model.url = url;
      /* images last: decoding is async and everything else is synchronous, so
         a structural error is reported before the browser spends time on PNGs */
      var jobs = [];
      for (var i = 0; i < model.imageCount; i++) jobs.push(readImage(g, i));
      return Promise.all(jobs).then(function (imgs) {
        model.images = imgs;
        return model;
      });
    });
  }

  return { load: load, parseGLB: parseGLB, build: build };
})();
