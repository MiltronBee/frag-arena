#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# import-map.py — generalized per-map import pipeline for the browser FPS.
#
# Generalizes scripts/process_visage.py from a hand-tuned play-area box to a
# nav-derived keep-box, and folds in the texture->WebP, OBJ/lights copy, and
# mapRegistry record emission. OFFLINE asset work only — touches nothing in the
# running game loop.
#
# Usage:
#   python3 scripts/import-map.py <MapName> [--dry]
#   e.g. python3 scripts/import-map.py DM-Corpax
#
# Reads (never modifies):
#   maps/improved/<MapName>.obj              the live-convention OBJ (Z-up)
#   maps/improved/<MapName>.mtl              its materials
#   maps/improved/textures_hd/*.png          source textures (referenced by MTL)
#   maps/improved/lights/<MapName>.lights.json   baked lights sidecar
#   _work/ut-actors/<MapName>.actors.json    NAV nodes (to derive the keep-box)
#   _work/ut-actors/registry/<id>.json       merged/v1 extracted record (validated)
#
# Writes (creates):
#   public/assets/maps/<MapName>/<MapName>.obj          isolated play mesh
#   public/assets/maps/<MapName>/<MapName>.mtl          rewritten -> webp
#   public/assets/maps/<MapName>/<MapName>.lights.json  copied sidecar
#   public/assets/maps/<MapName>/textures/*.webp        512px WebP
#   _work/mapimport/<id>.record.js                      ready-to-paste JS record
#
# Pipeline steps (per the brief):
#   (a) play-area isolation  — keep-box from NAV bounds + margin (generalizes the
#                              hand-tuned CTF-Visage box), strip detached skybox.
#   (b) textures -> 512 WebP + MTL rewrite (only materials the play mesh uses).
#   (c) copy OBJ + lights sidecar into the asset dir.
#   (d) occluder subdivision is RUNTIME (_loadMapMesh) — we do NOT pre-subdivide.
#   (e) emit the mapRegistry.js record from the merged/v1 JSON (+ fog advisory).
# ---------------------------------------------------------------------------
import os, sys, json, math, shutil
from PIL import Image

HOME = os.path.expanduser('~')
ROOT = os.path.join(HOME, 'unreal')
IMPROVED = os.path.join(ROOT, 'maps/improved')
SRC_TEX = os.path.join(IMPROVED, 'textures_hd')
LIGHTS_DIR = os.path.join(IMPROVED, 'lights')
ACTORS = os.path.join(ROOT, '_work/ut-actors')
REGISTRY = os.path.join(ACTORS, 'registry')
OUT_ROOT = os.path.join(ROOT, 'public/assets/maps')
MAPIMPORT = os.path.join(ROOT, '_work/mapimport')

SCALE = 0.65
WEBP_MAX = 512
WEBP_QUALITY = 80

# keep-box margin: inflate the NAV AABB by max(MARGIN_MIN, HALF_FRAC * largest nav
# span). Conservative on purpose — we only want to strip clearly-DETACHED skybox
# clusters (typically 2-3x the play extent away, e.g. DM-Corpax's cityscape), never
# the enclosing walls/ceiling that sit just outside the nav mesh.
MARGIN_MIN = 30.0
HALF_FRAC = 0.5


def reg_id(name):
    return name.lower().replace('][', '2').replace('-', '_').replace('_2025', '')


# --- OBJ<->native frame -----------------------------------------------------
# Runtime uploads the Z-up OBJ then rotates it -90 deg about X (rotationX=-PI/2),
# so world/native = (obj_x, obj_z, -obj_y). NAV nodes are stored in the native
# frame {x, z(horizontal), y(up)}; to compare against raw OBJ vertices we map a
# nav point back to OBJ space: obj = (n.x, -n.z, n.y).
def nav_to_obj(n):
    return (n['x'], -n['z'], n['y'])


def load_obj(path):
    """Return (vertex_list, raw_lines)."""
    V = []
    lines = open(path, errors='ignore').read().splitlines()
    for ln in lines:
        if ln.startswith('v '):
            p = ln.split()
            V.append((float(p[1]), float(p[2]), float(p[3])))
    return V, lines


def derive_keep_box(name):
    """Keep-box in OBJ coords from the NAV nodes, or None if no nav data (=> no strip)."""
    ap = os.path.join(ACTORS, name + '.actors.json')
    if not os.path.exists(ap):
        return None
    nav = json.load(open(ap)).get('NAV', {})
    nodes = nav.get('nodes', [])
    if not nodes:
        return None
    pts = [nav_to_obj(n) for n in nodes]
    mn = [min(p[i] for p in pts) for i in range(3)]
    mx = [max(p[i] for p in pts) for i in range(3)]
    span = max(mx[i] - mn[i] for i in range(3))
    m = max(MARGIN_MIN, HALF_FRAC * span)
    return dict(lo=[mn[i] - m for i in range(3)], hi=[mx[i] + m for i in range(3)], margin=m, nodes=len(nodes))


def isolate(name, V, lines, box):
    """Emit play-only OBJ lines. box=None keeps everything (no detached skybox)."""
    def centroid(toks):
        xs = ys = zs = 0.0
        n = 0
        for t in toks:
            i = int(t.split('/')[0]) - 1
            xs += V[i][0]; ys += V[i][1]; zs += V[i][2]; n += 1
        return xs / n, ys / n, zs / n

    def inbox(c):
        return all(box['lo'][i] <= c[i] <= box['hi'][i] for i in range(3))

    out = ['mtllib %s.mtl' % name]
    cur = None
    emitted = None
    kept_mats = set()
    kept = dropped = 0
    kept_idx = []
    for ln in lines:
        if ln.startswith('mtllib'):
            continue  # replaced above
        if ln.startswith(('v ', 'vt ', 'vn ')):
            out.append(ln); continue
        if ln.startswith('usemtl '):
            cur = ln.split(None, 1)[1].strip(); continue
        if ln.startswith('f '):
            toks = ln.split()[1:]
            if box is None or inbox(centroid(toks)):
                if emitted != cur:
                    out.append('usemtl ' + (cur or 'default')); emitted = cur
                out.append(ln); kept += 1; kept_mats.add(cur)
                kept_idx.append([int(t.split('/')[0]) - 1 for t in toks])
            else:
                dropped += 1
            continue
        # drop o/g/s and comments
    return out, kept_mats, kept, dropped, kept_idx


def convert_textures(name, src_mtl, kept_mats, out_dir, out_tex, dry):
    """Parse the source MTL, convert map_Kd for kept materials to WebP, rewrite MTL."""
    blocks = {}
    cur = None; buf = []
    for ln in open(src_mtl):
        if ln.startswith('newmtl '):
            if cur:
                blocks[cur] = buf
            cur = ln.split(None, 1)[1].strip(); buf = [ln.rstrip('\n')]
        elif cur:
            buf.append(ln.rstrip('\n'))
    if cur:
        blocks[cur] = buf

    mtl_out = ['# %s play mesh (skybox stripped) - web textures' % name]
    converted = 0; reused = 0; missing = []
    for m in sorted(x for x in kept_mats if x):
        blk = blocks.get(m)
        if not blk:
            mtl_out += ['', 'newmtl ' + m, 'Kd 0.8 0.8 0.8']; continue
        new_blk = []
        for line in blk:
            if line.startswith('map_Kd'):
                src_name = os.path.basename(line.split()[-1])
                stem = os.path.splitext(src_name)[0]
                src = os.path.join(SRC_TEX, src_name)
                dst = os.path.join(out_tex, stem + '.webp')
                if os.path.exists(src):
                    if not dry:
                        if not os.path.exists(dst):
                            im = Image.open(src).convert('RGB')
                            im.thumbnail((WEBP_MAX, WEBP_MAX), Image.LANCZOS)
                            im.save(dst, 'WEBP', quality=WEBP_QUALITY, method=6)
                            converted += 1
                        else:
                            reused += 1
                    new_blk.append('map_Kd textures/%s.webp' % stem)
                else:
                    missing.append(src_name)
            else:
                new_blk.append(line)
        mtl_out.append(''); mtl_out += new_blk
    if not dry:
        open(os.path.join(out_dir, name + '.mtl'), 'w').write('\n'.join(mtl_out) + '\n')
    return converted, reused, missing


def _scalar(v):
    return v is None or isinstance(v, (bool, int, float, str))


def js_key(k):
    return k if k.replace('_', '').isalnum() and not k[0].isdigit() else "'%s'" % k


def js_lit(obj, indent=1):
    """Minimal JS literal emitter (numbers unquoted, keys bare when identifier-safe).
    Dicts whose values are all scalars collapse to ONE inline line (matches the
    one-object-per-line pickup/spawn style already in mapRegistry.js)."""
    pad = '\t' * indent
    pad0 = '\t' * (indent - 1)
    if isinstance(obj, dict):
        if not obj:
            return '{}'
        if all(_scalar(v) for v in obj.values()):
            return '{ ' + ', '.join('%s: %s' % (js_key(k), js_lit(v, indent + 1)) for k, v in obj.items()) + ' }'
        items = ['%s%s: %s' % (pad, js_key(k), js_lit(v, indent + 1)) for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + pad0 + '}'
    if isinstance(obj, list):
        if not obj:
            return '[]'
        if all(isinstance(x, dict) for x in obj):
            return '[\n' + ',\n'.join(pad + js_lit(x, indent + 1) for x in obj) + '\n' + pad0 + ']'
        return '[' + ', '.join(js_lit(x, indent + 1) for x in obj) + ']'
    if isinstance(obj, bool):
        return 'true' if obj else 'false'
    if obj is None:
        return 'null'
    if isinstance(obj, float):
        return repr(round(obj, 4))
    if isinstance(obj, str):
        return "'%s'" % obj.replace("'", "\\'")
    return str(obj)


def emit_record(name, kept, dropped, box):
    """Build the mapRegistry.js record snippet from the validated merged/v1 JSON."""
    rid = reg_id(name)
    jp = os.path.join(REGISTRY, rid + '.json')
    if not os.path.exists(jp):
        print('  [record] no merged/v1 JSON at %s — skipping record emit' % jp)
        return None
    j = json.load(open(jp))
    dv = j.get('derived', {})
    sight = dv.get('longest_sightline_world_m')
    rec = {
        'id': j['id'],
        'name': j['name'],
        'mode': j['mode'],
        'dir': j['dir'],
        'file': j['file'],
        'lights': j['lights'],
        # scale/rotationX/yOffset omitted — identical to mesh() defaults (0.65 / -PI2 / 0)
        'killY': j['killY'],
        'spawns': j['spawns'],
        'walkable': j['walkable'],
        'mega': j['mega'],
        'mode_data': j.get('mode_data', {}),
        'SPAWN_POINTS': j['SPAWN_POINTS'],
        'PICKUPS': j['PICKUPS'],
    }
    body = js_lit(rec, 2)
    const_name = rid
    header = (
        '// %s (UT original %s) — imported %s. killY nav-gated (margin %.2f m world);\n'
        '// winding sign %s; longest sightline %.1f m (default fog OK — no per-map fogDensity).\n'
        '// Isolation: %s.\n'
    ) % (
        j['name'], j.get('source_map', '?'), j['mode'],
        dv.get('killY_margin_world_m', 0),
        dv.get('floor_normal_sign'),
        sight if sight is not None else -1,
        ('kept %d faces, dropped %d detached (margin %.0f m)' % (kept, dropped, box['margin'])) if box else 'no detached skybox (kept all faces)',
    )
    snippet = header + 'const %s = mesh(%s)\n' % (const_name, body)
    outp = os.path.join(MAPIMPORT, rid + '.record.js')
    open(outp, 'w').write(snippet)
    print('  [record] wrote %s (const %s)' % (outp, const_name))
    return const_name


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry = '--dry' in sys.argv
    if not args:
        print('usage: python3 scripts/import-map.py <MapName> [--dry]'); sys.exit(2)
    name = args[0]

    src_obj = os.path.join(IMPROVED, name + '.obj')
    src_mtl = os.path.join(IMPROVED, name + '.mtl')
    src_lights = os.path.join(LIGHTS_DIR, name + '.lights.json')
    for p in (src_obj, src_mtl):
        if not os.path.exists(p):
            print('MISSING source: ' + p); sys.exit(1)

    out_dir = os.path.join(OUT_ROOT, name)
    out_tex = os.path.join(out_dir, 'textures')
    os.makedirs(MAPIMPORT, exist_ok=True)
    if not dry:
        os.makedirs(out_tex, exist_ok=True)

    print('=== import %s%s ===' % (name, ' (dry-run)' if dry else ''))
    V, lines = load_obj(src_obj)
    box = derive_keep_box(name)
    if box:
        print('  keep-box (OBJ frame) from %d nav nodes, margin %.1f m:' % (box['nodes'], box['margin']))
        print('    x[%.0f,%.0f] y[%.0f,%.0f] z[%.0f,%.0f]' % (
            box['lo'][0], box['hi'][0], box['lo'][1], box['hi'][1], box['lo'][2], box['hi'][2]))
    else:
        print('  no NAV data — keeping all faces (no isolation)')

    out, kept_mats, kept, dropped, kept_idx = isolate(name, V, lines, box)
    print('  isolation: kept %d faces, dropped %d (%d play materials)' % (kept, dropped, len([m for m in kept_mats if m])))
    if kept_idx:
        xs = [V[i][0] for f in kept_idx for i in f]
        ys = [V[i][1] for f in kept_idx for i in f]
        zs = [V[i][2] for f in kept_idx for i in f]
        print('  play OBJ bounds: x[%.0f,%.0f] y[%.0f,%.0f] z[%.0f,%.0f]' % (
            min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))

    if not dry:
        open(os.path.join(out_dir, name + '.obj'), 'w').write('\n'.join(out) + '\n')

    conv, reused, missing = convert_textures(name, src_mtl, kept_mats, out_dir, out_tex, dry)
    print('  textures: %d converted, %d reused%s' % (conv, reused, (', MISSING %d: %s' % (len(missing), missing[:6])) if missing else ''))

    if not dry:
        if os.path.exists(src_lights):
            shutil.copyfile(src_lights, os.path.join(out_dir, name + '.lights.json'))
            print('  lights: copied %s.lights.json' % name)
        else:
            print('  lights: WARNING no sidecar at %s' % src_lights)

    if not dry:
        emit_record(name, kept, dropped, box)
    print('  done -> %s' % out_dir)


if __name__ == '__main__':
    main()
