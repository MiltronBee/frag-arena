#!/usr/bin/env python3
"""Verify the Retro Weapon Pack source manifest, mapping, and staged tree.

Six checks, deterministic output, non-zero exit on any failure:
  [1] manifest is well-formed
  [2] every REQUIRED semantic clip resolves + is classified for all four weapons
      (idle/walk/run/fire/reload-or-segmented/draw/hide/interact)
  [3] the optional aim group is complete for every weapon
  [4] source hashes: on-disk sha256 + crc32 + size == manifest for every file
  [5] extraction matches archive metadata: manifest size + crc32 == the ZIP's
      own central directory (read independently here, not trusted from the manifest)
  [6] manifest <-> tree coverage: no orphan files, no phantom entries

    usage: python3 scripts/verify-retro-manifest.py [--manifest P] [--mapping P] [--zip P]
"""
import argparse, json, os, sys, zipfile, zlib, hashlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MANIFEST = os.path.join(REPO, "_incoming", "retro", "original-pack", "source-manifest.json")
DEFAULT_MAPPING = os.path.join(REPO, "scripts", "retro-clip-mapping.json")
ANIM_DIR = "Assets/RetroWeaponsPack/FP_Arms/FBX_Files/Animations"
INCLUDE_PREFIXES = (
    "Assets/RetroWeaponsPack/FP_Arms/",
    "Assets/RetroWeaponsPack/Guns/Pistol_01/",
    "Assets/RetroWeaponsPack/Guns/Rifle_01/",
    "Assets/RetroWeaponsPack/Guns/Shotgun_01/",
    "Assets/RetroWeaponsPack/Guns/SMG_01/",
)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def crc32_of(path):
    c = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            c = zlib.crc32(chunk, c)
    return c & 0xFFFFFFFF


def arms_path(weapon, category, source):
    return "%s/%s_01_Animations/%s/FP_Arms_%s_01_%s.fbx" % (ANIM_DIR, weapon, category, weapon, source)


def resolve(weapon, spec):
    """archivePaths a semantic maps to for this weapon (segmented reload -> many)."""
    seg = spec.get("segmented")
    if seg and weapon in seg["weapons"]:
        return [arms_path(weapon, seg["category"], s) for s in seg["sources"]]
    src = spec.get("spelling", {}).get(weapon, spec["source"])
    return [arms_path(weapon, spec["category"], src)]


class Checks:
    def __init__(self):
        self.rows, self.failures = [], 0

    def record(self, name, ok, detail=""):
        self.rows.append((name, ok, detail))
        if not ok:
            self.failures += 1

    def report(self):
        for name, ok, detail in self.rows:
            dots = "." * max(3, 44 - len(name))
            print("[%s] %s %s %s  %s" % (
                "x" if not ok else " ", name, dots, "PASS" if ok else "FAIL", detail))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--mapping", default=DEFAULT_MAPPING)
    ap.add_argument("--zip", default=None)
    args = ap.parse_args()

    if not os.path.isfile(args.manifest):
        sys.exit("manifest not found: %s (run build-retro-manifest.py first)" % args.manifest)
    with open(args.manifest) as f:
        man = json.load(f)
    with open(args.mapping) as f:
        mapping = json.load(f)
    weapons = mapping["weapons"]
    clips = mapping["semanticClips"]
    files = man["files"]
    by_path = {r["archivePath"]: r for r in files}

    print("RETRO WEAPON PACK -- MANIFEST & MAPPING VERIFICATION")
    print("manifest : %s (%d files)" % (os.path.relpath(args.manifest, REPO), len(files)))
    print("mapping  : %s (%s)" % (os.path.relpath(args.mapping, REPO), mapping["schema"]))
    zip_path = args.zip or man.get("archive")
    print("archive  : %s\n" % zip_path)

    c = Checks()

    # [1] manifest well-formed
    wf = (man.get("schema") == "retro-source-manifest/v1"
          and isinstance(files, list) and len(files) > 0
          and all({"archivePath", "localPath", "bytes", "archiveCrc32"} <= set(r) for r in files))
    c.record("manifest well-formed", wf, "%d entries" % len(files))

    # [2] required clip mappings for all four weapons
    required = [k for k, v in clips.items() if v.get("required")]
    req_needed = req_ok = 0
    req_missing = []
    for w in weapons:
        for sem in required:
            for p in resolve(w, clips[sem]):
                req_needed += 1
                rec = by_path.get(p)
                if rec and rec.get("semantic") == sem and rec.get("status") == "ok":
                    req_ok += 1
                else:
                    req_missing.append("%s/%s -> %s" % (w, sem, p))
    c.record("required clip mappings (4 weapons)", req_ok == req_needed,
             "%d/%d resolved (incl. shotgun segmented reload)" % (req_ok, req_needed))

    # [3] optional aim group complete
    aim = [k for k, v in clips.items() if v.get("group") == "aim"]
    aim_needed = aim_ok = 0
    aim_missing = []
    for w in weapons:
        for sem in aim:
            for p in resolve(w, clips[sem]):
                aim_needed += 1
                rec = by_path.get(p)
                if rec and rec.get("semantic") == sem:
                    aim_ok += 1
                else:
                    aim_missing.append("%s/%s" % (w, sem))
    c.record("optional aim group complete", aim_ok == aim_needed,
             "%d/%d aim clips across %d weapons" % (aim_ok, aim_needed, len(weapons)))

    # [4] source hashes (sha256 + crc32 + size) match manifest, recomputed on disk
    hash_ok = hash_total = 0
    hash_bad = []
    for r in files:
        local = os.path.join(REPO, r["localPath"])
        hash_total += 1
        if not os.path.isfile(local):
            hash_bad.append("missing: " + r["localPath"]); continue
        size = os.path.getsize(local)
        crc = "%08x" % crc32_of(local)
        sha = sha256_of(local)
        if size == r["bytes"] and crc == r["archiveCrc32"] and sha == r.get("sha256"):
            hash_ok += 1
        else:
            hash_bad.append("%s (size/crc/sha)" % r["archivePath"])
    c.record("source hashes (sha256+crc32+size)", hash_ok == hash_total,
             "%d/%d files" % (hash_ok, hash_total))

    # [5] extraction matches archive metadata (independent read of the ZIP)
    if zip_path and os.path.isfile(zip_path):
        zf = zipfile.ZipFile(zip_path)
        arc = {i.filename: i for i in zf.infolist() if not i.is_dir()}
        arc_ok = arc_total = 0
        arc_bad = []
        for r in files:
            arc_total += 1
            info = arc.get(r["archivePath"])
            if info and info.file_size == r["bytes"] and ("%08x" % info.CRC) == r["archiveCrc32"]:
                arc_ok += 1
            else:
                arc_bad.append(r["archivePath"])
        c.record("extraction matches archive metadata", arc_ok == arc_total,
                 "%d/%d vs archive central dir" % (arc_ok, arc_total))
    else:
        arc_bad = []
        c.record("extraction matches archive metadata", False,
                 "SKIPPED: archive not found at %s" % zip_path)

    # [6] manifest <-> tree coverage (no orphan files, no phantom entries)
    on_disk = set()
    root = os.path.join(REPO, man["extractRoot"])
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn == "source-manifest.json":
                continue
            rel = os.path.relpath(os.path.join(dp, fn), root)
            on_disk.add(rel.replace(os.sep, "/"))
    in_manifest = {r["archivePath"] for r in files}
    orphans = sorted(on_disk - in_manifest)
    phantoms = sorted(in_manifest - on_disk)
    c.record("manifest<->tree coverage", not orphans and not phantoms,
             "%d on disk, %d in manifest, %d orphan, %d phantom"
             % (len(on_disk), len(in_manifest), len(orphans), len(phantoms)))

    c.report()

    # detail on any failure
    for label, items in (("required missing", req_missing), ("aim missing", aim_missing),
                         ("hash mismatch", hash_bad), ("archive mismatch", arc_bad),
                         ("orphan files", orphans), ("phantom entries", phantoms)):
        if items:
            print("\n  %s (%d):" % (label, len(items)))
            for it in items[:20]:
                print("    - %s" % it)
            if len(items) > 20:
                print("    ... +%d more" % (len(items) - 20))

    # advisory: manifest provenance vs current mapping
    cur = sha256_of(args.mapping)
    if man.get("mappingSha256") and man["mappingSha256"] != cur:
        print("\n  advisory: manifest.mappingSha256 != current mapping "
              "(mapping edited since manifest build; regenerate to refresh classifications)")

    total = len(c.rows)
    print("\nRESULT: %s -- %d/%d checks passed, %d failure(s)"
          % ("PASS" if c.failures == 0 else "FAIL", total - c.failures, total, c.failures))
    return 0 if c.failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
