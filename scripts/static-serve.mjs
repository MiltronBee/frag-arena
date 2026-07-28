// Minimal static server for public/ — used by the browser verify harnesses.
//
// Why not `vite preview`: it serves dist/, and this project builds into public/js/ with
// publicDir:false, so preview 404s. Why not `python3 -m http.server`: it is single
// threaded, and this page pulls a few hundred textures in parallel — the queue backs up
// until Chrome starts failing requests with ERR_INSUFFICIENT_RESOURCES, which looks like
// a broken build rather than a broken test rig.
//
// Why not the vite DEV server: it serves ~1400 unbundled modules, and on software GL that
// is enough to wedge the page's main thread past any CDP protocol timeout. The harness
// needs the same single bundle prod serves.
import http from 'http'
import fs from 'fs'
import path from 'path'

const ROOT = process.argv[2] || 'public'
const PORT = Number(process.argv[3] || 8099)

// Season 1 token art. In production nginx serves /nft/degen-s1/ straight from the mint
// output; the files are deliberately NOT copied into public/ (6.5MB of PNGs that the game
// itself never loads, only the ARMORY screen and the marketplaces' own metadata do).
// Aliased here so a local run renders the same catalogue prod does instead of 24 broken
// images. Override with NFT_ART_DIR if the mint output lives elsewhere.
const NFT_PREFIX = '/nft/degen-s1/'
const NFT_DIR = process.env.NFT_ART_DIR || '/mnt/echostore/frag-nft/out'

const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
	'.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml',
	'.md': 'text/markdown',
}

http.createServer((req, res) => {
	const url = decodeURIComponent(req.url.split('?')[0])
	// Contain the path inside ROOT: this serves a directory to a browser we do not control.
	const rel = path.normalize(url).replace(/^(\.\.[/\\])+/, '')
	if (rel.startsWith(NFT_PREFIX)) {
		const name = path.basename(rel) // basename only — no traversal out of NFT_DIR
		const art = path.join(NFT_DIR, name)
		return fs.readFile(art, (err, buf) => {
			if (err) { res.writeHead(404).end('not found'); return }
			res.writeHead(200, {
				'content-type': TYPES[path.extname(art).toLowerCase()] || 'application/octet-stream',
				'cache-control': 'no-store',
			})
			res.end(buf)
		})
	}
	let file = path.join(ROOT, rel)
	if (file.endsWith('/') || rel === '/') file = path.join(file, 'index.html')
	if (!path.resolve(file).startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return }
	fs.readFile(file, (err, buf) => {
		if (err) { res.writeHead(404).end('not found'); return }
		res.writeHead(200, {
			'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
			'cache-control': 'no-store',
		})
		res.end(buf)
	})
}).listen(PORT, '127.0.0.1', () => console.log(`static ${ROOT} -> http://localhost:${PORT}/`))
