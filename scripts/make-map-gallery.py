#!/usr/bin/env python3
"""Generate a texture-triage page for one mesh map.

Sibling of make-texture-gallery.py (which is hardcoded to DM-W-Grove). This one
takes the map name and writes a standalone page meant to be served from prod at
/textures/ — it references LIVE prod asset URLs, so deploying is one HTML file,
no asset upload.

Beyond the Grove gallery it adds the three things the 1999->2026 triage needs:
  - HD source dims: maps/improved/textures_hd/ still holds the pre-downsample
    source. Where that is bigger than what shipped, re-shipping is free quality.
  - world zone: which end of the map the material actually appears in, from the
    OBJ face positions. "is this worth remastering" depends on whether players
    ever stand near it.
  - a triage picker (keep / remaster / replace) persisted to localStorage with a
    JSON export, so a pass through the page produces a decision list.

Usage: python3 scripts/make-map-gallery.py [visage|grove]
"""
import os, sys, json, glob
from PIL import Image

ROOT = os.path.expanduser('~/unreal')

MAPS = {
    'visage': {
        'dir': 'public/assets/maps/CTF-Visage',
        'obj': 'CTF-Visage.obj', 'mtl': 'CTF-Visage.mtl',
        'title': 'CTF-Visage', 'scale': 0.65,
        # x extent splits the two Facing-Worlds towers; see the CTF_Crypt_C
        # team markers at x~-71 (red) and x~+4 (blue).
        'zones': [(-1e9, -60, 'West tower / Red'), (-60, -5, 'Midfield'), (-5, 1e9, 'East tower / Blue')],
    },
    'grove': {
        'dir': 'public/assets/maps/DM-W-Grove',
        'obj': 'DM-W-Grove-2025.obj', 'mtl': 'DM-W-Grove-2025.mtl',
        'title': 'DM-W-Grove', 'scale': 0.65,
        'zones': [(-1e9, 1e9, '')],
    },
}

name = sys.argv[1] if len(sys.argv) > 1 else 'visage'
M = MAPS[name]
MAPDIR = os.path.join(ROOT, M['dir'])
HD = os.path.join(ROOT, 'maps/improved/textures_hd')
OUT = os.path.join(ROOT, 'public/textures/index.html')
URLBASE = '/' + M['dir'].split('public/', 1)[1]

# --- material -> texture file
mats, cur = {}, None
for line in open(os.path.join(MAPDIR, M['mtl'])):
    if line.startswith('newmtl '):
        cur = line.split(None, 1)[1].strip()
    elif line.startswith('map_Kd ') and cur:
        mats[cur] = line.split(None, 1)[1].strip()

# --- face counts + world bbox per material.
# native -> world is rotX(-90) => (x, z, -y), legacy OBJ loader flips x, then scale.
S = M['scale']
verts, faces, bbox, cur = [], {}, {}, None
for line in open(os.path.join(MAPDIR, M['obj']), errors='replace'):
    if line.startswith('v '):
        p = line.split()
        verts.append((float(p[1]), float(p[2]), float(p[3])))
    elif line.startswith('usemtl '):
        cur = line.split(None, 1)[1].strip()
    elif line.startswith('f ') and cur:
        faces[cur] = faces.get(cur, 0) + 1
        for tok in line.split()[1:]:
            i = int(tok.split('/')[0])
            v = verts[i - 1] if i > 0 else verts[i]
            w = (-v[0] * S, v[2] * S, -v[1] * S)
            b = bbox.setdefault(cur, [list(w), list(w)])
            for k in range(3):
                b[0][k] = min(b[0][k], w[k])
                b[1][k] = max(b[1][k], w[k])


def zone_of(mat):
    b = bbox.get(mat)
    if not b:
        return '-'
    lo, hi = b[0][0], b[1][0]
    if hi - lo > 60:
        return 'Spans map'
    cx = (lo + hi) / 2
    for a, z, label in M['zones']:
        if a <= cx < z:
            return label
    return '-'


def dominant(im):
    """Average color, as a cheap 'what hue is this' cue for team-color work."""
    q = im.convert('RGB').resize((16, 16))
    px = list(q.getdata())
    n = len(px)
    return tuple(sum(c[i] for c in px) // n for i in range(3))


CANDS = os.path.join(ROOT, 'public/textures/candidates')


def candidates_for(mat):
    """Gemini replacement candidates, with a 512 WebP thumb built alongside.

    The full-res PNGs are ~600KB each; serving 14 of them raw makes the triage
    page a multi-megabyte load. Gallery shows the thumb, click opens the full
    file (which is what a promotion would actually downsample from).
    """
    d = os.path.join(CANDS, mat)
    if not os.path.isdir(d):
        return []
    out = []
    for f in sorted(os.listdir(d)):
        if not f.endswith('.png') or f.startswith('thumb-'):
            continue
        thumb = 'thumb-' + f.rsplit('.', 1)[0] + '.webp'
        tp = os.path.join(d, thumb)
        if not os.path.exists(tp) or os.path.getmtime(tp) < os.path.getmtime(os.path.join(d, f)):
            Image.open(os.path.join(d, f)).convert('RGB').resize((512, 512), Image.LANCZOS).save(tp, 'WEBP', quality=82)
        out.append({'name': f.rsplit('.', 1)[0],
                    'thumb': f'/textures/candidates/{mat}/{thumb}',
                    'full': f'/textures/candidates/{mat}/{f}'})
    return out


rows = []
for mat, rel in sorted(mats.items()):
    p = os.path.join(MAPDIR, rel)
    im = Image.open(p)
    w, h = im.size
    r, g, b = dominant(im)
    hd_dims = None
    cands = glob.glob(os.path.join(HD, mat + '.*'))
    if cands:
        try:
            hd_dims = Image.open(cands[0]).size
        except Exception:
            pass
    rows.append({
        'mat': mat, 'src': f'{URLBASE}/{rel}', 'faces': faces.get(mat, 0),
        'w': w, 'h': h, 'kb': round(os.path.getsize(p) / 1024, 1),
        'hd': list(hd_dims) if hd_dims else None,
        'upgrade': bool(hd_dims and (hd_dims[0] > w or hd_dims[1] > h)),
        'zone': zone_of(mat), 'rgb': [r, g, b],
        'team': 'R' if mat.endswith('-R') else ('B' if mat.endswith('-B') else ''),
        'cands': candidates_for(mat),
    })

rows.sort(key=lambda r: -r['faces'])
total = sum(r['faces'] for r in rows) or 1
for r in rows:
    r['pct'] = round(100.0 * r['faces'] / total, 1)

n_up = sum(1 for r in rows if r['upgrade'])
n_cand = sum(1 for r in rows if r['cands'])
data = json.dumps(rows)

html = f'''<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{M['title']} — texture triage</title>
<style>
:root{{--bg:#0b0d12;--card:#151823;--line:#242938;--dim:#7d8499;--fg:#e6e9f2;--accent:#14F195}}
*{{box-sizing:border-box}}
body{{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:20px}}
header{{position:sticky;top:0;background:linear-gradient(var(--bg) 78%,transparent);padding:8px 0 14px;z-index:9}}
h1{{font-size:19px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 2px}}
h1 em{{color:var(--accent);font-style:normal}}
.sub{{color:var(--dim);font-size:13px;margin:0 0 12px}}
.bar{{display:flex;flex-wrap:wrap;gap:8px;align-items:center}}
button{{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 11px;font:inherit;font-size:13px;cursor:pointer}}
button:hover{{border-color:var(--accent)}}
button.on{{border-color:var(--accent);color:var(--accent)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;display:flex;flex-direction:column}}
.card.hide{{display:none}}
.card[data-d=keep]{{border-color:#2f7d55}} .card[data-d=remaster]{{border-color:#8a6d2f}} .card[data-d=replace]{{border-color:#8a3f3f}}
.tile{{height:168px;background-repeat:repeat;image-rendering:pixelated;cursor:zoom-in;background-size:96px 96px}}
.tile.z2{{background-size:168px 168px}} .tile.z3{{background-size:336px 336px}}
.meta{{padding:9px 11px}}
.mat{{font-weight:600;word-break:break-all;font-size:13px;display:flex;align-items:center;gap:6px}}
.dot{{width:10px;height:10px;border-radius:50%;flex:none;border:1px solid #0006}}
.stats{{color:var(--dim);font-size:12px;margin-top:3px}}
.tag{{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);margin-right:4px}}
.tag.up{{color:var(--accent);border-color:#14f19555}}
.tag.team-R{{color:#ff6b6b;border-color:#ff6b6b55}} .tag.team-B{{color:#6bb6ff;border-color:#6bb6ff55}}
.picks{{display:flex;border-top:1px solid var(--line);margin-top:auto}}
.picks button{{flex:1;border:0;border-right:1px solid var(--line);border-radius:0;font-size:12px;padding:8px 0;color:var(--dim)}}
.picks button:last-child{{border-right:0}}
.picks button.sel{{color:var(--fg);background:#1e2230}}
.picks button[data-v=keep].sel{{color:#5ed69a}}
.picks button[data-v=remaster].sel{{color:#e0b45c}} .picks button[data-v=replace].sel{{color:#ff7a7a}}
.cands{{border-top:1px dashed #2c3145;padding:9px 11px;display:flex;flex-wrap:wrap;gap:7px}}
.cands figure{{margin:0;text-align:center;cursor:pointer;width:88px}}
.cands img{{width:88px;height:88px;object-fit:cover;border:2px solid #2b3042;border-radius:5px;display:block}}
.cands figure.chosen img{{border-color:var(--accent)}}
.cands figcaption{{font-size:10px;color:var(--dim);margin-top:3px;word-break:break-all;line-height:1.25}}
.cands figure.chosen figcaption{{color:var(--accent)}}
.cands a{{color:var(--dim);font-size:10px;text-decoration:none}}
#out{{width:100%;height:150px;margin-top:14px;background:#0e1016;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:8px;font:12px/1.4 ui-monospace,monospace;display:none}}
</style>
<header>
<h1>{M['title']} — <em>texture triage</em></h1>
<p class="sub">{len(rows)} materials &middot; sorted by face coverage &middot; <b>{n_up}</b> have a higher-res HD source on disk (free re-ship) &middot; <b>{n_cand}</b> have new Gemini candidates &mdash; click one to mark it as the pick &middot; click a tile to cycle tiling zoom</p>
<div class="bar">
  <button id="f-all" class="on">All</button>
  <button id="f-cand">New candidates ({n_cand})</button>
  <button id="f-up">HD upgrade available ({n_up})</button>
  <button id="f-team">Team markers</button>
  <button id="f-undec">Undecided</button>
  <span style="flex:1"></span>
  <span id="tally" class="sub" style="margin:0"></span>
  <button id="exp">Export decisions</button>
  <button id="clr">Reset</button>
</div>
<textarea id="out" readonly></textarea>
</header>
<div class="grid" id="grid"></div>
<script>
const ROWS = {data};
const KEY = 'triage-{name}';
const CKEY = 'triage-{name}-chosen';
let picks = JSON.parse(localStorage.getItem(KEY) || '{{}}');
// material -> candidate variant name the user picked to actually ship
let chosen = JSON.parse(localStorage.getItem(CKEY) || '{{}}');
const grid = document.getElementById('grid');

for (const r of ROWS) {{
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.mat = r.mat;
  if (picks[r.mat]) el.dataset.d = picks[r.mat];
  const hd = r.hd ? (r.upgrade ? `<span class="tag up">HD ${{r.hd[0]}}&times;${{r.hd[1]}}</span>` : '') : '<span class="tag">no HD source</span>';
  const team = r.team ? `<span class="tag team-${{r.team}}">TEAM ${{r.team === 'R' ? 'RED' : 'BLUE'}}</span>` : '';
  el.innerHTML = `
    <div class="tile" style="background-image:url('${{r.src}}')"></div>
    <div class="meta">
      <div class="mat"><span class="dot" style="background:rgb(${{r.rgb.join(',')}})"></span>${{r.mat}}</div>
      <div class="stats">${{r.faces}} faces (${{r.pct}}%) &middot; ${{r.w}}&times;${{r.h}} &middot; ${{r.kb}}KB &middot; ${{r.zone}}</div>
      <div class="stats" style="margin-top:5px">${{team}}${{hd}}</div>
    </div>
    <div class="picks">
      <button data-v="keep">keep</button>
      <button data-v="remaster">remaster</button>
      <button data-v="replace">replace</button>
    </div>
    ${{r.cands.length ? `<div class="cands">${{r.cands.map(c => `
      <figure data-cand="${{c.name}}" class="${{chosen[r.mat] === c.name ? 'chosen' : ''}}">
        <img loading="lazy" src="${{c.thumb}}">
        <figcaption>${{c.name}}</figcaption>
        <a href="${{c.full}}" target="_blank" onclick="event.stopPropagation()">full 1024 &#8599;</a>
      </figure>`).join('')}}</div>` : ''}}`;
  for (const fig of el.querySelectorAll('.cands figure')) {{
    fig.onclick = () => {{
      const n = fig.dataset.cand;
      if (chosen[r.mat] === n) delete chosen[r.mat]; else chosen[r.mat] = n;
      localStorage.setItem(CKEY, JSON.stringify(chosen));
      for (const f2 of el.querySelectorAll('.cands figure')) f2.classList.toggle('chosen', f2.dataset.cand === chosen[r.mat]);
    }};
  }}
  el.querySelector('.tile').onclick = e => {{
    const t = e.currentTarget;
    t.className = 'tile ' + (t.classList.contains('z2') ? 'z3' : t.classList.contains('z3') ? '' : 'z2');
  }};
  for (const b of el.querySelectorAll('.picks button')) {{
    b.onclick = () => {{
      const v = b.dataset.v;
      if (picks[r.mat] === v) delete picks[r.mat]; else picks[r.mat] = v;
      save(); paint(el, r);
    }};
  }}
  grid.appendChild(el);
  paint(el, r);
}}

function paint(el, r) {{
  const v = picks[r.mat];
  if (v) el.dataset.d = v; else delete el.dataset.d;
  for (const b of el.querySelectorAll('.picks button')) b.classList.toggle('sel', b.dataset.v === v);
}}
function save() {{
  localStorage.setItem(KEY, JSON.stringify(picks));
  const n = Object.keys(picks).length;
  document.getElementById('tally').textContent = `${{n}}/${{ROWS.length}} decided`;
}}
save();

let filter = 'all';
const FILTERS = {{
  all: () => true,
  up: r => r.upgrade,
  team: r => !!r.team,
  undec: r => !picks[r.mat],
  cand: r => r.cands.length > 0,
}};
function applyFilter() {{
  for (const el of grid.children) {{
    const r = ROWS.find(x => x.mat === el.dataset.mat);
    el.classList.toggle('hide', !FILTERS[filter](r));
  }}
}}
for (const id of ['all', 'cand', 'up', 'team', 'undec']) {{
  document.getElementById('f-' + id).onclick = e => {{
    filter = id;
    for (const b of document.querySelectorAll('.bar button')) b.classList.remove('on');
    e.currentTarget.classList.add('on');
    applyFilter();
  }};
}}
document.getElementById('exp').onclick = () => {{
  const out = document.getElementById('out');
  const by = {{keep: [], remaster: [], replace: []}};
  for (const [m, v] of Object.entries(picks)) by[v].push(m);
  out.style.display = 'block';
  out.value = JSON.stringify({{map: '{name}', decided: Object.keys(picks).length, total: ROWS.length, ...by, chosen}}, null, 2);
  out.select();
}};
document.getElementById('clr').onclick = () => {{
  if (!confirm('Clear all decisions?')) return;
  picks = {{}}; save();
  for (const el of grid.children) paint(el, ROWS.find(x => x.mat === el.dataset.mat));
  applyFilter();
}};
</script>'''

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(html)
print(f'wrote {OUT}')
print(f'  {len(rows)} materials, {n_up} with a bigger HD source')
print(f'  team markers: ' + ', '.join(r['mat'] for r in rows if r['team']))
