import { defineConfig } from 'vite'
import path from 'node:path'

const VERSION = '0.0.1'
const ROOT = __dirname
const ENTRY = path.resolve(ROOT, 'client/clientMain.js')

export default defineConfig(({ command }) => {
  const isBuild = command === 'build'
  return {
    root: isBuild ? ROOT : path.resolve(ROOT, 'public'),
    publicDir: false,                 // §4 collision fix: do not let Vite own public/
    base: '/',
    define: {
      // Vite does NOT shim process.env; Simulator.js:185 reads process.env.NODE_ENV
      'process.env.NODE_ENV': JSON.stringify(isBuild ? 'production' : 'development'),
    },
    resolve: {
      alias: {
        // nengi's browser client imports Node's built-in `events` (EventEmitter);
        // webpack 4 auto-polyfilled Node builtins, Vite/Rollup does not. Map to the
        // pure-JS `events` polyfill package so the client bundle gets a real
        // EventEmitter (R9-class fix; a real polyfill, not an empty stub).
        events: path.resolve(ROOT, 'node_modules/events/events.js'),
      },
    },
    // optimizeDeps: scoped @babylonjs/core deep imports are ESM; Vite auto-discovers.
    // (Phase 3: removed the old babylonjs/babylonjs-loaders UMD pre-bundle include.)
    server: {
      port: 8080,
      strictPort: true,
      proxy: { '/ws': { target: 'ws://localhost:8079', ws: true, changeOrigin: true } }, // optional; client dials :8079 directly
      fs: { allow: [ROOT] },
    },
    build: {
      outDir: path.resolve(ROOT, 'public/js'),
      emptyOutDir: false,
      target: 'es2019',
      sourcemap: true,
      minify: 'esbuild',
      rollupOptions: {
        input: ENTRY,
        output: {
          format: 'iife',                       // plain <script src>, matches index.html
          entryFileNames: `app-v${VERSION}.js`, // pin: app-v0.0.1.js
          inlineDynamicImports: true,           // single file so stamp-build hashes one
        },
      },
    },
    plugins: [devSourceEntry(isBuild, ROOT)],
  }
})

function devSourceEntry(isBuild, root) {
  return {
    name: 'dev-source-entry',
    apply: 'serve',
    // order:'pre' + optional leading slash: vite's own dev html processing rewrites
    // relative srcs to absolute BEFORE post-ordered hooks on URLS WITH A QUERY STRING
    // (?flat=1 served the stale prod bundle while bare / got the dev entry — the
    // texpop A/B probe found this the hard way). Running pre sees the raw html.
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(
          /<script src="\/?js\/app-v[0-9.]+\.js[^"]*"><\/script>/,
          `<script type="module" src="/@fs/${path.resolve(root, 'client/clientMain.js')}"></script>`)
      },
    },
  }
}
