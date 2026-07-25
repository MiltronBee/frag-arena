#!/usr/bin/env bash
# Post-process the ElevenLabs VARIANT clips written by scripts/generate-sfx-variants.mjs.
# Mirrors scripts/trim-sfx.sh exactly, but globs the _v<N> takes so a variant is
# processed identically to the base clip it substitutes for:
#   1. strip leading silence — WeaponAudio starts clips at ctx.currentTime with no
#      offset, so ANY leading pad reads as input lag on a gunshot.
#   2. hard-cap the FIRE clips + weapon_swap with a slow 0.25s fade. Long tails are
#      what made automatic fire "queue up" and smear when clips overlap 4-5 deep;
#      the synth sub-thump layer in WeaponAudio supplies the low tail instead.
# Idempotent: re-running re-trims already-trimmed files (musically a no-op).
set -euo pipefail
cd "$(dirname "$0")/../public/assets/sfx"

trim() { # trim <file> [cap_seconds]
  local f=$1 cap=${2:-}
  [ -f "$f" ] || return 0   # variant not generated (or its fetch failed) — skip
  local af="silenceremove=start_periods=1:start_threshold=-40dB"
  if [ -n "$cap" ]; then
    local fade_st
    fade_st=$(awk "BEGIN{print $cap-0.25}")
    af="$af,atrim=0:$cap,afade=t=out:st=$fade_st:d=0.25"
  fi
  ffmpeg -v error -y -i "$f" -af "$af" -codec:a libmp3lame -q:a 4 "_t_$f"
  mv "_t_$f" "$f"
  echo "trimmed $f${cap:+ (cap ${cap}s)}"
}

# FIRE variants: capped but breathing, same caps as the base clips in trim-sfx.sh
for g in rifle smg pistol plasma; do
  for v in "${g}"_fire_v*.mp3; do [ -e "$v" ] && trim "$v" 0.55; done
done
for g in shotgun flak; do
  for v in "${g}"_fire_v*.mp3; do [ -e "$v" ] && trim "$v" 0.7; done
done

# weapon_swap variants: capped like the base
for v in weapon_swap_v*.mp3; do [ -e "$v" ] && trim "$v" 0.55; done

# everything else: leading-silence strip only (their tails ARE the sound)
for v in impact_flesh_v*.mp3 pain_grunt_v*.mp3 death_v*.mp3 \
         kill_confirm_v*.mp3 grenade_explosion_v*.mp3; do
  [ -e "$v" ] && trim "$v"
done

echo "variant trim complete."
