#!/usr/bin/env python3
"""Static audit: does common/mapRegistry.js faithfully carry the UT extraction?

Compares each live map record against its _work/ut-actors/<name>.actors.json source:
spawn points (count/position/yaw/team/y-provenance), pickups by category, teleporters,
jump pads. Anything present in the export but absent from the registry is a DROPPED
actor — the thing that makes a map feel empty or its spawns feel funky.
"""
import json, os, subprocess, sys

REPO = os.path.expanduser('~/unreal')
EXT = os.path.join(REPO, '_work/ut-actors')

# pull the live registry out of the ES module via tsx
dump = subprocess.run(
    ['npx', 'tsx', '-e', """
import { mapRecords, ROTATION, effectiveMode } from './common/mapRegistry'
const out = {}
for (const [id, m] of Object.entries(mapRecords)) {
  out[id] = { id, name: m.name, file: m.file, mode: m.mode, effMode: effectiveMode(m),
    scale: m.scale, killY: m.killY, walkable: m.walkable, mega: m.mega,
    spawns: m.spawns || null, SPAWN_POINTS: m.SPAWN_POINTS || null,
    PICKUPS: m.PICKUPS || null, TELEPORTERS: m.TELEPORTERS || null,
    JUMP_PADS: m.JUMP_PADS || null, MOVERS: m.MOVERS || null }
}
console.log('@@JSON@@' + JSON.stringify({ rotation: ROTATION.map(e => e.mapId), records: out }))
"""],
    cwd=REPO, capture_output=True, text=True)
if '@@JSON@@' not in dump.stdout:
    print(dump.stdout[-3000:]); print(dump.stderr[-3000:]); sys.exit(1)
data = json.loads(dump.stdout.split('@@JSON@@', 1)[1].splitlines()[0])
rotation, records = data['rotation'], data['records']

def find_export(rec):
    for cand in (rec.get('name'), (rec.get('file') or '').rsplit('.', 1)[0]):
        if not cand:
            continue
        p = os.path.join(EXT, cand + '.actors.json')
        if os.path.exists(p):
            return p
    return None

def approx(a, b, tol=0.02):
    return a is not None and b is not None and abs(a - b) <= tol

print('=' * 78)
print('STATIC AUDIT — UT export  ->  common/mapRegistry.js')
print('=' * 78)

for mid in rotation + [m for m in records if m not in rotation]:
    rec = records[mid]
    live = ' (LIVE)' if mid in rotation else ' (not in rotation)'
    path = find_export(rec)
    print('\n' + '-' * 78)
    print(f"{mid}  [{rec['name']}]  mode={rec['mode']}->{rec['effMode']}{live}")
    if not path:
        print('  !! NO EXTRACTION FILE FOUND — registry data has no upstream source to check')
        continue
    src = json.load(open(path))
    print(f"  export: {os.path.basename(path)}   source_map={src.get('source_map')}")

    # ---- spawn points ----
    esp, rsp = src.get('SPAWN_POINTS') or [], rec.get('SPAWN_POINTS') or []
    print(f"  SPAWN_POINTS   export={len(esp):3d}  registry={len(rsp):3d}", end='')
    if len(esp) != len(rsp):
        print(f"   ** COUNT MISMATCH (registry {'dropped' if len(rsp)<len(esp) else 'gained'} "
              f"{abs(len(esp)-len(rsp))}) **")
    else:
        print('   ok')
    if esp and rsp:
        # match by x/z, report y provenance
        ymatch_actor = ymatch_capsule = ymatch_neither = 0
        posbad, yawbad, teambad = [], [], []
        for i, e in enumerate(esp):
            r = next((r for r in rsp if approx(r.get('x'), e.get('x')) and approx(r.get('z'), e.get('z'))), None)
            if r is None:
                posbad.append(i); continue
            if approx(r.get('y'), e.get('y'), 0.02):
                ymatch_actor += 1
            elif approx(r.get('y'), e.get('y_capsule'), 0.02):
                ymatch_capsule += 1
            else:
                ymatch_neither += 1
            if e.get('yaw') is not None and not approx(r.get('yaw'), e.get('yaw'), 0.5):
                yawbad.append(i)
            if e.get('team') is not None and r.get('team') != e.get('team'):
                teambad.append(i)
        print(f"    y provenance: =actor_y {ymatch_actor}   =y_capsule {ymatch_capsule}   "
              f"=NEITHER {ymatch_neither}" + ('   ** y values are not from the export **' if ymatch_neither else ''))
        if posbad:
            print(f"    ** {len(posbad)} export spawn(s) have NO registry entry at that x/z: idx {posbad[:12]}")
        if yawbad:
            print(f"    ** {len(yawbad)} yaw mismatch(es): idx {yawbad[:12]}")
        if teambad:
            print(f"    -- {len(teambad)} team re-assignment(s) vs export (registry uses derived_2means): idx {teambad[:12]}")
        hr = [p.get('headroom') for p in rsp]
        if any(h is not None for h in hr):
            print(f"    headroom field: min={min(h for h in hr if h is not None):.2f} "
                  f"max={max(h for h in hr if h is not None):.2f}  "
                  f"(export has this field: {'yes' if any('headroom' in e for e in esp) else 'NO — added downstream'})")

    # ---- pickups ----
    ep, rp = src.get('PICKUPS') or {}, rec.get('PICKUPS') or {}
    cats = sorted(set(list(ep.keys()) + list(rp.keys())))
    if cats:
        parts, missing_total = [], 0
        for c in cats:
            ec, rc = len(ep.get(c) or []), len(rp.get(c) or [])
            flag = '' if ec == rc else f'!!'
            if ec > rc:
                missing_total += ec - rc
            parts.append(f"{c}:{ec}->{rc}{flag}")
        print(f"  PICKUPS        " + '  '.join(parts)
              + (f"   ** {missing_total} pickup(s) dropped **" if missing_total else '   ok'))

    # ---- teleporters / jump pads ----
    for key in ('TELEPORTERS', 'JUMP_PADS'):
        e, r = src.get(key), rec.get(key)
        ec = len(e) if isinstance(e, list) else None
        rc = len(r) if isinstance(r, list) else None
        if ec is None and rc is None:
            continue
        state = 'ok'
        if ec and not rc:
            state = f'** ALL {ec} DROPPED — registry has ' + ('empty list' if rc == 0 else 'no field') + ' **'
        elif ec != rc:
            state = f'** {ec}->{rc} mismatch **'
        elif ec == 0:
            state = '(none in source either)'
        print(f"  {key:<14} export={ec}  registry={rc}   {state}")

    # ---- movers: separate extraction ----
    mv = os.path.join(EXT, 'movers', (rec.get('name') or '') + '.movers.json')
    rmv = rec.get('MOVERS')
    rmvc = len(rmv) if isinstance(rmv, list) else (len(rmv) if isinstance(rmv, dict) else None)
    if os.path.exists(mv):
        try:
            mj = json.load(open(mv))
            mvc = len(mj) if isinstance(mj, list) else len(mj.get('movers', mj))
        except Exception:
            mvc = '?'
        state = 'ok' if rmvc == mvc else f'** {mvc} extracted, registry has {rmvc} **'
        print(f"  MOVERS         export={mvc}  registry={rmvc}   {state}")
    elif rmvc:
        print(f"  MOVERS         export=(no file)  registry={rmvc}")

    # ---- other required fields ----
    warn = []
    if not rec.get('mega'):
        warn.append('mega MISSING (mega-health falls back to box-arena position)')
    if rec.get('killY') is None:
        warn.append('killY MISSING')
    if not rec.get('walkable'):
        warn.append('walkable MISSING')
    if warn:
        print('  !! ' + '; '.join(warn))
print()
