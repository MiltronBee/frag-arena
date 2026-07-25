"""Saint Seiya-style "Cloth" armor pieces for the Degen Tournament soldier.

Builds GLB props (public/assets/props/) that CharacterModel mounts on skeleton bones,
exactly like the helmet mounts on the Head bone:
  armor_chest.glb    layered breastplate: pecs + belt + abs lames, crest, gem -> spine_03
  armor_pauldron.glb layered 3-plate shoulder + swept fin          -> clavicle_l / _r
  armor_elbow.glb    faceted cap + ridge fin                       -> lowerarm_l / _r
  armor_knee.glb     faceted cap + ridge fin (bigger)              -> calf_l / _r
  armor_boot.glb     winged greave-boot: toe cap, instep lames,
                     heel shell, flared ankle cuff + wing fins     -> foot_l / _r

ART DIRECTION (2026-07-25 revision): LESS ROUND, MORE ANGULAR. The first draft ran a
SUBSURF over everything, which turned every plate into a soft blob. The pieces below are
built from faceted lofts instead — straight swept edges between explicit stations, flat
shading, and a small ANGLE-limited bevel that only chamfers the silhouette creases (not
every quad edge, which is what makes a bevel modifier expensive). Layered overlapping
lames with a dark TRIM plate peeking out behind each one supply the recessed trim lines,
a raised centre crest supplies the spine, and a cut violet gem is the focal accent.
Faceted lofts are also far CHEAPER than the subsurfed domes they replace.

Every piece is authored at ~real human scale (metres) as a shell whose "dome" runs along
its own local +Y with the base at y=0 -- assetManifest.js's mount rotations are exact axis
mappings derived from that convention, so DO NOT change it.

  blender -b -P scripts/build-armor.blender.py
"""
import bpy, bmesh, math, os
from mathutils import Vector

OUT = os.path.expanduser('~/unreal/public/assets/props')
os.makedirs(OUT, exist_ok=True)

GOLD = (0.82, 0.63, 0.24, 1.0)     # bronze-gold cloth
TRIM = (0.30, 0.22, 0.09, 1.0)     # dark recess trim
GEM = (0.60, 0.27, 1.0, 1.0)       # Solana violet #9945FF


def _mat(name, rgba, metal=1.0, rough=0.28, emit=None, emit_str=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = rgba
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit is not None:
        b.inputs['Emission Color'].default_value = emit
        if 'Emission Strength' in b.inputs:
            b.inputs['Emission Strength'].default_value = emit_str
    return m


def _new(name):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob, bmesh.new()


def _finish(ob, bm, mat, bevel=0.006, seg=2):
    """LEGACY soft finish (bevel + subsurf). Only build_pauldron still uses it; that
    piece is owned by scripts/build-armor-pauldron.blender.py now -- leave both alone."""
    bm.to_mesh(ob.data); bm.free()
    ob.data.materials.append(mat)
    md = ob.modifiers.new('bev', 'BEVEL'); md.width = bevel; md.segments = seg
    md = ob.modifiers.new('sub', 'SUBSURF'); md.levels = 1; md.render_levels = 1
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def _to_gltf_frame(bm):
    """Rotate authored coords into the frame the EXPORTER will turn into the piece frame.

    export_scene.gltf(export_yup=True) maps Blender (x, y, z) -> glTF (x, z, -y). The
    manifest's mount rotations are exact axis mappings against the glTF/Babylon frame
    ("the dome runs along the piece's +Y"), so a piece authored with its dome along
    Blender +Y would arrive in Babylon domed along -Z -- a silent 90-degree error that
    puts the plate through the body. The legacy dome() helper dodged this by building
    along Blender +Z; everything below is authored in the *final* piece frame instead and
    pre-rotated here, so the code reads in the same axes the manifest talks about.
      Blender (px, -pz, py) --export_yup--> glTF (px, py, pz).
    """
    for v in bm.verts:
        x, y, z = v.co.x, v.co.y, v.co.z
        v.co = Vector((x, -z, y))


def _finish_hard(ob, bm, mat, bevel=0.0035, angle=38.0):
    """Angular finish: recalc normals, flat shade, and chamfer ONLY the creases sharper
    than `angle`. An unlimited bevel would chamfer every quad edge of the loft and roughly
    triple the triangle count for no visual gain -- the loft's own facets are the shape."""
    _to_gltf_frame(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data); bm.free()
    ob.data.materials.append(mat)
    if bevel:
        md = ob.modifiers.new('bev', 'BEVEL')
        md.width = bevel; md.segments = 1
        md.limit_method = 'ANGLE'; md.angle_limit = math.radians(angle)
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    for p in ob.data.polygons:
        p.use_smooth = False


# --------------------------------------------------------------------------
# angular primitives
# --------------------------------------------------------------------------
def _face(bm, verts):
    try:
        bm.faces.new(verts)
    except ValueError:
        pass


def loft(bm, rings, cap_top=True, cap_bottom=True):
    """Stitch a list of equal-length vertex rings into a faceted tube. Capping both ends
    makes every shell a closed volume, so recalc_face_normals can never get the winding
    ambiguous (an open shell can end up inside-out and vanish under backface culling)."""
    layers = [[bm.verts.new(p) for p in r] for r in rings]
    for a, b in zip(layers, layers[1:]):
        n = len(a)
        for i in range(n):
            j = (i + 1) % n
            _face(bm, [a[i], b[i], b[j], a[j]])
    if cap_top:
        _face(bm, layers[-1])
    if cap_bottom:
        _face(bm, list(reversed(layers[0])))


def plate(bm, outline, stations):
    """A domed armour LAME: a flat outline polygon (x, z) swept along the piece's +Y
    (the dome axis) while shrinking, so the widest ring is the one against the body and
    the shell hugs a convex torso/limb without any per-vertex fitting.
    stations: (y, scale, ox, oz) — outline scaled about (0,0) then offset."""
    rings = []
    for (y, s, ox, oz) in stations:
        rings.append([Vector((ox + x * s, y, oz + z * s)) for (x, z) in outline])
    loft(bm, rings)


def sweep(bm, sections):
    """Loft explicit cross-sections (already full 3D rings) — used where the piece runs
    along +Z (boot lames along the foot) instead of doming along +Y."""
    loft(bm, sections)


def thick_arc(z, hw, ytop, yside, thick, shoulder=0.70, drop=0.007):
    """One boot-shell cross-section at station z: a 5-point faceted arc over the top of
    the foot, closed by an inner arc a CONSTANT `thick` inside it. Returns a 10-vertex ring.

    The offset has to run along each vertex's own normal, not shrink toward a point: a
    shrink pulls the flanks inward as well as up, and at the widest stations that put the
    inner wall inside the foot flesh, which is what let the bare foot poke through the
    first pass. hw is the OUTER half width, so clearance for the foot is hw - thick."""
    outer = [
        (-hw, yside),
        (-shoulder * hw, ytop - drop),
        (0.0, ytop),
        (shoulder * hw, ytop - drop),
        (hw, yside),
    ]
    n = len(outer)
    inner = []
    for i, (x, y) in enumerate(outer):
        a = outer[max(i - 1, 0)]
        b = outer[min(i + 1, n - 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        inner.append((x + ty / L * thick, y - tx / L * thick))   # tangent rotated into the shell
    ring = [Vector((x, y, z)) for (x, y) in outer]
    ring += [Vector((x, y, z)) for (x, y) in reversed(inner)]
    return ring


def gem_cut(bm, center, r, depth, n=6, phase=0.0):
    """A cut gem: girdle ring, a smaller table ring, a flat table, and a culet point.
    Faceted on purpose — a dome here would be the one round thing left on the set."""
    c = Vector(center)
    girdle = [c + Vector((r * math.cos(phase + 2 * math.pi * i / n), 0.0,
                          r * math.sin(phase + 2 * math.pi * i / n))) for i in range(n)]
    table = [c + Vector((r * 0.52 * math.cos(phase + 2 * math.pi * i / n), depth * 0.9,
                         r * 0.52 * math.sin(phase + 2 * math.pi * i / n))) for i in range(n)]
    culet = c + Vector((0, -depth * 0.55, 0))
    gv = [bm.verts.new(p) for p in girdle]
    tv = [bm.verts.new(p) for p in table]
    cv = bm.verts.new(culet)
    for i in range(n):
        j = (i + 1) % n
        _face(bm, [gv[i], tv[i], tv[j], gv[j]])
        _face(bm, [gv[j], cv, gv[i]])
    _face(bm, tv)


def mirror_outline(outline):
    return [(-x, z) for (x, z) in reversed(outline)]


# --------------------------------------------------------------------------
# legacy soft primitives — kept ONLY for build_pauldron (owned elsewhere)
# --------------------------------------------------------------------------
def dome(bm, center, radius, flat, cut_z=0.0, mat_offset=Vector((0, 0, 0))):
    """A flattened hemisphere shell (an armour plate)."""
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=2, radius=radius)
    for v in tmp.verts:
        v.co.z *= flat
    # keep the top cap (z above cut)
    bmesh.ops.delete(tmp, geom=[v for v in tmp.verts if v.co.z < cut_z], context='VERTS')
    for v in tmp.verts:
        v.co += Vector(center)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    verts = [bm.verts.new(v.co) for v in tmp.verts]
    for f in tmp.faces:
        try: bm.faces.new([verts[v.index] for v in f.verts])
        except ValueError: pass
    tmp.free()


def box(bm, center, size, rot=None):
    m = bmesh.new()
    bmesh.ops.create_cube(m, size=1.0)
    for v in m.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    if rot:
        import mathutils
        R = mathutils.Euler(rot, 'XYZ').to_matrix()
        for v in m.verts:
            v.co = R @ v.co
    for v in m.verts:
        v.co += Vector(center)
    verts = [bm.verts.new(v.co) for v in m.verts]
    bmesh.ops.recalc_face_normals(m, faces=m.faces)
    for f in m.faces:
        try: bm.faces.new([verts[v.index] for v in f.verts])
        except ValueError: pass
    m.free()


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB',
                              export_apply=True, export_yup=True)
    tris = sum(len(p.vertices) - 2 for o in bpy.context.selected_objects
               for p in o.data.polygons)
    print('wrote %s  (%d tris)' % (path, tris))
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


gold = _mat('ArmorGold', GOLD)
trim = _mat('ArmorTrim', TRIM, rough=0.5)
# emit_str 6.0 blew the small faceted gems out to flat white in-engine (the scene
# adds its own glow); 2.2 keeps the Solana violet readable while still reading as lit.
gem = _mat('ArmorGem', GEM, metal=0.0, rough=0.1, emit=GEM, emit_str=2.2)


def build_pauldron():
    # NOTE: this piece is now owned by scripts/build-armor-pauldron.blender.py and is
    # NOT built from here (see the bottom of the file). Body left byte-identical.
    ob, bm = _new('pauldron')
    dome(bm, (0, 0, 0.00), 0.150, 0.78)                 # base plate
    dome(bm, (0, -0.020, 0.045), 0.112, 0.82)           # mid plate (shifted forward+up)
    dome(bm, (0, -0.038, 0.082), 0.076, 0.85)           # top plate
    _finish(ob, bm, gold, bevel=0.004)
    # a swept fin rising off the top-back
    fin, fbm = _new('paul_fin')
    box(fbm, (0, 0.06, 0.10), (0.02, 0.05, 0.11), rot=(math.radians(28), 0, 0))
    _finish(fin, fbm, gold, bevel=0.006)
    # a violet gem set in the top plate
    g, gbm = _new('paul_gem')
    dome(gbm, (0, -0.038, 0.100), 0.026, 1.0)
    _finish(g, gbm, gem, bevel=0.002)
    export([ob, fin, g], os.path.join(OUT, 'armor_pauldron.glb'))


# --------------------------------------------------------------------------
# CHEST — spine_03. Piece frame: +X lateral, +Y anterior (the dome axis), +Z up.
# Measured torso in spine_03 bind space (scratch/probe-bonelocal.mjs):
#   half-width 0.178..0.203, front surface z=+0.126 at the sternum, neck at y=0.215.
# Mount (assetManifest): scale 0.78, pos (0, 0.045, 0.072), rot (-pi/2, pi, 0) — the
# rotation maps piece +Y onto bone +Z (anterior) and piece +Z onto bone +Y (up), so
# piece x/z below are half-width/height in rig metres and y is how proud it stands.
# --------------------------------------------------------------------------
PEC = [                     # right-hand pectoral shield (x>0), mirrored for the left
    (0.030, 0.136),         # inner top, beside the crest
    (0.094, 0.168),         # top
    (0.172, 0.150),         # top outer
    (0.224, 0.092),         # outer shoulder corner
    (0.202, 0.010),         # outer bottom
    (0.116, -0.030),        # bottom
    (0.042, -0.018),        # inner bottom
    (0.030, 0.044),
]
PEC_ST = [(-0.012, 0.94, 0.001, 0.002), (0.0, 1.0, 0, 0),
          (0.068, 0.95, -0.002, 0.001), (0.116, 0.83, -0.006, 0.004),
          (0.146, 0.50, -0.016, 0.012)]
# The trim plate has to sit at the SAME depth as the gold lame and simply be BIGGER.
# Parking it further back (the obvious "behind the plate" reading) buries its rim inside
# the torso, because both shells dome forward — the first pass showed zero trim anywhere.
PEC_TRIM_ST = [(-0.012, 1.09, 0, 0), (0.012, 1.09, 0, 0),
               (0.064, 1.00, -0.002, 0.001), (0.094, 0.80, -0.006, 0.004)]

BELT = [                    # the mid lame, a chevron across the ribs
    (-0.200, -0.030), (-0.172, 0.000), (-0.066, -0.008), (0.0, -0.036),
    (0.066, -0.008), (0.172, 0.000), (0.200, -0.030),
    (0.158, -0.084), (0.0, -0.114), (-0.158, -0.084),
]
BELT_ST = [(-0.010, 0.95, 0, 0), (0.0, 1.0, 0, 0), (0.066, 0.94, 0, -0.002),
           (0.104, 0.70, 0, -0.008)]

ABS = [                     # the lower lame, tapering to a point at the belly
    (-0.144, -0.082), (-0.066, -0.100), (0.0, -0.086), (0.066, -0.100), (0.144, -0.082),
    (0.110, -0.146), (0.0, -0.202), (-0.110, -0.146),
]
ABS_ST = [(-0.010, 0.95, 0, 0), (0.0, 1.0, 0, 0), (0.056, 0.93, 0, -0.002),
          (0.090, 0.66, 0, -0.008)]

COLLAR = [                  # gorget bar with swept tips over the collarbones
    (-0.198, 0.176), (-0.088, 0.216), (0.0, 0.200), (0.088, 0.216), (0.198, 0.176),
    (0.172, 0.148), (0.0, 0.158), (-0.172, 0.148),
]
COLLAR_ST = [(-0.010, 0.95, 0, 0), (0.0, 1.0, 0, 0), (0.066, 0.94, 0, -0.002),
             (0.106, 0.62, 0, -0.008)]

# central crest: (z, y of the flank base, y of the ridge apex, half width)
CREST = [
    (0.222, 0.028, 0.056, 0.012),
    (0.176, 0.076, 0.126, 0.026),
    (0.100, 0.106, 0.168, 0.032),
    (0.016, 0.100, 0.160, 0.030),
    (-0.072, 0.076, 0.126, 0.026),
    (-0.152, 0.048, 0.086, 0.017),
    (-0.212, 0.022, 0.038, 0.006),
]


def _crest(bm, stations, sink=0.030):
    rings = []
    for (z, yb, ya, hw) in stations:
        rings.append([
            Vector((-hw, yb, z)),
            Vector((0.0, ya, z)),
            Vector((hw, yb, z)),
            Vector((0.0, yb - sink, z)),
        ])
    loft(bm, rings)


def build_chest():
    ob, bm = _new('chest')
    plate(bm, PEC, PEC_ST)
    plate(bm, mirror_outline(PEC), PEC_ST)
    plate(bm, BELT, BELT_ST)
    plate(bm, ABS, ABS_ST)
    plate(bm, COLLAR, COLLAR_ST)
    _crest(bm, CREST)
    _finish_hard(ob, bm, gold, bevel=0.004)

    # dark recess plates sitting just BEHIND each gold lame and a hair larger, so a
    # sliver of them shows all round the lame edges. That sliver IS the trim line —
    # far cheaper than modelling an actual groove, and it reads at gameplay distance.
    t, tbm = _new('chest_trim')
    plate(tbm, PEC, PEC_TRIM_ST)
    plate(tbm, mirror_outline(PEC), PEC_TRIM_ST)
    plate(tbm, BELT, [(-0.010, 1.09, 0, 0), (0.012, 1.09, 0, 0), (0.062, 0.98, 0, -0.002),
                      (0.086, 0.76, 0, -0.006)])
    plate(tbm, ABS, [(-0.010, 1.10, 0, 0), (0.012, 1.10, 0, 0), (0.052, 0.98, 0, -0.002),
                     (0.074, 0.74, 0, -0.006)])
    plate(tbm, COLLAR, [(-0.010, 1.09, 0, 0), (0.012, 1.09, 0, 0), (0.048, 0.98, 0, -0.002),
                        (0.068, 0.72, 0, -0.006)])
    # a dark flange under the centre crest so the ridge reads as a separate raised part
    _crest(tbm, [(z, yb - 0.014, ya - 0.012, hw * 1.65 + 0.006) for (z, yb, ya, hw) in CREST],
           sink=0.024)
    _finish_hard(t, tbm, trim, bevel=0.0)

    g, gbm = _new('chest_gem')
    gem_cut(gbm, (0, 0.166, 0.056), 0.034, 0.030, n=6, phase=math.pi / 2)
    _finish_hard(g, gbm, gem, bevel=0.0)
    export([ob, t, g], os.path.join(OUT, 'armor_chest.glb'))


# --------------------------------------------------------------------------
# BOOT — foot_l / foot_r. Piece frame: +X lateral (symmetric), +Y up off the instep
# (the dome axis), +Z toward the toe. Measured in foot_l bind space (scratch/probe-foot.mjs):
#   foot bone origin = the ankle joint; +Y runs ankle->ball (ball_l at y=0.1591),
#   +Z runs down toward the sole. Model "up" in foot-local is (0,-0.448,-0.894), so the
#   orthonormal frame that keeps the dome perpendicular to the foot bone is
#   piece X -> (1,0,0), piece Y -> (0,0,-1), piece Z -> (0,1,0), i.e. rot (-pi/2, 0, 0)
#   — the same exact axis mapping the elbow/knee caps use.
#   Foot flesh in that piece frame (origin at the ankle, x re-centred by +0.012):
#     length z -0.045 .. +0.225 (toe tip), half width 0.030 (heel) .. 0.058 (ball),
#     instep top y ~ +0.028, ground plane y = 0.5014*z - 0.0968.
# The cuff leans back along (0, 0.894, -0.448) because that is true model "up" once the
# 26.6-degree ankle-bone tilt is taken out.
# --------------------------------------------------------------------------
CUFF_UP = Vector((0.0, 0.894, -0.448))     # model-vertical, expressed in the piece frame
CUFF_BASE = Vector((0.0, 0.018, -0.010))   # just above the ankle joint; low enough
                                           # that the cuff's front lip meets the shell crown
                                           # instead of leaving a bare strip of ankle

# The boot is ONE swept shell rather than a stack of separate thin lames — thin arcs read
# as flat plates sitting on the floor, a swept volume reads as a boot. The layering comes
# from the paired stations a few mm apart where the crown/width step DOWN: each step is a
# hard ledge that catches light exactly like an overlapping lame edge.
#   (z, outer half width, y of the crown, y of the side skirt, shoulder)
# Measured constraints: foot half width 0.038 (arch) .. 0.060 (ball) about the mount, the
# instep crown sits at y ~ +0.030, and the sole/ground line is y = 0.5014*z - 0.0968, so
# every yside below stays 0.005..0.03 above it (the skirt reaches for the sole, never
# through it) and every crown clears the instep by more than the 0.012 wall thickness.
BOOT_SHELL = [
    (-0.064, 0.030, -0.020, -0.070, 0.55),   # heel end, dropped to cup the calcaneus
    (-0.052, 0.044, 0.006, -0.092, 0.58),
    (-0.032, 0.056, 0.030, -0.100, 0.62),
    (-0.006, 0.060, 0.046, -0.086, 0.66),
    (0.020, 0.062, 0.051, -0.070, 0.68),
    (0.025, 0.058, 0.044, -0.060, 0.68),     # lame seam
    (0.068, 0.062, 0.048, -0.044, 0.70),
    (0.100, 0.069, 0.050, -0.030, 0.70),
    (0.105, 0.065, 0.043, -0.026, 0.70),     # lame seam
    (0.142, 0.072, 0.047, -0.014, 0.72),
    (0.172, 0.073, 0.050, 0.000, 0.72),
    (0.177, 0.069, 0.044, 0.004, 0.72),      # lame seam
    (0.202, 0.058, 0.055, 0.020, 0.72),
    (0.222, 0.036, 0.064, 0.036, 0.70),
    (0.234, 0.014, 0.068, 0.048, 0.66),      # upswept point
]
BOOT_SEAMS = [0.020, 0.100, 0.172]           # z of each ledge, for the dark trim shims


def _cuff_ring(h, hw, hd, front, back, lift=0.0):
    """A ring of the ankle cuff at height `h` up the true-vertical axis. Hexagonal
    (not round) — two front facets, two flanks, two back facets."""
    c = CUFF_BASE + CUFF_UP * h + Vector((0.0, lift, 0.0))
    pts = [
        (0.0, front),          # front centre
        (hw * 0.80, front * 0.55),
        (hw, -hd * 0.10),      # flank
        (hw * 0.72, -back * 0.70),
        (0.0, -back),          # back centre
        (-hw * 0.72, -back * 0.70),
        (-hw, -hd * 0.10),
        (-hw * 0.80, front * 0.55),
    ]
    # x is lateral; the (front/back) coordinate runs along the foot's +Z, and the ring
    # itself is perpendicular to CUFF_UP, so a step along +Z also nudges +Y.
    fwd = Vector((0.0, 0.448, 0.894))
    return [c + Vector((x, 0.0, 0.0)) + fwd * f for (x, f) in pts]


CUFF_FWD = Vector((0.0, 0.448, 0.894))     # model-horizontal along the foot, in the piece frame

# swept ankle wing, as an outline in the (forward, up) plane of the ankle. Reads as one
# blade sweeping up and BACK off the flank of the cuff — the Saint Seiya tell on a boot.
# One per flank, so the piece stays bilaterally symmetric and mirrors exactly.
WING = [
    (0.026, 0.022), (0.016, 0.064), (-0.028, 0.114), (-0.092, 0.130),
    (-0.052, 0.070), (-0.026, 0.018),
]


def _wing(bm, side):
    base = CUFF_BASE + Vector((side * 0.043, 0.0, 0.0))
    n = Vector((side * 0.006, 0.0, 0.0))
    outer = [base + CUFF_FWD * f + CUFF_UP * u + n for (f, u) in WING]
    inner = [base + CUFF_FWD * f + CUFF_UP * u - n for (f, u) in WING]
    loft(bm, [inner, outer])


def build_boot():
    ob, bm = _new('boot')

    sweep(bm, [thick_arc(z, hw, yt, ys, 0.012, shoulder=sh) for (z, hw, yt, ys, sh) in BOOT_SHELL])
    # flared ankle cuff, hexagonal and leaning back onto true vertical
    loft(bm, [
        _cuff_ring(0.000, 0.048, 0.043, 0.056, 0.052),
        _cuff_ring(0.050, 0.046, 0.041, 0.052, 0.050),
        _cuff_ring(0.104, 0.056, 0.049, 0.062, 0.060),
        _cuff_ring(0.130, 0.047, 0.040, 0.052, 0.050),
    ])
    _wing(bm, 1.0)
    _wing(bm, -1.0)
    _finish_hard(ob, bm, gold, bevel=0.0035)

    # dark trim: a slim collar band peeking out under the cuff lip, and a shim standing
    # proud of each shell ledge — the boot's version of the chest's recessed-lame language.
    t, tbm = _new('boot_trim')
    loft(tbm, [
        _cuff_ring(0.076, 0.058, 0.052, 0.065, 0.062),
        _cuff_ring(0.110, 0.062, 0.056, 0.069, 0.066),
        _cuff_ring(0.136, 0.050, 0.044, 0.055, 0.053),
    ])
    for z in BOOT_SEAMS:
        # interpolate the shell at the seam and blow it up a few mm so a dark rim shows
        ref = min(BOOT_SHELL, key=lambda s: abs(s[0] - z))
        _, hw, yt, ys, sh = ref
        sweep(tbm, [
            thick_arc(z - 0.012, hw + 0.005, yt + 0.005, ys - 0.006, 0.010, shoulder=sh),
            thick_arc(z + 0.016, hw + 0.005, yt + 0.005, ys - 0.006, 0.010, shoulder=sh),
        ])
    _finish_hard(t, tbm, trim, bevel=0.0)

    # violet gem on the front of the cuff (centred, so the mirror stays exact)
    g, gbm = _new('boot_gem')
    face = CUFF_BASE + CUFF_UP * 0.056 + CUFF_FWD * 0.050
    gem_cut(gbm, (0.0, face.y, face.z), 0.020, 0.020, n=6, phase=math.pi / 2)
    _finish_hard(g, gbm, gem, bevel=0.0)
    export([ob, t, g], os.path.join(OUT, 'armor_boot.glb'))


# --------------------------------------------------------------------------
# ELBOW / KNEE caps — same angular language so the set reads as one suit.
# Piece frame: dome along +Y, the ridge fin runs down the limb along +Z.
# --------------------------------------------------------------------------
CAP = [                     # outline in the piece's x/z plane, normalised to radius 1
    (0.0, 1.02), (0.62, 0.76), (0.96, 0.20), (0.86, -0.52),
    (0.44, -0.96), (0.0, -1.06), (-0.44, -0.96), (-0.86, -0.52),
    (-0.96, 0.20), (-0.62, 0.76),
]


def build_cap(name, radius, fin_len):
    r = radius
    ob, bm = _new(name)
    outline = [(x * r, z * r) for (x, z) in CAP]
    plate(bm, outline, [(-0.010 * r / 0.09, 0.95, 0, 0), (0.0, 1.0, 0, 0),
                        (0.36 * r, 0.90, 0, 0.02 * r), (0.60 * r, 0.70, 0, 0.05 * r),
                        (0.74 * r, 0.36, 0, 0.09 * r)])
    # raised second tier + a forward ridge fin, both faceted
    tier = [(x * 0.56, z * 0.56) for (x, z) in outline]
    plate(bm, tier, [(0.52 * r, 1.0, 0, 0.04 * r), (0.78 * r, 0.92, 0, 0.05 * r),
                     (0.94 * r, 0.44, 0, 0.07 * r)])
    fin = [
        (0.10 * r, -0.30 * r), (0.16 * r, -0.86 * r), (0.0, -1.02 * r - fin_len),
        (-0.16 * r, -0.86 * r), (-0.10 * r, -0.30 * r),
    ]
    plate(bm, fin, [(0.10 * r, 0.9, 0, 0), (0.30 * r, 1.0, 0, 0), (0.62 * r, 0.62, 0, 0.02 * r)])
    _finish_hard(ob, bm, gold, bevel=0.0035)

    t, tbm = _new(name + '_trim')
    plate(tbm, outline, [(-0.024 * r / 0.09, 1.07, 0, 0), (-0.002, 1.07, 0, 0),
                         (0.34 * r, 0.96, 0, 0.02 * r)])
    _finish_hard(t, tbm, trim, bevel=0.0)

    g, gbm = _new(name + '_gem')
    gem_cut(gbm, (0, 0.94 * r, 0.04 * r), 0.26 * r, 0.26 * r, n=6, phase=math.pi / 2)
    _finish_hard(g, gbm, gem, bevel=0.0)
    export([ob, t, g], os.path.join(OUT, f'armor_{name}.glb'))


build_chest()
build_boot()
build_cap('elbow', 0.070, 0.055)
build_cap('knee', 0.092, 0.065)
# build_pauldron() is deliberately NOT called: the shoulder is owned by
# scripts/build-armor-pauldron.blender.py. Running it from here would clobber that build.
print('ALL ARMOR PIECES BUILT')
