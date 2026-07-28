#!/usr/bin/env bash
# Deploy Degen Tournament from EchoPrime to production (zec-sol / degentournament.fun).
#
# Production is NOT a git checkout: it is a plain directory tree at
# /var/www/frag-arena that pm2 runs `tsx server/serverMain.js` out of. So the
# deploy is "build the client bundle here, rsync the source + built assets there,
# restart pm2". pm2 restart is REQUIRED here because server/ and common/ both changed.
#
# Deliberately NO --delete: prod owns files this tree does not (node_modules, .venv,
# .rotation-state.json, backups) and deleting them would take the site down.
set -euo pipefail

# The SSH TARGET stays on the old hostname on purpose, even though the site is now
# served as degentournament.fun. Both names resolve to the same box, but the host key is
# recorded against this one — pointing this at degentournament.fun fails BatchMode with
# "Host key verification failed" and breaks every deploy. Public URLs moved; this is
# plumbing, and it is not worth a broken deploy to make it match.
REMOTE=root@sol-pkmn.fun
DEST=/var/www/frag-arena
cd "$(dirname "$0")/.."

echo "=== 1/4 build (vite + stamp-build for the cache-busting query strings) ==="
# stamp-build is not optional: index.html references css/js with ?v=<BUILD_ID>, and
# the CSS changed this deploy — without a fresh stamp, browsers keep the cached
# stylesheet and the new post-match overlay renders unstyled.
npm run build

echo
echo "=== 2/4 confirm the stamp moved ==="
grep -oE 'styles-v0\.0\.1\.css\?v=[^"]+' public/index.html | head -1
grep -oE 'app-v0\.0\.1\.js\?v=[^"]+' public/index.html | head -1

echo
echo "=== 3/4 rsync to $REMOTE:$DEST ==="
rsync -az --info=stats1 \
  --exclude '.git' --exclude 'node_modules' --exclude '.venv' \
  --exclude '_work' --exclude 'scratch' --exclude '.rotation-state.json' \
  --exclude '*.map' \
  client common server public scripts package.json \
  "$REMOTE:$DEST/"

echo
echo "=== 4/4 pm2 restart (server/ and common/ changed) ==="
ssh -o BatchMode=yes "$REMOTE" "cd $DEST && pm2 restart frag-arena && sleep 6 && pm2 list | grep -E 'name|frag-arena'"

echo
echo "=== post-deploy check ==="
ssh -o BatchMode=yes "$REMOTE" "curl -sS --max-time 10 http://127.0.0.1:8078/mapinfo | head -c 400; echo"
echo "done."
