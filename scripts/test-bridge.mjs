// The bridge takes text from OUTSIDE the game and puts it in front of every player, so
// its formatting and its rate limit are the only things between a busy Telegram group
// (or a hostile one) and the arena HUD.
import ChatBridge from '/home/miltron/unreal/server/chatBridge.js'
import { CHAT_SOURCE } from '/home/miltron/unreal/common/chat.js'

const got = []
const bridge = new ChatBridge((line, source) => got.push({ line, source }))

console.log('=== formatting ===')
bridge._push('alice', 'hello arena', CHAT_SOURCE.TELEGRAM)
bridge._push('a'.repeat(40), 'long username gets capped', CHAT_SOURCE.TELEGRAM)
bridge._push('', 'no username', CHAT_SOURCE.PUMP)
bridge._push('spoofer', 'line one\nFAKE: line two', CHAT_SOURCE.PUMP)
bridge._push('empty', '   ', CHAT_SOURCE.PUMP)
for (const g of got) console.log(`  src=${g.source} ${JSON.stringify(g.line)}`)

let bad = 0
if (got.some((g) => /\n/.test(g.line))) { console.log('  BAD: newline survived'); bad++ }
if (got.some((g) => g.line.split(':')[0].length > 16)) { console.log('  BAD: username not capped'); bad++ }
if (got.some((g) => g.line.startsWith('empty:'))) { console.log('  BAD: empty message emitted'); bad++ }

console.log('\n=== rate limit (one source flooding) ===')
const before = got.length
for (let i = 0; i < 40; i++) bridge._push('flood', 'spam ' + i, CHAT_SOURCE.TELEGRAM)
const passed = got.length - before
console.log(`  40 messages -> ${passed} relayed`)
if (passed >= 40) { console.log('  BAD: no rate limiting'); bad++ }

console.log('\n=== the other source is NOT starved by the flood ===')
const b2 = got.length
bridge._push('bob', 'still gets through', CHAT_SOURCE.PUMP)
const pumpPassed = got.length - b2
console.log(`  pump message after telegram flood -> ${pumpPassed ? 'relayed' : 'BLOCKED'}`)
if (!pumpPassed) { console.log('  BAD: buckets are shared, not per-source'); bad++ }

console.log('\n' + (bad ? `${bad} PROBLEM(S)` : 'bridge formatting + per-source rate limiting sound'))
