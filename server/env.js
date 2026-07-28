// .env loading. MUST be imported before anything that reads process.env — several modules
// capture their config into consts at import time (chatBridge's PUMP_CA, walletLink's RPC),
// so a var that arrives after those run is a var that silently does nothing.
//
// WHY THIS EXISTS: there was no .env loading at all. Every secret and switch had to be
// exported in the shell that happened to launch the server, which meant the pump.fun
// bridge and the Telegram feed were permanently off in practice — chatBridge logged
// "no PUMP_CA — pump.fun feed off" on every boot and nobody had a file to put it in.
//
// Dependency-free on purpose, matching walletLink.js: process.loadEnvFile is built into
// Node and does exactly this. Pulling in dotenv to read eight lines would be the only
// runtime dependency this server has that is not the game engine.
//
// Loading happens as an IMPORT SIDE EFFECT, at the bottom of this file. ES imports are
// hoisted and evaluated in declaration order, so `import './env.js'` written as the first
// import in serverMain.js is the only construction that runs before the modules that
// capture env into consts. Exporting a loadEnv() to call from inside serverMain's body
// would be too late — every other import has already been evaluated by then.
import fs from 'fs'
import path from 'path'

const ENV_PATH = process.env.ENV_FILE || path.resolve(process.cwd(), '.env')

// THE SHELL WINS. Anything already exported is left alone, so a one-off
// `PUMP_CA=... npm run server` overrides the file without editing it — the usual way you
// point a dev server at a test coin for ten minutes. process.loadEnvFile does NOT
// guarantee this, so the existing values are captured and restored.
export function loadEnv() {
	if (!fs.existsSync(ENV_PATH)) {
		console.log(`[env] no ${path.basename(ENV_PATH)} — using the shell environment only`)
		return
	}
	const preset = new Set(Object.keys(process.env))
	const before = { ...process.env }
	try {
		process.loadEnvFile(ENV_PATH)
	} catch (err) {
		console.warn(`[env] could not read ${ENV_PATH}: ${err.message}`)
		return
	}
	for (const key of preset) process.env[key] = before[key]

	// Names only, never values: this line goes to a log that gets pasted into issues.
	const loaded = Object.keys(process.env).filter((k) => !preset.has(k))
	console.log(`[env] loaded ${loaded.length} var(s) from ${path.basename(ENV_PATH)}${loaded.length ? ': ' + loaded.join(', ') : ''}`)
}

loadEnv()
