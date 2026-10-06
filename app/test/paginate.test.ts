import { paginate, sanitize, textWidth, HUD_LAYOUT } from '../src/paginate'
import LONG from './sample-long.txt'
const pages = paginate(LONG)
let ok = true
const fail = (m: string) => { ok = false; console.log('FAIL', m) }
for (const [i, p] of pages.entries()) {
  const ls = p.split('\n')
  if (ls.length > HUD_LAYOUT.lines) fail(`page ${i} has ${ls.length} lines`)
  for (const l of ls) if (textWidth(l) > HUD_LAYOUT.width) fail(`page ${i} line too wide (${textWidth(l)}): ${l}`)
  if (new TextEncoder().encode(p).length > HUD_LAYOUT.maxBytes) fail(`page ${i} too many bytes`)
}
const norm = (s: string) => s.replace(/\s+/g, '')
if (norm(pages.join('')) !== norm(sanitize(LONG))) fail('text lost or changed between sanitize and pages')
if (!pages[pages.length - 1].includes('purple elephant finale.')) fail('last page lacks final words')
console.log(`chars ${LONG.length}, pages ${pages.length}`)
console.log(pages.map((p, i) => `--- p${i + 1}\n${p}`).join('\n'))
console.log(ok ? 'PASS' : 'FAILED')
if (!ok) process.exit(1)
