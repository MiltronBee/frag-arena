import { readFileSync } from 'node:fs'
const key = readFileSync('/home/miltron/solSoccer/.env','utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
console.log('key present:', !!key)
async function call(label, extra) {
  const t = Date.now()
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k3',
        messages: [{ role: 'user', content: 'Reply with exactly the word: PONG' }],
        max_tokens: 2000,
        ...extra,
      }),
    })
    const j = await res.json()
    const c = j.choices?.[0]
    console.log(`[${label}] ${Date.now()-t}ms http=${res.status} finish=${c?.finish_reason} content=${JSON.stringify(c?.message?.content)} reasoning_len=${(c?.message?.reasoning||'').length} err=${j.error?.message||''}`)
  } catch (e) { console.log(`[${label}] threw ${Date.now()-t}ms: ${e.message}`) }
}
await call('plain', {})
await call('with-reasoning-cap', { reasoning: { max_tokens: 800 } })
await call('reasoning-low', { reasoning: { effort: 'low' } })
