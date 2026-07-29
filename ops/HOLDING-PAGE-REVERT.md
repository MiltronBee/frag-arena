# Holding page — how to revert (restore the game)

**Put up 2026-07-29** to fight coin-impersonation scammers: the live game index at
degentournament.fun was swapped for a "Launching soon on Pump.fun / Beware of fakes /
CA published here + on our X" holding page (`ops/holding-page.html`).

The **game was NOT deleted** — only `public/index.html` on prod was replaced. The game
bundle (`public/js/app-*.js`, css, assets) is untouched on prod, and the real game
`index.html` is in git and backed up on the server.

## What was changed on prod
- `root@sol-pkmn.fun:/var/www/frag-arena/public/index.html`  → the holding page
- Backup of the real game index saved at:
  `root@sol-pkmn.fun:/var/www/frag-arena/public/index.html.game-backup`

## TO REVERT (bring the game back) — two ways

**Fast (instant, no rebuild):** restore the backup on the server:
```bash
ssh root@sol-pkmn.fun "cp /var/www/frag-arena/public/index.html.game-backup /var/www/frag-arena/public/index.html"
```

**Clean (full redeploy, recommended for launch):** from the repo, run the normal deploy —
it rebuilds the real game index + assets and rsyncs them, fully restoring the game:
```bash
bash scripts/deploy-frag.sh
```

Either way, tell players to hard-reload (the holding page index may be briefly cached).

## ⚠ IMPORTANT while the holding page is up
- **Do NOT run `bash scripts/deploy-frag.sh`** for anything else — it rebuilds the game
  `index.html` and will REMOVE the holding page (that command IS the revert). This
  includes the pending **sniper scope V2** deploy — hold it until you're ready to bring
  the game back.
- To re-apply the holding page after any deploy:
  ```bash
  ssh root@sol-pkmn.fun "cp /var/www/frag-arena/public/index.html /var/www/frag-arena/public/index.html.game-backup"
  scp ops/holding-page.html root@sol-pkmn.fun:/var/www/frag-arena/public/index.html
  ```

## At launch
Either revert to the game (above) and post the real CA on X + in-game, or edit
`ops/holding-page.html` to show the real CA prominently and re-push it (the re-apply
commands above).

X link is wired: https://x.com/dgen_tournament (`.sources` block in ops/holding-page.html).
