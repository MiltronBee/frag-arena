#!/usr/bin/env bash
# Dev supervisor for the map rotation. The game server exits 0 at the end of the
# MATCH_END intermission (server/serverMain.js onMatchCycle) so the NEXT process
# boots the next rotation map — production pm2 handles that via autorestart; this
# loop is the local equivalent so `npm start` survives rotations.
#
#   exit 0  -> rotation restart: loop again onto the next map
#   nonzero -> real crash (or Ctrl-C, which lands here as 130): stop and propagate
set -u
cd "$(dirname "$0")/.."
while true; do
    npx tsx server/serverMain.js "$@"
    code=$?
    if [ "$code" -ne 0 ]; then
        echo "[serve-loop] server exited $code — stopping"
        exit "$code"
    fi
    echo "[serve-loop] clean exit (map rotation) — restarting"
done
