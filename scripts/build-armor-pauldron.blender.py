"""Saint Seiya "Cloth" SHOULDER armour (pauldron) for the Degen Tournament soldier.

Writes ONE prop: public/assets/props/armor_pauldron.glb — a drop-in replacement for the
piece scripts/build-armor.blender.py used to emit. Same mount rows in
client/assets/assetManifest.js (unchanged):
    pauldronL  bone clavicle_l  scale 0.88  pos (0, 0.19, 0)  rot (0,  1.571,  0.55)
    pauldronR  bone clavicle_r  scale 0.88  pos (0, 0.19, 0)  rot (0, -1.571, -0.55)  mirror

  ~/.local/bin/blender -b -P scripts/build-armor-pauldron.blender.py

WHY THIS FILE EXISTS SEPARATELY
-------------------------------
The old pauldron was three flattened ico-hemispheres run through a SUBSURF modifier —
which is exactly what made it read as a gold blob at gameplay distance. This rebuild is
all straight swept edges, flat-shaded facets and small chamfers: layered lames, a raised
crest ridge, two swept spikes, a faceted violet gem. No subsurf anywhere.

AUTHORING FRAME  (the important part)
------------------------------------
The mount rotation (0, 1.571, 0.55) leaves the piece's own axes pointing at awkward
angles relative to the body, so authoring directly in Blender XYZ means guessing. Instead
the piece's local axes were MEASURED in-engine (mounted node's world matrix expressed in
the spine_03 frame, whose axes are documented in assetManifest.js as +X left / +Y up /
+Z anterior). Result, as unit vectors in THIS script's Blender coordinates:

    E_OUT  outboard (away from the neck, along the clavicle)
    E_UP   up
    E_ANT  anterior (forward)

Everything below is authored in that (out, up, ant) body frame via P()/RD(), so "up" is
up and "back" is back. The origin sits on the shoulder joint (mount pos y=0.19 vs the
measured joint at y=0.197 — 7 mm inboard).

FIT / ANIMATION
---------------
The two upper lames are segments of a SPHERICAL SHELL centred on the shoulder joint, so
the clearance between plate and deltoid is constant through the whole arm swing — the arm
cannot rotate "into" them. The bottom lame leaves the sphere and FLARES instead: a shell
that kept wrapping past psi ~60 deg would collapse toward the arm axis and end up inside
the bicep (see ST()). Only the top lame reaches inboard of the joint, and only over the
trapezius, well lateral of the neck and clear of the chest plate's collar.

Verified in-engine (headless playground, skinned body vertices vs. every armour vertex)
across Idle/Jog/Sprint/Pistol_Shoot/Pistol_Aim_Up/Punch_Cross/Climb_Up/Sword_Attack: the
closest approach to the body is LARGER on every clip than the pauldron this replaced.

  psi = angle around the shoulder joint in the coronal plane:
        psi = -90 straight up, 0 straight outboard, +90 straight down the arm.
"""
import bpy, bmesh, math, os
from mathutils import Vector

OUT_DIR = os.path.expanduser('~/unreal/public/assets/props')
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PATH = os.path.join(OUT_DIR, 'armor_pauldron.glb')

# palette — shared with the rest of the Cloth set, do not drift
GOLD = (0.82, 0.63, 0.24, 1.0)     # bronze-gold cloth
TRIM = (0.30, 0.22, 0.09, 1.0)     # dark recess trim
GEM = (0.60, 0.27, 1.0, 1.0)       # Solana violet #9945FF

# measured body axes (see header) expressed in this script's Blender coords
E_OUT = Vector((0.420, -0.340, 0.841)).normalized()
E_UP = Vector((-0.842, 0.198, 0.501)).normalized()
E_ANT = Vector((-0.337, -0.919, -0.204)).normalized()


def P(out, up, ant):
    """A point in the body frame -> Blender authoring coords (metres)."""
    return E_OUT * out + E_UP * up + E_ANT * ant


def RD(psi_deg):
    """Unit radial direction at arc angle psi (see header)."""
    a = math.radians(psi_deg)
    return (E_OUT * math.cos(a) - E_UP * math.sin(a)).normalized()


# ---------------------------------------------------------------------------
# materials / object plumbing
# ---------------------------------------------------------------------------
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


def _outward(bm, closed):
    """Face the geometry outward.

    Closed solids get Blender's proper recalc; open shells (the lames) get a radial
    test instead, because recalc has no inside to work from.
    """
    bm.normal_update()
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return
    bad = [f for f in bm.faces if f.normal.dot(f.calc_center_median()) < 0]
    if bad:
        bmesh.ops.reverse_faces(bm, faces=bad)


def _finish(ob, bm, mat, solid=0.0, bevel=0.0035, seg=1, angle=32.0, closed=True):
    """Bake the bmesh, then SOLIDIFY (optional) + a small chamfer BEVEL.

    Deliberately NO subsurf: the whole point of the redesign is crisp facets. Shading is
    flat so every plate facet stays a hard, readable plane at gameplay distance.
    """
    _outward(bm, closed)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.materials.append(mat)
    if solid:
        md = ob.modifiers.new('sol', 'SOLIDIFY')
        md.thickness = solid
        md.offset = -1.0            # thicken inward, authored radius stays the outer face
        md.use_even_offset = True
    if bevel:
        md = ob.modifiers.new('bev', 'BEVEL')
        md.width = bevel
        md.segments = seg
        md.limit_method = 'ANGLE'
        md.angle_limit = math.radians(angle)
        md.miter_outer = 'MITER_ARC'
        md.use_clamp_overlap = True
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    # flat shading is a mesh attribute (not a modifier), so it survives the join below
    for f in ob.data.polygons:
        f.use_smooth = False
    return ob


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------
# cross-section across the plate (anterior <-> posterior). 5 points = 4 flat facets:
# the middle rides the authored radius, the two rim points curl inward by `wrap` so the
# plate hugs the shoulder instead of standing off it like a shelf.
PROF_T = (-1.0, -0.62, 0.0, 0.62, 1.0)
PROF_R = (-1.00, -0.34, 0.0, -0.34, -1.00)


def ST(out, down, half):
    """Build a lame station from (outboard distance, distance below the joint, half width).

    Authoring in (out, down) rather than (psi, radius) is what keeps the piece off the
    arm: the upper arm is a ~0.08 m cylinder hanging straight down from the joint, so
    every station simply has to keep `out` above that. A pure spherical shell fails here
    — past psi ~60 deg its `out` collapses toward the arm axis and the bottom of the plate
    ends up INSIDE the bicep. The lower lame therefore stops wrapping and flares instead.
    """
    return (math.degrees(math.atan2(down, out)), half, math.hypot(out, down))


ARM_R = 0.080   # upper-arm radius in authored metres — no station may sit inside this


def _ring(psi, half, r, wrap):
    d = RD(psi)
    return [d * (r + PROF_R[k] * wrap) + E_ANT * (PROF_T[k] * half) for k in range(len(PROF_T))]


def lame(bm, stations, wrap):
    """One armour plate: a swept band of quads along the arc.

    stations = [(psi_deg, half_width, radius), ...] running down the arm.
    """
    rings = [[bm.verts.new(p) for p in _ring(*s, wrap)] for s in stations]
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(len(PROF_T) - 1):
            try:
                bm.faces.new((a[j], a[j + 1], b[j + 1], b[j]))
            except ValueError:
                pass


def prism(bm, stations):
    """Raised triangular crest ridge swept along the arc.

    stations = [(psi_deg, half_width, base_radius, apex_height), ...]
    """
    rings = []
    for psi, half, r, apex in stations:
        d = RD(psi)
        rings.append([bm.verts.new(d * r + E_ANT * (-half)),
                      bm.verts.new(d * (r + apex)),
                      bm.verts.new(d * r + E_ANT * half)])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(3):
            k = (j + 1) % 3
            try:
                bm.faces.new((a[j], a[k], b[k], b[j]))
            except ValueError:
                pass
    for cap in (rings[0], rings[-1]):
        try:
            bm.faces.new(cap)
        except ValueError:
            pass


def spike(bm, path, sizes, ax_w, ax_t):
    """A tapered swept horn. path = [(out,up,ant), ...] ending at the tip point.

    sizes = [(half_w, half_t), ...] for every path point except the last (the tip).
    ax_w / ax_t are the two cross-section axes, given in the body frame.
    """
    W = P(*ax_w).normalized()
    T = P(*ax_t).normalized()
    rings = []
    for c, (hw, ht) in zip(path[:-1], sizes):
        o = P(*c)
        rings.append([bm.verts.new(o - W * hw - T * ht),
                      bm.verts.new(o + W * hw - T * ht),
                      bm.verts.new(o + W * hw + T * ht),
                      bm.verts.new(o - W * hw + T * ht)])
    tip = bm.verts.new(P(*path[-1]))
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(4):
            k = (j + 1) % 4
            try:
                bm.faces.new((a[j], a[k], b[k], b[j]))
            except ValueError:
                pass
    last = rings[-1]
    for j in range(4):
        try:
            bm.faces.new((last[j], last[(j + 1) % 4], tip))
        except ValueError:
            pass
    try:
        bm.faces.new(rings[0])
    except ValueError:
        pass


def gem_stone(bm, psi, r, ant=0.0, span=0.030, apex=0.026, keel=0.012):
    """A faceted (NOT domed) violet gem: 4-sided bipyramid lying on the plate."""
    d = RD(psi)
    tang = (RD(psi + 1.0) - RD(psi - 1.0)).normalized()   # along-arc tangent
    c = d * r + E_ANT * ant
    eq = [bm.verts.new(c + E_ANT * span + d * 0.004),
          bm.verts.new(c + tang * span + d * 0.004),
          bm.verts.new(c - E_ANT * span + d * 0.004),
          bm.verts.new(c - tang * span + d * 0.004)]
    top = bm.verts.new(c + d * apex)
    bot = bm.verts.new(c - d * keel)
    for j in range(4):
        k = (j + 1) % 4
        try:
            bm.faces.new((eq[j], eq[k], top))
        except ValueError:
            pass
        try:
            bm.faces.new((eq[k], eq[j], bot))
        except ValueError:
            pass


def plate_diamond(bm, psi, r, ant=0.0, span=0.048, thick=0.007):
    """Flat diamond-shaped setting the gem sits in (dark trim)."""
    d = RD(psi)
    tang = (RD(psi + 1.0) - RD(psi - 1.0)).normalized()
    c = d * r + E_ANT * ant
    quad = [c + E_ANT * span, c + tang * span, c - E_ANT * span, c - tang * span]
    top = [bm.verts.new(p + d * thick * 0.5) for p in quad]
    bot = [bm.verts.new(p - d * thick * 0.5) for p in quad]
    try:
        bm.faces.new(top)
    except ValueError:
        pass
    try:
        bm.faces.new(list(reversed(bot)))
    except ValueError:
        pass
    for j in range(4):
        k = (j + 1) % 4
        try:
            bm.faces.new((top[j], top[k], bot[k], bot[j]))
        except ValueError:
            pass


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    me = bpy.context.view_layer.objects.active.data
    me.calc_loop_triangles()
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB',
                              export_apply=True, export_yup=True)
    print('wrote', path, 'TRIS', len(me.loop_triangles), 'VERTS', len(me.vertices),
          'BYTES', os.path.getsize(path))


# ---------------------------------------------------------------------------
# the pauldron
# ---------------------------------------------------------------------------
# Three lames stepping DOWN the arm, each one riding a slightly larger radius than the
# one above it so the plate flares outward as it descends and every step reads as a hard
# edge in silhouette. (psi, half_width, radius) — all metres, mount scale 0.88 applies.
# Three lames stepping DOWN the arm, each riding ~0.012 m proud of the one above so
# every join is a hard step in silhouette. The half-widths deliberately PEAK and fall
# back, so each lame's outline is a diamond with a swept corner rather than an oval —
# that corner is what reads as a Saint Seiya wing tip. The two peaks are staggered along
# the arc so the tips overlap instead of stacking.
#                out    down    half
LAME_TOP = [ST(-0.040, -0.070, 0.054),  # inboard edge, riding over the trapezius
            ST(0.014, -0.098, 0.084),
            ST(0.070, -0.110, 0.116),   # crest of the shoulder
            ST(0.126, -0.086, 0.152),   # upper wing tip
            ST(0.156, -0.038, 0.138),
            ST(0.170, 0.010, 0.114)]
LAME_MID = [ST(0.178, -0.004, 0.098),
            ST(0.182, 0.044, 0.160),    # main wing tip — widest point of the piece
            ST(0.168, 0.092, 0.114),
            ST(0.146, 0.124, 0.088)]
# the bottom lame FLARES (out stops shrinking) instead of continuing round the arm
LAME_LOW = [ST(0.160, 0.114, 0.096),
            ST(0.164, 0.146, 0.090),
            ST(0.158, 0.176, 0.072),
            ST(0.146, 0.196, 0.044)]    # chamfered bottom edge, above the elbow cap

# dark recess bands peeking out under each lame's leading edge
BAND_MID = [ST(0.164, -0.032, 0.112), ST(0.168, 0.006, 0.116)]
BAND_LOW = [ST(0.148, 0.094, 0.104), ST(0.150, 0.116, 0.100)]

# raised centreline crest along the top lame — (station..., apex height above the plate)
CREST = [ST(-0.039, -0.069, 0.012) + (0.016,),
         ST(0.014, -0.097, 0.020) + (0.028,),
         ST(0.070, -0.109, 0.026) + (0.034,),
         ST(0.126, -0.085, 0.026) + (0.034,),
         ST(0.156, -0.037, 0.022) + (0.028,),
         ST(0.170, 0.011, 0.018) + (0.022,)]


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    gold = _mat('ArmorGold', GOLD)
    # trim is deliberately less metallic/rougher than the plates so it stays READ-DARK
    # next to the gold instead of catching the same speculars and going gold too.
    trim = _mat('ArmorTrim', TRIM, metal=0.55, rough=0.66)
    # emit_str 6.0 (the old value) clips to white under the arena tone map and the gem
    # loses its colour entirely; 2.2 still glows but stays visibly Solana violet.
    gem = _mat('ArmorGem', GEM, metal=0.0, rough=0.1, emit=GEM, emit_str=2.2)

    objs = []

    # --- gold: the three lames + the crest ridge + both swept spikes -----------
    ob, bm = _new('paul_plates')
    lame(bm, LAME_TOP, 0.017)
    _finish(ob, bm, gold, solid=0.013, closed=False)
    objs.append(ob)

    ob, bm = _new('paul_mid')
    lame(bm, LAME_MID, 0.016)
    _finish(ob, bm, gold, solid=0.013, closed=False)
    objs.append(ob)

    ob, bm = _new('paul_low')
    lame(bm, LAME_LOW, 0.013)
    _finish(ob, bm, gold, solid=0.013, closed=False)
    objs.append(ob)

    ob, bm = _new('paul_crest')
    prism(bm, CREST)
    _finish(ob, bm, gold, solid=0.0, bevel=0.0025)
    objs.append(ob)

    # upper spike: sweeps back + up + outboard off the rear of the top lame. Its root
    # sits just under the plate surface so it reads as growing out of the armour.
    ob, bm = _new('paul_spike_hi')
    spike(bm,
          [(0.112, 0.086, -0.070),
           (0.130, 0.120, -0.140),
           (0.145, 0.140, -0.196),
           (0.152, 0.148, -0.236)],
          [(0.030, 0.018), (0.021, 0.013), (0.010, 0.006)],
          ax_w=(0.0, 0.36, 0.93), ax_t=(0.93, -0.36, 0.0))
    _finish(ob, bm, gold, bevel=0.0025)
    objs.append(ob)

    # lower spike: sweeps straight back off the rear of the bottom lame
    ob, bm = _new('paul_spike_lo')
    spike(bm,
          [(0.150, -0.132, -0.072),
           (0.164, -0.124, -0.137),
           (0.172, -0.110, -0.187)],
          [(0.026, 0.015), (0.015, 0.009)],
          ax_w=(0.0, 0.99, 0.14), ax_t=(0.99, 0.0, 0.0))
    _finish(ob, bm, gold, bevel=0.0025)
    objs.append(ob)

    # --- dark trim recesses ---------------------------------------------------
    ob, bm = _new('paul_band_mid')
    lame(bm, BAND_MID, 0.016)
    _finish(ob, bm, trim, solid=0.008, bevel=0.002, closed=False)
    objs.append(ob)

    ob, bm = _new('paul_band_low')
    lame(bm, BAND_LOW, 0.014)
    _finish(ob, bm, trim, solid=0.008, bevel=0.002, closed=False)
    objs.append(ob)

    ob, bm = _new('paul_bezel')
    plate_diamond(bm, 13.6, 0.187, span=0.060)
    _finish(ob, bm, trim, bevel=0.002)
    objs.append(ob)

    # --- the focal gem --------------------------------------------------------
    ob, bm = _new('paul_gem')
    gem_stone(bm, 13.6, 0.189, span=0.039, apex=0.034)
    _finish(ob, bm, gem, bevel=0.0015)
    objs.append(ob)

    # cheap safety net: nothing may sit inside the upper-arm cylinder
    worst = None
    for o in objs:
        for v in o.data.vertices:
            p = v.co
            out = p.dot(E_OUT)
            down = -p.dot(E_UP)
            if down <= 0.02:
                continue                      # above the joint, the arm is not there
            if worst is None or out < worst[0]:
                worst = (out, down)
    if worst:
        print('ARM CLEARANCE: closest station out=%.4f at down=%.4f (arm r=%.3f) -> %s'
              % (worst[0], worst[1], ARM_R, 'OK' if worst[0] > ARM_R else 'INTERSECTS'))

    export(objs, OUT_PATH)


build()
print('PAULDRON BUILT')
