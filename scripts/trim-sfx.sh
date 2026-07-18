#!/usr/bin/env bash
# Post-process the ElevenLabs clips in public/assets/sfx/ (run AFTER generate-sfx.mjs):
#  1. strip leading silence from every clip — any leading pad reads as input lag,
#     the transient must sit at t=0 (WeaponAudio starts clips at currentTime).
#  2. hard-cap the FIRE clips + weapon_swap with a short fade-out. Long tails were
#     the "sounds queue up" complaint: at automatic fire rates 0.5-0.8s clips
#     overlap 4-5 deep and smear. The synth sub-thump layer supplies the low tail.
# Idempotent: re-running re-trims already-trimmed files (a no-op musically).
set -euo pipefail
cd "$(dirname "$0")/../public/assets/sfx"

trim() { # trim <file> [cap_seconds]
  local f=$1 cap=${2:-}
  local af="silenceremove=start_periods=1:start_threshold=-40dB"
  if [ -n "$cap" ]; then
    # slow 0.25s fade into the cap (audition feedback: the old hard 0.04s fade at
    # 0.35s amputated the tail that makes a shot read as a gunshot)
    local fade_st
    fade_st=$(awk "BEGIN{print $cap-0.25}")
    af="$af,atrim=0:$cap,afade=t=out:st=$fade_st:d=0.25"
  fi
  ffmpeg -v error -y -i "$f" -af "$af" -codec:a libmp3lame -q:a 4 "_t_$f"
  mv "_t_$f" "$f"
}

# fire clips: capped but breathing (0.55s keeps the shot's tail; overlap at auto
# rates is handled by the limiter bus + the 0.25s fade above)
for g in rifle smg pistol plasma; do trim "${g}_fire.mp3" 0.55; done
trim shotgun_fire.mp3 0.7
trim flak_fire.mp3 0.7
trim weapon_swap.mp3 0.45

# everything else: leading-silence strip only (their tails/timing are content)
for f in rifle_reload smg_reload shotgun_reload pistol_reload plasma_reload flak_reload \
         grenade_explosion death respawn impact_flesh pain_grunt kill_confirm; do
  trim "$f.mp3"
done

echo "trimmed. durations:"
for f in *.mp3; do
  printf '%-22s %ss\n' "$f" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
done
