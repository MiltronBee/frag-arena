#!/usr/bin/env python3
# Generate public/dev/textures.html — a browser page of every texture the live
# mesh map uses: tiled preview + 1x swatch, material name, face coverage (from the
# OBJ), dimensions, file size. If Gemini remaster candidates exist under
# public/dev/tex-candidates/<material>/, they render side-by-side with the
# original for comparison. Re-run after any texture/candidate change.
import os, re, json
from PIL import Image

ROOT = os.path.expanduser('~/unreal')
MAPDIR = os.path.join(ROOT, 'public/assets/maps/DM-W-Grove')
OBJ = os.path.join(MAPDIR, 'DM-W-Grove-2025.obj')
MTL = os.path.join(MAPDIR, 'DM-W-Grove-2025.mtl')
CAND = os.path.join(ROOT, 'public/dev/tex-candidates')
OUT = os.path.join(ROOT, 'public/dev/textures.html')

# material -> texture path (relative to map dir)
mats = {}
cur = None
for line in open(MTL):
    if line.startswith('newmtl '): cur = line.split(None, 1)[1].strip()
    elif line.startswith('map_Kd ') and cur: mats[cur] = line.split(None, 1)[1].strip()

# face counts per material
faces = {}
cur = None
for line in open(OBJ):
    if line.startswith('usemtl '): cur = line.split(None, 1)[1].strip()
    elif line.startswith('f ') and cur: faces[cur] = faces.get(cur, 0) + 1

rows = []
for mat, rel in mats.items():
    p = os.path.join(MAPDIR, rel)
    w, h = Image.open(p).size
    kb = os.path.getsize(p) / 1024
    cands = []
    cdir = os.path.join(CAND, mat)
    if os.path.isdir(cdir):
        cands = sorted(f for f in os.listdir(cdir) if f.lower().endswith(('.png', '.webp', '.jpg')))
    rows.append({'mat': mat, 'src': f'/assets/maps/DM-W-Grove/{rel}', 'faces': faces.get(mat, 0),
                 'w': w, 'h': h, 'kb': round(kb, 1), 'cands': [f'/dev/tex-candidates/{mat}/{c}' for c in cands]})
rows.sort(key=lambda r: -r['faces'])
total_faces = sum(r['faces'] for r in rows)

cards = []
for r in rows:
    pct = 100.0 * r['faces'] / total_faces if total_faces else 0
    cand_html = ''
    if r['cands']:
        thumbs = ''.join(
            f'<figure><img loading="lazy" src="{c}" title="{os.path.basename(c)}">'
            f'<figcaption>{os.path.basename(c).rsplit(".",1)[0]}</figcaption></figure>' for c in r['cands'])
        cand_html = f'<div class="cands"><figure class="orig"><img loading="lazy" src="{r["src"]}"><figcaption>original</figcaption></figure>{thumbs}</div>'
    cards.append(f'''<div class="card" id="{r['mat']}">
  <div class="tile" style="background-image:url('{r['src']}')"></div>
  <img class="one" loading="lazy" src="{r['src']}">
  <div class="meta"><b>{r['mat']}</b><span>{r['faces']} faces ({pct:.1f}%) &middot; {r['w']}&times;{r['h']} &middot; {r['kb']}KB</span></div>
  {cand_html}
</div>''')

html = f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM-W-Grove textures ({len(rows)})</title><style>
body{{background:#101018;color:#cfd3e0;font:14px/1.45 'Segoe UI',system-ui,sans-serif;margin:0;padding:24px}}
h1{{font-size:20px;letter-spacing:.12em;text-transform:uppercase;color:#e8ecf8}}
p.sub{{color:#8a90a5;margin-top:-8px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}}
.card{{background:#181826;border:1px solid #262638;border-radius:8px;overflow:hidden}}
.tile{{height:150px;background-size:96px 96px;background-repeat:repeat;image-rendering:pixelated}}
.one{{width:96px;height:96px;object-fit:cover;image-rendering:pixelated;border:1px solid #262638;margin:8px 0 0 8px;background:
  repeating-conic-gradient(#222 0% 25%, #333 0% 50%) 0 0/16px 16px}}
.meta{{padding:8px 10px 12px}} .meta b{{display:block;color:#f0f2fa;word-break:break-all}} .meta span{{color:#8a90a5;font-size:12px}}
.cands{{display:flex;flex-wrap:wrap;gap:6px;padding:0 8px 10px;border-top:1px dashed #2c2c40;margin-top:4px;padding-top:8px}}
.cands figure{{margin:0;text-align:center}} .cands img{{width:128px;height:128px;object-fit:cover;border:1px solid #37374e;border-radius:4px}}
.cands .orig img{{border-color:#6a6a90}} .cands figcaption{{font-size:11px;color:#8a90a5;margin-top:2px}}
</style></head><body>
<h1>DM-W-Grove texture set</h1>
<p class="sub">{len(rows)} materials &middot; sorted by face coverage &middot; top strip = tiled at 96px, small swatch = raw. Remaster candidates (if any) appear under each card.</p>
<div class="grid">{''.join(cards)}</div>
</body></html>'''

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(html)
print(f'wrote {OUT}: {len(rows)} materials, {sum(1 for r in rows if r["cands"])} with candidates')
