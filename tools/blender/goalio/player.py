"""The player: a 17-bone armature and a mesh built to the locked ratios.

THE RIG IS NOT INVENTED HERE. style.RIG is js/anim.js:18 verbatim, and the bone
NAMES must survive every step — js/skin.gl.js maps by name, and a renamed bone
silently drops that joint to its parent's rotation, which looks like a stiff
player rather than like a broken export. tools/blender/roundtrip.py is the gate
that proves a round trip keeps them.

HOW A JOINT LIST BECOMES BONES
------------------------------
The JS rig is a list of JOINTS, each with an offset from its parent. The
rotation stored at joint X drives the segment BELOW X: `hipL` swings the thigh,
`knL` swings the shin. So bone X runs from joint X to its first child, and the
leaves (head, hands, ankles) get an anatomical stub instead.

Bones are connected only where the head genuinely coincides with the parent's
tail. Forcing use_connect elsewhere would move the joint to close the gap and
quietly rewrite the proportions in §2.2.

WHAT THIS MESH IS FOR
---------------------
Reference, turntables, character sheets and store captures — the close-camera
work §2.5 lists as debt. The game's own players come from the existing glTF in
assets/models/. This is deliberately NOT a replacement for those: it is built
to the same skeleton so it can be posed by the same clips, and it exists so the
proportions in the guide have something to be checked against.
"""

import math

import bpy

from . import compat, materials, prim, scene, style

SEG = 14                    # radial segments on limbs; 12 reads faceted at 90 px
SHORTS_Z = 0.945            # §2.3 the waist break — white shorts cut the figure
SOCK_Z = 0.370              # sock top, just under the knee at 0.40
COLLAR_Z = 1.395


# --------------------------------------------------------------------------
# skeleton
# --------------------------------------------------------------------------

def joint_positions():
    """Cumulative world position of every joint, in metres."""
    pos, parent = {}, {}
    for name, par, off in style.RIG:
        parent[name] = par
        base = pos[par] if par else (0.0, 0.0, 0.0)
        pos[name] = (base[0] + off[0], base[1] + off[1], base[2] + off[2])
    return pos, parent


def _children(parent):
    kids = {}
    for name, par in parent.items():
        kids.setdefault(par, []).append(name)
    return kids


# Anatomical stubs for the five leaf joints, as offsets from the joint.
LEAF_TAIL = {
    "head": (0.0, 0.0, 0.25),       # up to the crown at 1.80
    "haL":  (0.0, 0.0, -0.09),
    "haR":  (0.0, 0.0, -0.09),
    "anL":  (0.0, 0.17, 0.005),     # the foot, forward
    "anR":  (0.0, 0.17, 0.005),
}


def build_armature(collection, name="RIG_Player"):
    pos, parent = joint_positions()
    kids = _children(parent)

    arm = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, arm)
    scene.put(obj, collection)

    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")

    tails = {}
    for jname, _par, _off in style.RIG:
        child = kids.get(jname, [None])[0]
        if child:
            tails[jname] = pos[child]
        else:
            off = LEAF_TAIL.get(jname, (0.0, 0.0, -0.08))
            tails[jname] = tuple(pos[jname][i] + off[i] for i in range(3))

    made = {}
    for jname, _par, _off in style.RIG:
        bone = arm.edit_bones.new(jname)
        bone.head = pos[jname]
        bone.tail = tails[jname]
        # A zero-length bone is deleted on leaving edit mode, without warning
        if (bone.tail - bone.head).length < 1e-4:
            bone.tail = (bone.head.x, bone.head.y, bone.head.z + 0.02)
        made[jname] = bone

    for jname, par, _off in style.RIG:
        if not par:
            continue
        made[jname].parent = made[par]
        gap = sum((pos[jname][i] - tails[par][i]) ** 2 for i in range(3))
        made[jname].use_connect = gap < 1e-8

    bpy.ops.object.mode_set(mode="OBJECT")
    print("  rig: %d bones, %d connected"
          % (len(arm.bones), sum(1 for b in arm.bones if b.use_connect)))
    return obj, pos, tails


# --------------------------------------------------------------------------
# mesh
# --------------------------------------------------------------------------

# (z, half-width x, half-depth y). Tuned so the shoulder silhouette lands at
# 1.72x the hip silhouette once the deltoids are added by the arm tubes -
# which is the ratio §2.2 locks, and the one that reads at 90 px.
TORSO = [
    (0.775, 0.152, 0.101),
    (0.880, 0.160, 0.104),      # pelvis
    (0.985, 0.146, 0.095),      # waist, the taper
    (1.100, 0.160, 0.105),
    (1.220, 0.186, 0.116),
    (1.320, 0.206, 0.120),      # chest
    (1.385, 0.208, 0.114),      # shoulder line
    (1.430, 0.148, 0.099),      # trapezius
]


class _Build:
    """Accumulates geometry, per-vertex bone ownership and material index."""

    def __init__(self):
        self.verts, self.faces = [], []
        self.owner = []                 # bone name per vertex
        self.face_mat = []              # material slot per face
        self.trim = []                  # kit trim mask per vertex

    def add(self, part, bone, mat_index, trim=0.0):
        base = len(self.verts)
        pverts, pfaces = part
        self.verts.extend(pverts)
        self.owner.extend([bone] * len(pverts))
        self.trim.extend([trim] * len(pverts))
        for f in pfaces:
            self.faces.append(tuple(i + base for i in f))
            self.face_mat.append(mat_index)
        return base


# material slots, in order
SLOT_KIT, SLOT_SHORTS, SLOT_SOCK, SLOT_SKIN, SLOT_HAIR, SLOT_BOOT = range(6)


def _slot_for_z(z):
    """Which garment a torso/leg ring at height z belongs to. This single
    function is what puts the waist break at 0.88 m and the sock top under the
    knee, so both are one edit away rather than scattered through the build."""
    if z >= SHORTS_Z:
        return SLOT_KIT
    if z >= 0.62:
        return SLOT_SHORTS
    if z >= SOCK_Z:
        return SLOT_SKIN
    return SLOT_SOCK


def _torso(build):
    rings = [prim.ring((0, 0, z), rx, ry, SEG) for z, rx, ry in TORSO]
    verts, faces = prim.loft(rings, SEG, cap_start=True, cap_end=False)
    base = len(build.verts)
    build.verts.extend(verts)
    for v in verts:
        z = v[2]
        build.owner.append("pelvis" if z < 1.02 else ("spine" if z < 1.24 else "chest"))
        build.trim.append(1.0 if z > COLLAR_Z else 0.0)
    for f in faces:
        build.faces.append(tuple(i + base for i in f))
        cz = sum(verts[i][2] for i in f) / len(f)
        build.face_mat.append(_slot_for_z(cz))


def _limb(build, p0, p1, r0, r1, bone, slot, trim=0.0):
    build.add(prim.tube(p0, p1, r0, r1, SEG), bone, slot, trim)


def _arm(build, pos, side):
    f = style.FIGURE
    sh, el, ha = ("sh%s" % side, "el%s" % side, "ha%s" % side)
    # deltoid cap, then upper arm, forearm, fist
    build.add(prim.sphere(pos[sh], f["arm_r"] * 1.28, SEG, 8), sh, SLOT_KIT)
    _limb(build, pos[sh], pos[el], f["arm_r"] * 1.05, f["fore_r"] * 1.12, sh, SLOT_KIT)
    # the sleeve ends about a third of the way down the upper arm; below that
    # is skin. §1.4: the trim is a band at the cuff, nothing more.
    mid = tuple(pos[sh][i] + (pos[el][i] - pos[sh][i]) * 0.42 for i in range(3))
    _limb(build, mid, pos[el], f["fore_r"] * 1.15, f["fore_r"] * 1.02, sh, SLOT_SKIN)
    _limb(build, pos[el], pos[ha], f["fore_r"] * 1.02, f["hand_r"] * 0.92, el, SLOT_SKIN)
    build.add(prim.sphere(pos[ha], f["hand_r"], 12, 8, (1.0, 0.86, 1.15)), ha, SLOT_SKIN)


def _leg(build, pos, side):
    f = style.FIGURE
    hip, kn, an = ("hip%s" % side, "kn%s" % side, "an%s" % side)
    # thigh: shorts down to 0.62, skin below
    hem = tuple(pos[hip][i] + (pos[kn][i] - pos[hip][i]) * 0.46 for i in range(3))
    _limb(build, pos[hip], hem, f["thigh_r"] * 1.22, f["thigh_r"] * 1.02, hip, SLOT_SHORTS)
    _limb(build, hem, pos[kn], f["thigh_r"] * 0.99, f["shin_r"] * 1.24, hip, SLOT_SKIN)
    build.add(prim.sphere(pos[kn], f["shin_r"] * 1.20, SEG, 8), kn, SLOT_SKIN)
    # shin: skin to the sock top, sock below
    sock = tuple(pos[kn][i] + (pos[an][i] - pos[kn][i]) * 0.14 for i in range(3))
    _limb(build, pos[kn], sock, f["shin_r"] * 1.18, f["shin_r"] * 1.08, kn, SLOT_SKIN)
    _limb(build, sock, pos[an], f["shin_r"] * 1.10, f["shin_r"] * 0.86, kn, SLOT_SOCK)
    _boot(build, pos[an], an)


SOLE_H = 0.022          # sole slab thickness


def _boot(build, ankle, bone):
    """§2.2 — a tapered capsule, heel to toe, with a sole inset.

    THE SOLE SITS ON z = 0 EXACTLY. The rig puts the ankle joint at 0.00
    (js/anim.js), which means the ankle IS the ground contact and the whole
    boot has to be built above it. Building the boot centred on the ankle the
    obvious way pushes the heel 4 cm through the pitch — which does not look
    like a bug in a turntable, it looks like the player is standing in a
    divot, and it breaks the 'origin at base' convention every other asset in
    tools/blender follows.
    """
    f = style.FIGURE
    r_heel = f["boot_r0"] * 0.78
    heel = (ankle[0], ankle[1] - 0.030, ankle[2] + SOLE_H + r_heel)
    toe = (ankle[0], ankle[1] + 0.140, ankle[2] + SOLE_H + r_heel * 0.62)
    build.add(prim.tube(heel, toe, r_heel, f["boot_r1"] * 0.40, 12), bone, SLOT_BOOT)
    build.add(prim.sphere(heel, r_heel, 12, 8, (1.0, 1.0, 0.88)), bone, SLOT_BOOT)
    build.add(prim.box((ankle[0], ankle[1] + 0.050, ankle[2] + SOLE_H * 0.5),
                       (0.086, 0.230, SOLE_H)), bone, SLOT_BOOT)


# The tallest hairstyle's outer extent, as a multiple of head_r. The head is
# placed so THAT lands on the locked crown height, rather than placing the head
# by eye and letting the hair decide how tall the player is. §2.2 locks 7.2
# heads; this is what makes the locked number the cause and the mesh the effect.
HAIR_MAX = 1.13 * 1.12


def _head_centre_z():
    return style.FIGURE["crown"] - style.FIGURE["head_r"] * HAIR_MAX


def _head(build, pos, hair_style=0):
    f = style.FIGURE
    centre = (0.0, 0.006, _head_centre_z())
    # neck
    _limb(build, pos["neck"], (0, 0, pos["head"][2] + 0.02),
          f["neck_r"] * 1.12, f["neck_r"], "neck", SLOT_SKIN)
    # skull: squashed sideways, deeper front-to-back, taller than wide
    build.add(prim.sphere(centre, f["head_r"], 20, 14, (0.94, 1.06, 1.14)),
              "head", SLOT_SKIN)
    # jaw, so the silhouette is not a ball
    build.add(prim.sphere((0.0, 0.028, centre[2] - f["head_r"] * 0.52),
                          f["head_r"] * 0.70, 16, 10, (0.94, 1.02, 0.80)),
              "head", SLOT_SKIN)
    _hair(build, centre, f["head_r"], hair_style)


def _hair(build, centre, r, style_index):
    """§2.3 — four styles, distinguished by SILHOUETTE at 12 px, never by
    strand detail. The only thing that varies is how much of the skull the cap
    covers and how far it stands off it."""
    cut, lift, swell = [
        (0.30, 1.030, 1.00),      # 0 short fade
        (0.16, 1.075, 1.06),      # 1 textured crop
        (0.06, 1.130, 1.14),      # 2 curls
        (0.20, 1.060, 1.02),      # 3 tied back
    ][style_index % 4]

    verts, faces = prim.sphere(centre, r * lift, 20, 14,
                               (0.96 * swell, 1.04 * swell, 1.12))
    keep_v, remap, kept = [], {}, 0
    zcut = centre[2] + r * cut - r * 0.55
    for i, v in enumerate(verts):
        if v[2] >= zcut and v[1] < centre[1] + r * 0.72:
            remap[i] = kept
            keep_v.append(v)
            kept += 1
    keep_f = [tuple(remap[i] for i in f) for f in faces if all(i in remap for i in f)]
    if keep_f:
        build.add((keep_v, keep_f), "head", SLOT_HAIR)

    if style_index == 3:        # the tie-back needs a volume behind the skull
        build.add(prim.sphere((0.0, centre[1] - r * 0.92, centre[2] - r * 0.30),
                              r * 0.44, 12, 8, (0.8, 1.25, 0.85)),
                  "head", SLOT_HAIR)


# --------------------------------------------------------------------------
# skinning
# --------------------------------------------------------------------------

def _skin_weights(obj, arm_obj, verts, owner, pos, tails):
    """Distance-weighted skinning, restricted to each vertex's own bone plus
    its immediate family.

    A global nearest-bone search is what most auto-skinners do and it bleeds
    badly here: the hand sits 0.87 m up, level with the pelvis, so an
    unrestricted search weights fingers to the hip. Restricting the candidate
    set to {owner, parent, children} makes that impossible by construction and
    still gives a smooth joint, because the only bones competing at a joint are
    exactly the ones that meet there.
    """
    _, parent = joint_positions()
    kids = _children(parent)

    groups = {}
    for name, _p, _o in style.RIG:
        groups[name] = obj.vertex_groups.new(name=name)

    for i, v in enumerate(verts):
        own = owner[i]
        family = [own]
        if parent.get(own):
            family.append(parent[own])
        family.extend(kids.get(own, []))

        weights = []
        for bone in family:
            d = prim.dist_point_segment(v, pos[bone], tails[bone])
            weights.append((bone, 1.0 / (d + 0.012) ** 3))
        total = sum(w for _b, w in weights) or 1.0
        for bone, w in weights:
            share = w / total
            if share > 0.004:
                groups[bone].add([i], share, "REPLACE")

    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm_obj
    obj.parent = arm_obj


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

def build_player(collection, role="home", skin_index=1, hair_style=0,
                 boot_flash=0, name=None, with_rig=True):
    """One complete player: armature + skinned mesh, origin on the ground."""
    name = name or "CHR_%s" % role.capitalize()
    arm_obj, pos, tails = (None, None, None)
    if with_rig:
        arm_obj, pos, tails = build_armature(collection, "RIG_%s" % name)
    else:
        pos, _ = joint_positions()
        tails = {k: v for k, v in pos.items()}

    build = _Build()
    _torso(build)
    _arm(build, pos, "L")
    _arm(build, pos, "R")
    _leg(build, pos, "L")
    _leg(build, pos, "R")
    _head(build, pos, hair_style)

    me = bpy.data.meshes.new(name)
    me.from_pydata(build.verts, [], build.faces)
    me.validate(verbose=False)
    me.update()

    obj = bpy.data.objects.new(name, me)
    scene.put(obj, collection)

    for mat in (materials.kit(role), materials.shorts(role), materials.socks(role),
                materials.skin(skin_index), materials.hair(),
                materials.boot(boot_flash)):
        me.materials.append(mat)
    for poly, slot in zip(me.polygons, build.face_mat):
        poly.material_index = slot

    # §1.4 the trim mask the kit material reads. FLOAT on POINT domain, which
    # is what the Attribute node's Fac output expects.
    attr = me.attributes.new(name="trim", type="FLOAT", domain="POINT")
    for i, value in enumerate(build.trim):
        attr.data[i].value = value

    compat.shade_smooth(obj, 42.0)

    if with_rig:
        _skin_weights(obj, arm_obj, build.verts, build.owner, pos, tails)

    tris = sum(max(0, len(p.vertices) - 2) for p in me.polygons)
    check = verify_ratios(obj, name, len(me.vertices), tris)
    return obj, arm_obj


def verify_ratios(obj, name, nverts, tris, tol=0.02):
    """docs/BLENDER.md: print your dimensions. §2.2: the ratios are identity.

    Measuring the built mesh against the locked numbers is the only thing that
    catches a figure that has crept — and it does creep, because every limb
    radius nudges the silhouette. Reported, not raised: a 1.83 m player is
    still a usable reference, it just is not the one in the guide.
    """
    zs = [v.co.z for v in obj.data.vertices]
    lo, hi = min(zs), max(zs)
    heads = hi / style.FIGURE["head_unit"]
    want = style.FIGURE["crown"]
    ok = abs(hi - want) <= tol and abs(lo) <= 0.004
    print("  %-18s %5d verts %5d tris  crown %.3f m (%.2f heads)  "
          "sole %+.3f  %s"
          % (name, nverts, tris, hi, heads, lo,
             "OK" if ok else "*** off locked 7.20 heads / 1.800 m ***"))
    return ok


def build_squad(collection, count=4):
    """§2.4 — identity derived from the squad number, deterministically. Same
    number, same player, every run. No randomness anywhere in this package."""
    made = []
    roles = ["home", "home", "away", "keeper"]
    for n in range(count):
        squad_no = n + 1
        obj, arm = build_player(
            collection,
            role=roles[n % len(roles)],
            skin_index=squad_no % len(style.SKIN),
            hair_style=squad_no % 4,
            boot_flash=squad_no % len(style.BOOT_FLASH),
            name="CHR_Player_%02d" % squad_no,
        )
        obj_root = arm or obj
        obj_root.location = ((n - (count - 1) / 2.0) * 1.15, 0.0, 0.0)
        made.append(obj)
    return made


def apply_apose(arm_obj, degrees=12.0):
    """A-pose for the orthographic sheets in §8.2. The rig's rest pose is arms
    straight down, which hides the armpit and the sleeve hem — the two things a
    modelling reference most needs to show."""
    if not arm_obj:
        return
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="POSE")
    rad = math.radians(degrees)
    for side, sign in (("L", 1.0), ("R", -1.0)):
        bone = arm_obj.pose.bones.get("sh%s" % side)
        if bone:
            bone.rotation_mode = "XYZ"
            bone.rotation_euler[1] = sign * rad
    bpy.ops.object.mode_set(mode="OBJECT")
