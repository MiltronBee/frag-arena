// Minimal static file server for public/, on port 8180 (avoid clashing with dev
// server or production). Used by scripts/preview-hero-paint.mjs to load the
// prebuilt bundle without needing webpack-dev-server or the game server.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("public");
const PORT = Number(process.env.PORT || 8180);
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "") p = "/index.html";
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT)) { res.writeHead(403).end("nope"); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("nf " + p); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "content-length": st.size });
    fs.createReadStream(full).pipe(res);
  });
});
server.listen(PORT, () => console.log("serve public/ on :" + PORT));
