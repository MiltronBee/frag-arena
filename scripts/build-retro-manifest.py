#!/usr/bin/env python3
"""Build the machine-readable source manifest for the staged Retro Weapon Pack arms.

Reads the archive central directory (authoritative uncompressed size + CRC-32) and
the extracted tree under _incoming/retro/original-pack/, classifies every staged file
against scripts/retro-clip-mapping.json, and writes source-manifest.json next to the
extracted files. Deterministic: entries are sorted by archive path and no timestamps
are emitted, so a re-run over the same archive+tree reproduces the file byte-for-byte.

This tool NEVER writes GLBs and does not need Blender.

    usage: python3 scripts/build-retro-manifest.py
           [--zip PATH] [--root DIR] [--mapping PATH] [--out PATH] [--check-only]
"""
import argparse, json, os, re, sys, zipfile, zlib, hashlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ZIP = "/home/miltron/Downloads/RetroWeaponPack_V1.zip"
DEFAULT_ROOT = os.path.join(REPO, "_incoming", "retro", "original-pack")
DEFAULT_MAPPING = os.path.join(REPO, "scripts", "retro-clip-mapping.json")

# Only these archive subtrees are staged (the four weapons' FP arms + gun sources).
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


def build_resolution(mapping):
    """(weapon, category, source) -> semantic, plus the reverse for reporting.

    Applies per-weapon spelling overrides and segmented-reload expansion so the
    lookup reflects the real on-disk filenames. Raises on any collision (two
    semantics claiming the same source for one weapon) -- that is a mapping bug.
    """
    weapons = mapping["weapons"]
    res = {}  # (weapon, category, source) -> semantic
    for sem, spec in mapping["semanticClips"].items():
        seg = spec.get("segmented")
        spelling = spec.get("spelling", {})
        for w in weapons:
            if seg and w in seg["weapons"]:
                pairs = [(seg["category"], s) for s in seg["sources"]]
            else:
                src = spelling.get(w, spec["source"])
                pairs = [(spec["category"], src)]
            for cat, src in pairs:
                key = (w, cat, src)
                if key in res and res[key] != sem:
                    raise SystemExit(
                        f"mapping collision: {key} -> {res[key]} and {sem}")
                res[key] = sem
    return res


ARMS_ANIM = re.compile(
    r"Assets/RetroWeaponsPack/FP_Arms/FBX_Files/Animations/"
    r"(?P<weapon>\w+?)_01_Animations/(?P<category>\w+)/"
    r"FP_Arms_(?P=weapon)_01_(?P<clip>[\w]+)\.fbx$")
ANIM_BLEND = re.compile(r"/BlendFiles/FP_Arms_(?P<weapon>\w+?)_01_Anims\.blend(?P<bak>1)?$")
GUN_BLEND = re.compile(r"/Guns/(?P<weapon>\w+?)_01/BlendFile/(?P=weapon)_01\.blend(?P<bak>1)?$")
GUN_ANIM = re.compile(r"/Guns/(?P<weapon>\w+?)_01/Fbx_?Files/Animations/(?P=weapon)_01_(?P<clip>\w+)\.fbx$")
GUN_ADDL = re.compile(r"/Guns/(?P<weapon>\w+?)_01/Fbx_?Files/(?P=weapon)_01_AdditionalMeshes\.fbx$")
GUN_MESH = re.compile(r"/Guns/(?P<weapon>\w+?)_01/Fbx_?Files/(?P=weapon)_01\.fbx$")
GUN_TEX = re.compile(r"/Guns/(?P<weapon>\w+?)_01/Textures/(?P=weapon)_01_(?P<which>Albedo|silhouette)\.png$")


def classify(archive_path, mapping, resolution):
    """Return dict(kind, weapon, category, clipToken, semantic, quirk)."""
    d = {"kind": None, "weapon": None, "category": None,
         "clipToken": None, "semantic": None, "quirk": None}
    m = ARMS_ANIM.match(archive_path)
    if m:
        w, cat, clip = m["weapon"], m["category"], m["clip"]
        d.update(kind="arms_anim", weapon=w, category=cat, clipToken=clip,
                 semantic=resolution.get((w, cat, clip)))
        seg = mapping["semanticClips"]["reload"].get("segmented", {})
        spell = mapping["semanticClips"]["interact"].get("spelling", {})
        if clip in seg.get("sources", []):
            d["quirk"] = "segmented-reload segment (%s)" % clip
        elif spell.get(w) == clip:
            d["quirk"] = "spelling: '%s' vs canonical '%s'" % (
                clip, mapping["semanticClips"]["interact"]["source"])
        if d["semantic"] is None:
            d["quirk"] = (d["quirk"] or "") + " [UNMAPPED clip token]"
        return d
    if archive_path.endswith("/FBX_Files/FP_Arms.fbx"):
        return {**d, "kind": "arms_mesh"}
    if archive_path.endswith("/BlendFiles/FP_Arms.blend"):
        return {**d, "kind": "arms_blend_base"}
    if archive_path.endswith("/BlendFiles/FP_Arms.blend1"):
        return {**d, "kind": "arms_blend_base_backup"}
    if archive_path.endswith("/Texture/FPS_Arms_Albedo.png"):
        return {**d, "kind": "arms_texture"}
    for rx, kind in ((ANIM_BLEND, "anim_blend"), (GUN_BLEND, "gun_blend")):
        m = rx.search(archive_path)
        if m:
            k = kind + ("_backup" if m["bak"] else "")
            return {**d, "kind": k, "weapon": m["weapon"]}
    m = GUN_ADDL.search(archive_path)
    if m:
        return {**d, "kind": "gun_additional_mesh", "weapon": m["weapon"]}
    m = GUN_ANIM.search(archive_path)
    if m:
        return {**d, "kind": "gun_anim", "weapon": m["weapon"], "clipToken": m["clip"]}
    m = GUN_MESH.search(archive_path)
    if m:
        return {**d, "kind": "gun_mesh", "weapon": m["weapon"]}
    m = GUN_TEX.search(archive_path)
    if m:
        return {**d, "kind": "gun_" + ("silhouette" if m["which"] == "silhouette" else "texture"),
                "weapon": m["weapon"]}
    return d  # kind stays None -> flagged below


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default=DEFAULT_ZIP)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--mapping", default=DEFAULT_MAPPING)
    ap.add_argument("--out", default=None)
    ap.add_argument("--check-only", action="store_true",
                    help="validate archive<->tree consistency but do not write the manifest")
    args = ap.parse_args()
    out = args.out or os.path.join(args.root, "source-manifest.json")

    with open(args.mapping) as f:
        mapping = json.load(f)
    resolution = build_resolution(mapping)

    if not os.path.isdir(args.root):
        sys.exit("extract root not found: %s (run the extraction first)" % args.root)

    zf = zipfile.ZipFile(args.zip)
    entries = [i for i in zf.infolist()
               if not i.is_dir() and i.filename.startswith(INCLUDE_PREFIXES)]
    entries.sort(key=lambda i: i.filename)

    files, problems = [], []
    counts_kind, counts_sem = {}, {}
    for info in entries:
        ap_ = info.filename
        local = os.path.join(args.root, ap_)
        rec = {
            "archivePath": ap_,
            "localPath": os.path.relpath(local, REPO),
            "bytes": info.file_size,
            "archiveCrc32": "%08x" % info.CRC,
        }
        if not os.path.isfile(local):
            rec["status"] = "MISSING_ON_DISK"
            problems.append("missing on disk: %s" % ap_)
            files.append({**rec, **classify(ap_, mapping, resolution)})
            continue
        size = os.path.getsize(local)
        crc = crc32_of(local)
        rec["sha256"] = sha256_of(local)
        ok = (size == info.file_size) and (crc == info.CRC)
        rec["status"] = "ok" if ok else "MISMATCH"
        if not ok:
            problems.append("size/crc mismatch: %s (disk %d/%08x vs archive %d/%08x)"
                            % (ap_, size, crc, info.file_size, info.CRC))
        rec.update(classify(ap_, mapping, resolution))
        files.append(rec)
        counts_kind[rec["kind"]] = counts_kind.get(rec["kind"], 0) + 1
        if rec.get("semantic"):
            counts_sem[rec["semantic"]] = counts_sem.get(rec["semantic"], 0) + 1

    unmapped = [f["archivePath"] for f in files if f["kind"] is None]
    for u in unmapped:
        problems.append("unclassified file: %s" % u)

    manifest = {
        "schema": "retro-source-manifest/v1",
        "pack": mapping.get("pack"),
        "archive": os.path.abspath(args.zip),
        "archiveBytes": os.path.getsize(args.zip),
        "extractRoot": os.path.relpath(args.root, REPO),
        "mapping": os.path.relpath(args.mapping, REPO),
        "mappingSha256": sha256_of(args.mapping),
        "generatedBy": "scripts/build-retro-manifest.py",
        "quirks": mapping.get("quirks", []),
        "counts": {
            "files": len(files),
            "byKind": dict(sorted(counts_kind.items())),
            "bySemantic": dict(sorted(counts_sem.items())),
        },
        "files": files,
    }

    print("build-retro-manifest: %d staged files, %d problem(s)" % (len(files), len(problems)))
    for p in problems:
        print("  ! " + p)
    if args.check_only:
        print("check-only: manifest NOT written")
        return 0 if not problems else 1

    with open(out, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=False)
        f.write("\n")
    print("wrote %s" % os.path.relpath(out, REPO))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
