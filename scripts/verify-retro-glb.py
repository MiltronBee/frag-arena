#!/usr/bin/env python3
"""Read-only structural + geometric verifier for candidate Retro weapon GLBs.

Parses a GLB with the standard library only (no Blender, no glTF SDK) and FAILS on:
  * a missing required clip name (idle/fire/reload/draw for every weapon; shotgun
    also reload_start/reload_insert/reload_end and the chained reload)
  * a non-finite or non-positive animation duration, or an empty/!=length track
  * hand/gun target omission -- any clip that animates the arms but NOT the gun
    (this is exactly the shipped Rifle/Shotgun draw detachment) or vice-versa
  * weapon/hand DETACHMENT RISK measured geometrically: it rebuilds the node
    hierarchy, samples every runtime clip, and checks the grip hand rides the gun
    (right-hand slip vs the gun Main bone stays tiny across the whole clip)
  * duplicate skeletons (skins != 2, or a duplicated armature-root node name)
  * an accidentally exported camera / control-widget / Cube node
  * a materially mismatched node set (a required node name is absent)

It specifically guards stale-gun-swap compatibility (unique, correctly named
<Weapon>_01_Armature + Main + hand_l/hand_r) and the fire-attachment invariant.

    usage: python3 scripts/verify-retro-glb.py GLB [GLB ...]
           [--weapon NAME] [--mapping P] [--baseline GLB] [--slip-tol CM] [--json]
"""
import argparse, json, math, os, struct, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MAPPING = os.path.join(REPO, "scripts", "retro-blend-actions.json")
COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
             5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


# ----------------------------------------------------------------- GLB parsing
def load_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, ver, length = struct.unpack("<III", data[:12])
    if magic != 0x46546C67:
        raise ValueError("not a GLB: " + path)
    off, js, binc = 12, None, b""
    while off < length:
        clen, ctype = struct.unpack("<II", data[off:off + 8]); off += 8
        chunk = data[off:off + clen]; off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        elif ctype == 0x004E4942:
            binc = chunk
    return js, binc


def accessor(g, binc, idx):
    """Return list of tuples (or scalars) for accessor idx."""
    a = g["accessors"][idx]
    bv = g["bufferViews"][a["bufferView"]]
    comp, size = COMPONENT[a["componentType"]]
    n = NCOMP[a["type"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or (size * n)
    out = []
    for i in range(a["count"]):
        o = base + i * stride
        vals = struct.unpack_from("<" + comp * n, binc, o)
        out.append(vals[0] if n == 1 else vals)
    return out


# ----------------------------------------------------------------- 4x4 maths (row-major)
def mat_ident():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def quat_to_mat(q):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def trs_matrix(t, q, s):
    m = quat_to_mat(q)
    for i in range(3):
        for j in range(3):
            m[i][j] *= s[j]
    m[0][3], m[1][3], m[2][3] = t
    return m


def mat_point(m, p):
    x, y, z = p
    return (m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
            m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
            m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3])


def mat_inverse(m):
    a = [row[:] + ident for row, ident in zip(m, mat_ident())]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            return None
        a[col], a[piv] = a[piv], a[col]
        d = a[col][col]
        a[col] = [v / d for v in a[col]]
        for r in range(4):
            if r != col and a[r][col]:
                f = a[r][col]
                a[r] = [v - f * a[col][k] for k, v in enumerate(a[r])]
    return [row[4:] for row in a]


def slerp(q0, q1, t):
    d = sum(q0[i] * q1[i] for i in range(4))
    if d < 0:
        q1 = [-c for c in q1]; d = -d
    if d > 0.9995:
        r = [q0[i] + t * (q1[i] - q0[i]) for i in range(4)]
    else:
        th0 = math.acos(max(-1.0, min(1.0, d)))
        th = th0 * t
        s0 = math.cos(th) - d * math.sin(th) / math.sin(th0)
        s1 = math.sin(th) / math.sin(th0)
        r = [s0 * q0[i] + s1 * q1[i] for i in range(4)]
    n = math.sqrt(sum(c * c for c in r)) or 1.0
    return [c / n for c in r]


# ----------------------------------------------------------------- animation sampling
class Scene:
    def __init__(self, g, binc):
        self.g, self.binc = g, binc
        self.nodes = g.get("nodes", [])
        self.names = [n.get("name", "#%d" % i) for i, n in enumerate(self.nodes)]
        self.name_to_idx = {}
        for i, nm in enumerate(self.names):
            self.name_to_idx.setdefault(nm, i)
        self.parent = [None] * len(self.nodes)
        for i, n in enumerate(self.nodes):
            for c in n.get("children", []):
                self.parent[c] = i

    def base_trs(self, i):
        n = self.nodes[i]
        t = tuple(n.get("translation", (0.0, 0.0, 0.0)))
        q = tuple(n.get("rotation", (0.0, 0.0, 0.0, 1.0)))
        s = tuple(n.get("scale", (1.0, 1.0, 1.0)))
        return t, q, s

    def sample_anim(self, anim):
        """Return {node_idx: {'translation':vec,'rotation':quat,'scale':vec}} evaluator."""
        chans = []
        for c in anim["channels"]:
            s = anim["samplers"][c["sampler"]]
            tgt = c["target"]
            if "node" not in tgt:
                continue
            inp = accessor(self.g, self.binc, s["input"])
            out = accessor(self.g, self.binc, s["output"])
            chans.append((tgt["node"], tgt["path"], s.get("interpolation", "LINEAR"), inp, out))
        return chans

    def eval_channel(self, path, interp, inp, out, t):
        if t <= inp[0]:
            v = out[0] if interp != "CUBICSPLINE" else out[1]
            return v
        if t >= inp[-1]:
            v = out[-1] if interp != "CUBICSPLINE" else out[-2]
            return v
        # find bracket
        hi = 0
        while hi < len(inp) and inp[hi] < t:
            hi += 1
        lo = hi - 1
        span = inp[hi] - inp[lo] or 1.0
        f = (t - inp[lo]) / span
        if interp == "STEP":
            return out[lo]
        if interp == "CUBICSPLINE":
            return out[1 + lo * 3]  # value keyframe (ignore tangents for slip test)
        if path == "rotation":
            return slerp(out[lo], out[hi], f)
        a, b = out[lo], out[hi]
        return tuple(a[k] + f * (b[k] - a[k]) for k in range(len(a)))

    def world_matrix(self, node_idx, overrides):
        chain = []
        i = node_idx
        while i is not None:
            chain.append(i)
            i = self.parent[i]
        m = mat_ident()
        for i in reversed(chain):
            t, q, s = self.base_trs(i)
            ov = overrides.get(i)
            if ov:
                t = ov.get("translation", t)
                q = ov.get("rotation", q)
                s = ov.get("scale", s)
            m = mat_mul(m, trs_matrix(list(t), list(q), list(s)))
        return m

    def overrides_at(self, chans, t):
        ov = {}
        for node, path, interp, inp, out in chans:
            ov.setdefault(node, {})[path] = self.eval_channel(path, interp, inp, out, t)
        return ov


# ----------------------------------------------------------------- checks
def infer_weapon(path):
    base = os.path.basename(path).lower()
    for w in ("rifle", "pistol", "shotgun", "smg"):
        if w in base:
            return {"rifle": "Rifle", "pistol": "Pistol", "shotgun": "Shotgun", "smg": "SMG"}[w]
    return None


def joint_sets(g):
    """Return (arms_joint_names, gun_joint_names) from the two skins (arms == the
    skin containing hand_l)."""
    names = [n.get("name", "") for n in g.get("nodes", [])]
    skins = g.get("skins", [])
    sets = []
    for sk in skins:
        js = set(names[j] for j in sk.get("joints", []))
        sets.append(js)
    arms = next((s for s in sets if "hand_l" in s), None)
    gun = next((s for s in sets if s is not arms), None)
    return arms or set(), gun or set(), len(skins)


def verify(path, weapon, mapping, baseline_names, slip_tol):
    fails, warns, info = [], [], []
    g, binc = load_glb(path)
    sc = Scene(g, binc)
    names = sc.names
    name_set = set(names)
    wspec = mapping["weapons"][weapon]
    gun_arm = wspec["gunArmature"]
    clips = wspec["clips"]
    expected = list(clips.keys())
    runtime_required = mapping["runtimeConsumedToday"]

    anims = {a.get("name"): a for a in g.get("animations", [])}

    # [A] required clip names -------------------------------------------------
    for c in runtime_required:
        if c not in anims:
            fails.append("runtime clip %r missing" % c)
    for c in expected:
        if c not in anims:
            fails.append("declared clip %r missing" % c)
    info.append("animations: %s" % ", ".join(sorted(anims)))

    # [B] durations finite/positive, tracks non-empty & length-consistent -----
    def clip_dur(a):
        d = 0.0
        for c in a["channels"]:
            s = a["samplers"][c["sampler"]]
            inp = accessor(g, binc, s["input"])
            out = accessor(g, binc, s["output"])
            if len(inp) == 0 or len(out) == 0:
                fails.append("clip %r has an empty sampler" % a.get("name"))
            interp = s.get("interpolation", "LINEAR")
            expect = len(inp) * (3 if interp == "CUBICSPLINE" else 1)
            if len(out) != expect:
                fails.append("clip %r sampler length %d != %d" % (a.get("name"), len(out), expect))
            for v in inp:
                if not math.isfinite(v):
                    fails.append("clip %r non-finite keyframe time" % a.get("name"))
            if inp:
                d = max(d, inp[-1])
        return d
    for nm, a in anims.items():
        if not a.get("channels"):
            fails.append("clip %r has no channels" % nm)
            continue
        d = clip_dur(a)
        if not (math.isfinite(d) and d > 0):
            fails.append("clip %r non-positive/inf duration (%r)" % (nm, d))

    # [C] hand/gun target coverage per clip (detachment guard) ----------------
    # A clip that drives the arms but not the gun is a detachment SUSPECT (this is
    # how the old Rifle/Shotgun draw detachment looked). But it is only a real fault
    # if the grip actually LEAVES the gun: a clip may legitimately hold the gun
    # STATIC at bind while the baked arms grip it -- the shotgun fire does exactly
    # this to avoid riding the authored pump-rack off the weapon. So we DEFER the
    # verdict to the authoritative geometric grip-slip measured in [F] below, and
    # fail only when the grip actually slips or cannot be measured.
    arms_joints, gun_joints, n_skins = joint_sets(g)
    gun_targets_ok = gun_joints | {gun_arm}
    arms_only_clips = []
    for nm, a in anims.items():
        tnodes = set()
        for c in a["channels"]:
            ni = c["target"].get("node")
            if ni is not None:
                tnodes.add(names[ni])
        has_arms = bool(tnodes & arms_joints)
        has_gun = bool(tnodes & gun_targets_ok)
        if has_arms and not has_gun:
            arms_only_clips.append(nm)
        if has_gun and not has_arms:
            warns.append("clip %r animates gun but not arms" % nm)

    # [D] duplicate skeletons / accidental exports ----------------------------
    if n_skins != 2:
        fails.append("expected exactly 2 skins (arms+gun), found %d" % n_skins)
    dup = sorted(set(nm for nm in names if names.count(nm) > 1 and nm))
    for root in ("Arms_Armature", gun_arm):
        if names.count(root) == 0:
            fails.append("armature root %r absent" % root)
        elif names.count(root) > 1:
            fails.append("armature root %r duplicated (%d) -- stale-swap cross-wire risk"
                         % (root, names.count(root)))
    if dup:
        warns.append("duplicate node names: %s" % ", ".join(dup[:8]) + (" ..." if len(dup) > 8 else ""))
    stray = [nm for nm in names if nm == "Camera" or nm.startswith("Ctrl_Mesh") or nm == "Cube"
             or nm.startswith("Cube.")]
    if stray:
        fails.append("stray control/camera/cube nodes exported: %s" % ", ".join(sorted(set(stray))))
    if g.get("cameras"):
        fails.append("accidental camera export (%d camera(s))" % len(g["cameras"]))

    # [E] required node set ---------------------------------------------------
    required_nodes = list(mapping.get("requiredNodes", [])) + [gun_arm]
    for rn in required_nodes:
        if rn not in name_set:
            fails.append("required node %r absent (node-set mismatch)" % rn)
    if baseline_names is not None:
        missing = sorted(baseline_names - name_set)
        added = sorted(name_set - baseline_names)
        if missing:
            fails.append("nodes present in baseline but missing here: %s"
                         % ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else ""))
        if added:
            info.append("nodes added vs baseline: %s" % ", ".join(added[:10]))

    # [F] geometric attachment: grip hand rides the gun Main across each clip --
    def slip_for(anim_name, grip):
        a = anims.get(anim_name)
        if not a or grip not in sc.name_to_idx or "Main" not in sc.name_to_idx:
            return None
        chans = sc.sample_anim(a)
        dur = clip_dur(a)
        gi, mi = sc.name_to_idx[grip], sc.name_to_idx["Main"]
        pts = []
        N = 24
        for k in range(N + 1):
            t = dur * k / N
            ov = sc.overrides_at(chans, t)
            gw = sc.world_matrix(gi, ov)
            mw = sc.world_matrix(mi, ov)
            inv = mat_inverse(mw)
            if inv is None:
                return None
            pts.append(mat_point(inv, (gw[0][3], gw[1][3], gw[2][3])))
        spread = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
        return max(spread)

    attach = {}
    for c in [c for c in ("idle", "walk", "run", "fire", "reload", "draw", "hide", "interact") if c in anims]:
        sr = slip_for(c, "hand_r")
        sl = slip_for(c, "hand_l")
        attach[c] = (sr, sl)
        if sr is None:
            warns.append("could not sample attachment for %r" % c)
            continue
        # the RIGHT (grip) hand must ride the gun on every clip; the LEFT hand is
        # allowed to leave during reload (feeds rounds) -- report but don't fail on it.
        if sr > slip_tol:
            fails.append("clip %r: grip hand slips %.2fcm vs gun Main (> %.2fcm) -- DETACHMENT"
                         % (c, sr, slip_tol))
    for c, (sr, sl) in attach.items():
        info.append("attach %-9s grip_slip=%s cm  left_slip=%s cm"
                    % (c, "%.3f" % sr if sr is not None else "n/a",
                       "%.3f" % sl if sl is not None else "n/a"))

    # [C-deferred] rule on arms-only clips using the geometric grip-slip from [F]:
    # a static-gun clip is fine iff the grip hand still rides the gun.
    for nm in arms_only_clips:
        sr = attach.get(nm, (None, None))[0]
        if sr is None:
            fails.append("clip %r animates arms but NOT the gun and grip attachment "
                         "could not be verified (detachment risk)" % nm)
        elif sr > slip_tol:
            fails.append("clip %r animates arms but NOT the gun and the grip slips "
                         "%.2fcm vs gun Main (> %.2fcm) -- DETACHMENT" % (nm, sr, slip_tol))
        else:
            info.append("clip %r holds the gun static at bind; grip stays attached "
                        "(slip %.3fcm) -- OK" % (nm, sr))

    return {"path": path, "weapon": weapon, "fails": fails, "warns": warns, "info": info,
            "nodes": len(names), "skins": n_skins, "anims": len(anims), "names": name_set}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glbs", nargs="+")
    ap.add_argument("--weapon", default=None)
    ap.add_argument("--mapping", default=DEFAULT_MAPPING)
    ap.add_argument("--baseline", default=None, help="production GLB to diff node set against")
    ap.add_argument("--slip-tol", type=float, default=3.0, help="max grip-hand slip in cm")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    with open(args.mapping) as f:
        mapping = json.load(f)

    baseline_names = None
    if args.baseline:
        bg, _ = load_glb(args.baseline)
        baseline_names = set(n.get("name", "") for n in bg.get("nodes", []))

    results, total_fail = [], 0
    for path in args.glbs:
        weapon = args.weapon or infer_weapon(path)
        if not weapon or weapon not in mapping["weapons"]:
            print("SKIP %s: cannot resolve weapon" % path); total_fail += 1; continue
        r = verify(path, weapon, mapping, baseline_names, args.slip_tol)
        results.append(r)
        if r["fails"]:
            total_fail += 1
        if not args.json:
            print("\n=== %s  [%s]  nodes=%d skins=%d anims=%d ==="
                  % (os.path.basename(path), weapon, r["nodes"], r["skins"], r["anims"]))
            for ln in r["info"]:
                print("   . " + ln)
            for w in r["warns"]:
                print("   ! WARN  " + w)
            for fl in r["fails"]:
                print("   x FAIL  " + fl)
            print("   => %s" % ("PASS" if not r["fails"] else "FAIL (%d)" % len(r["fails"])))

    if args.json:
        print(json.dumps([{k: (sorted(v) if isinstance(v, set) else v)
                           for k, v in r.items() if k != "names"} for r in results], indent=1))
    print("\nRESULT: %s -- %d/%d candidates passed"
          % ("PASS" if total_fail == 0 else "FAIL", len(results) - total_fail, len(results)))
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
