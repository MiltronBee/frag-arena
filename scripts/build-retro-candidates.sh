#!/usr/bin/env bash
# Deterministically rebuild the four candidate first-person weapon GLBs from the
# staged Retro Weapon Pack, driven by scripts/retro-blend-actions.json.
#
# Writes to /tmp/frag-retro-candidates by default (NOT public/assets/weapons -- these
# are review candidates, not integrated runtime assets). Read-only w.r.t. the repo and
# the staged pack; only the output dir is written.
#
#   usage: scripts/build-retro-candidates.sh [OUTDIR] [WEAPON ...]
#          BLENDER=/path/to/blender scripts/build-retro-candidates.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BLENDER="${BLENDER:-/home/miltron/.local/bin/blender}"
PACK="$REPO/_incoming/retro/original-pack/Assets/RetroWeaponsPack"
MAP="$REPO/scripts/retro-blend-actions.json"
EXPORTER="$REPO/scripts/blend-to-gltf.blender.py"

OUTDIR="${1:-/tmp/frag-retro-candidates}"
shift || true
WEAPONS=("$@")
if [ "${#WEAPONS[@]}" -eq 0 ]; then
  WEAPONS=(Rifle Pistol Shotgun SMG)
fi

command -v "$BLENDER" >/dev/null 2>&1 || { echo "blender not found at $BLENDER (set BLENDER=)"; exit 2; }
[ -f "$MAP" ] || { echo "mapping not found: $MAP"; exit 2; }
mkdir -p "$OUTDIR"

# lowercase weapon token for the output filename, matching public/assets/weapons/*
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

echo "== build-retro-candidates =="
echo "blender : $($BLENDER --version 2>/dev/null | head -1)"
echo "mapping : ${MAP#$REPO/}"
echo "outdir  : $OUTDIR"
echo

rc=0
for W in "${WEAPONS[@]}"; do
  w="$(lower "$W")"
  ANIMS="$PACK/FP_Arms/BlendFiles/FP_Arms_${W}_01_Anims.blend"
  GUN="$PACK/Guns/${W}_01/BlendFile/${W}_01.blend"
  ARMS_TEX="$PACK/FP_Arms/Texture/FPS_Arms_Albedo.png"
  GUN_TEX="$PACK/Guns/${W}_01/Textures/${W}_01_Albedo.png"
  OUT="$OUTDIR/retro_${w}_arms.glb"
  LOG="$OUTDIR/retro_${w}_arms.build.log"

  for f in "$ANIMS" "$GUN" "$ARMS_TEX" "$GUN_TEX"; do
    [ -f "$f" ] || { echo "!! missing source for $W: $f"; rc=1; continue 2; }
  done

  echo "-- $W -> ${OUT}"
  if "$BLENDER" --background --factory-startup --python "$EXPORTER" -- \
        "$ANIMS" "$GUN" "$ARMS_TEX" "$GUN_TEX" "$OUT" "$MAP" "$W" >"$LOG" 2>&1; then
    grep -E '^\+\+|^CHECK|^scene fps|^exporting animations|^WROTE|padded|MISSING|WARN' "$LOG" | sed 's/^/   /' || true
  else
    echo "   BUILD FAILED (see $LOG):"; tail -20 "$LOG" | sed 's/^/   /'; rc=1; continue
  fi
  if [ -f "$OUT" ]; then
    sz=$(stat -c%s "$OUT"); sha=$(sha256sum "$OUT" | cut -c1-16)
    printf '   OK  %s  %d bytes  sha256:%s...\n\n' "$(basename "$OUT")" "$sz" "$sha"
  else
    echo "   !! no output produced"; rc=1
  fi
done

echo "== done (rc=$rc) =="
exit $rc
