#!/usr/bin/env python3
"""Read-only preflight for the Retro Weapon Pack arms -> runtime clip pipeline.

Resolves the intended source->runtime mapping for all four weapons, checks that
every REQUIRED semantic clip resolves to a staged source file, reports which
OPTIONAL clips are present, and flags missing or duplicate semantic mappings.
Deterministic output; exit 0 only when every required clip resolves for every
weapon. This is a DRY RUN: it never writes GLBs and never needs Blender.

Source of truth for presence is the manifest by default; pass --zip to resolve
directly against the archive central directory instead (no manifest needed).

    usage: python3 scripts/retro-preflight.py [--mapping P] [--manifest P] [--zip P]
"""
import argparse, json, os, sys, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MAPPING = os.path.join(REPO, "scripts", "retro-clip-mapping.json")
DEFAULT_MANIFEST = os.path.join(REPO, "_incoming", "retro", "original-pack", "source-manifest.json")
DEFAULT_ZIP = "/home/miltron/Downloads/RetroWeaponPack_V1.zip"
ANIM_DIR = "Assets/RetroWeaponsPack/FP_Arms/FBX_Files/Animations"
# The exact staged subtrees (mirrors build-retro-manifest.py) so --zip reports the
# same universe as the manifest -- excludes Guns/AdditionalMeshes/Projectiles etc.
INCLUDE_PREFIXES = (
    "Assets/RetroWeaponsPack/FP_Arms/",
    "Assets/RetroWeaponsPack/Guns/Pistol_01/",
    "Assets/RetroWeaponsPack/Guns/Rifle_01/",
    "Assets/RetroWeaponsPack/Guns/Shotgun_01/",
    "Assets/RetroWeaponsPack/Guns/SMG_01/",
)


def arms_path(weapon, category, filename):
    return "%s/%s_01_Animations/%s/%s" % (ANIM_DIR, weapon, category, filename)


def arms_file(weapon, source):
    return "FP_Arms_%s_01_%s.fbx" % (weapon, source)


def resolve(weapon, sem, spec):
    """List of (category, source, archivePath) the semantic maps to for this weapon,
    plus a bool for whether it is the segmented form."""
    seg = spec.get("segmented")
    if seg and weapon in seg["weapons"]:
        out = [(seg["category"], s, arms_path(weapon, seg["category"], arms_file(weapon, s)))
               for s in seg["sources"]]
        return out, True
    src = spec.get("spelling", {}).get(weapon, spec["source"])
    cat = spec["category"]
    return [(cat, src, arms_path(weapon, cat, arms_file(weapon, src)))], False


def load_present(args):
    """Return (present:set[archivePath], label:str)."""
    if args.zip:
        zf = zipfile.ZipFile(args.zip)
        present = {i.filename for i in zf.infolist()
                   if not i.is_dir() and i.filename.startswith(INCLUDE_PREFIXES)}
        return present, "archive %s (%d entries)" % (os.path.relpath(args.zip, REPO) if args.zip.startswith(REPO) else args.zip, len(present))
    with open(args.manifest) as f:
        man = json.load(f)
    present = {r["archivePath"] for r in man["files"]}
    return present, "manifest %s (%d files)" % (os.path.relpath(args.manifest, REPO), len(present))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", default=DEFAULT_MAPPING)
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--zip", default=None, help="resolve against the archive instead of the manifest")
    args = ap.parse_args()

    with open(args.mapping) as f:
        mapping = json.load(f)
    weapons = mapping["weapons"]
    clips = mapping["semanticClips"]
    present, src_label = load_present(args)

    print("RETRO WEAPON PACK -- SOURCE->RUNTIME PREFLIGHT (dry run; no GLB written)")
    print("mapping : %s (%s)" % (os.path.relpath(args.mapping, REPO), mapping["schema"]))
    print("source  : %s" % src_label)
    print("weapons : %s" % ", ".join(weapons))
    print("legend  : [rt=<key>] runtime anim consumed today; '-' = staged, not yet consumed")

    required = [k for k, v in clips.items() if v.get("required")]
    optional = [k for k, v in clips.items() if not v.get("required")]
    opt_groups = {}
    for k in optional:
        opt_groups.setdefault(clips[k].get("group", "other"), []).append(k)

    missing_required, missing_optional, duplicates = [], [], []
    per_weapon = {}

    for w in weapons:
        seen = {}  # archivePath -> [sem]  (duplicate detection)
        req_ok = 0
        opt_ok = 0
        lines = []
        for sem in required:
            files, segmented = resolve(w, sem, clips[sem])
            rt = clips[sem].get("runtime") or "-"
            hits = [(c, s, p, p in present) for (c, s, p) in files]
            for _, _, p, _ in hits:
                seen.setdefault(p, []).append(sem)
            all_ok = all(ok for *_, ok in hits)
            if all_ok:
                req_ok += 1
            else:
                for c, s, p, ok in hits:
                    if not ok:
                        missing_required.append((w, sem, p))
            if segmented:
                have = sum(1 for *_, ok in hits if ok)
                disp = "SEGMENTED %s (%d/%d)" % ("+".join(s for _, s, _, _ in hits), have, len(hits))
            else:
                c, s, p, ok = hits[0]
                disp = "%s/%s" % (c, arms_file(w, s))
            quirk = ""
            if clips[sem].get("spelling", {}).get(w):
                quirk = "  (quirk: spelling '%s')" % clips[sem]["spelling"][w]
            lines.append("    %-9s [rt=%-6s] %-52s %s%s"
                         % (sem, rt, disp, "ok" if all_ok else "MISSING", quirk))

        opt_lines = []
        for grp in sorted(opt_groups):
            g_have = 0
            parts = []
            for sem in opt_groups[grp]:
                files, _ = resolve(w, sem, clips[sem])
                ok = all(p in present for _, _, p in files)
                for _, _, p in files:
                    seen.setdefault(p, []).append(sem)
                if ok:
                    g_have += 1; opt_ok += 1
                else:
                    missing_optional.append((w, sem, files[0][2]))
                parts.append("%s %s" % (sem, "ok" if ok else "MISSING"))
            opt_lines.append("    %-9s (%d/%d): %s" % (grp, g_have, len(opt_groups[grp]), ", ".join(parts)))

        for p, sems in seen.items():
            uniq = sorted(set(sems))
            if len(uniq) > 1:
                duplicates.append((w, p, uniq))

        per_weapon[w] = (req_ok, len(required), opt_ok, len(optional),
                         "segmented(%d)" % len(resolve(w, "reload", clips["reload"])[0])
                         if resolve(w, "reload", clips["reload"])[1] else "single")

        print("\n-- %s %s" % (w, "-" * (52 - len(w))))
        print("  REQUIRED (%d/%d)" % (req_ok, len(required)))
        for ln in lines:
            print(ln)
        print("  OPTIONAL (%d/%d)" % (opt_ok, len(optional)))
        for ln in opt_lines:
            print(ln)

    # cross-check: staged arms-anim clips the mapping does not resolve (manifest mode only)
    unmapped = []
    if not args.zip:
        man = json.load(open(args.manifest))
        for r in man["files"]:
            if r["kind"] == "arms_anim" and not r.get("semantic"):
                unmapped.append(r["archivePath"])

    print("\nDIAGNOSTICS")
    print("  missing required          : %s" % ("none" if not missing_required else ""))
    for w, sem, p in missing_required:
        print("    - %s/%s -> %s" % (w, sem, p))
    print("  missing optional          : %s" % ("none" if not missing_optional else "%d (see below)" % len(missing_optional)))
    for w, sem, p in missing_optional:
        print("    - %s/%s -> %s" % (w, sem, p))
    print("  duplicate semantic mapping : %s" % ("none" if not duplicates else ""))
    for w, p, sems in duplicates:
        print("    - %s: %s claimed by %s" % (w, p, ", ".join(sems)))
    print("  unmapped staged clips      : %s" % ("none" if not unmapped else ""))
    for p in unmapped:
        print("    - %s" % p)

    print("\nSUMMARY")
    print("  %-8s %-9s %-9s %s" % ("weapon", "required", "optional", "reload"))
    for w in weapons:
        rq, rqt, op, opt, rl = per_weapon[w]
        print("  %-8s %-9s %-9s %s" % (w, "%d/%d" % (rq, rqt), "%d/%d" % (op, opt), rl))

    blockers = len(missing_required) + len(duplicates) + len(unmapped)
    ok = blockers == 0
    print("\nRESULT: %s -- required clips resolve for %d/%d weapons; %d blocker(s)"
          % ("PASS" if ok else "FAIL",
             sum(1 for w in weapons if per_weapon[w][0] == per_weapon[w][1]),
             len(weapons), blockers))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
