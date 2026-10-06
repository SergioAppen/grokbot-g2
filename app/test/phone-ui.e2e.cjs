// Phone-UI layout/keyboard test (mock relay only): WebKit + Chromium, iPhone sizes 390x844 and 375x667, keyboard
// simulated by shrinking the viewport to half. Run through tools/phone-test.sh (it builds and serves the harness).
// Env: HARNESS_URL (served test/phone-harness.html), RELAY (mock relay URL), RELAY_TOKEN, OUT (screenshot dir),
// ENGINES (default "webkit,chromium").
const pw = require('playwright')
const fs = require('fs'), { execFileSync } = require('child_process')
const OUT = process.env.OUT || 'test/sim', tok = process.env.RELAY_TOKEN || ''
fs.mkdirSync(OUT, { recursive: true })
const BASE = (q = '') => `${process.env.HARNESS_URL}${q}#relay=${process.env.RELAY || 'http://127.0.0.1:8799'}&token=${tok}`
const results = []
function kbShot(file, w, fullH, visH) {
  try { kbShotPIL(file, w, fullH, visH) } catch { /* python3 + Pillow missing: keep the plain screenshot */ }
}
function kbShotPIL(file, w, fullH, visH) {
  // paste the shrunken-viewport screenshot on top of a full-height canvas, draw the keyboard area below it
  execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw, ImageFont
import sys
p, W, H, V = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
top = Image.open(p).convert('RGB'); s = top.width / W
c = Image.new('RGB', (top.width, int(H * s)), (40, 40, 44)); c.paste(top, (0, 0))
d = ImageDraw.Draw(c); y0 = top.height
d.rectangle([0, y0, c.width, c.height], fill=(58, 58, 64)); d.line([0, y0, c.width, y0], fill=(254, 249, 145), width=int(2*s))
try: f = ImageFont.truetype('DejaVuSans.ttf', int(15 * s))
except Exception: f = ImageFont.load_default()
d.text((int(12*s), y0 + int(12*s)), f'simulated keyboard: {H-V}px, viewport {W}x{V}', fill=(220, 220, 220), font=f)
for r in range(3):
    for k in range(10 - r):
        x = int((8 + r*16 + k*((W-16)/10)) * s); y = y0 + int((52 + r*52) * s)
        d.rounded_rectangle([x, y, x + int(((W-16)/10 - 6) * s), y + int(42 * s)], radius=int(5*s), fill=(90, 90, 98))
c.save(p)`, file, String(w), String(fullH), String(visH)], { stdio: 'ignore' })
}
async function rect(p, sel) { return p.evaluate((s) => { const e = typeof s === 'string' ? document.querySelector(s) : document.activeElement; if (!e) return null; const b = e.getBoundingClientRect(); return { y: Math.round(b.y), bottom: Math.round(b.bottom), h: Math.round(b.height) } }, sel) }
function check(name, ok, detail) { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ? JSON.stringify(detail) : ''}`) }

;(async () => {
  for (const eng of (process.env.ENGINES || 'webkit,chromium').split(',')) {
    const bt = pw[eng]
    const b = await bt.launch()
    for (const [W, H] of [[390, 844], [375, 667]]) {
      const tag = `${eng}_${W}x${H}`, VIS = Math.round(H / 2)
      const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' })
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message))
      await p.goto(BASE()); await p.waitForFunction(() => window.__harness && window.__harness.ready)
      const save = (n) => p.screenshot({ path: `${OUT}/phone_${n}_${tag}.png` })
      await save('list')
      // 1) Quick actions → + Add action (keyboard closed)
      await p.tap('#qaopen'); await p.waitForTimeout(200)
      await p.tap('#qaadd'); await p.waitForTimeout(500)
      const st = await p.evaluate(() => { const first = document.querySelector('#qalist .qa'); const ae = document.activeElement
        return { cards: document.querySelectorAll('#qalist .qa').length, labels: [...document.querySelectorAll('#qalist .qa input[data-f=label]')].map((i) => i.value), firstIsNew: first?.classList.contains('new'), activeIsFirstLabel: !!first && ae === first.querySelector('input[data-f=label]') } })
      const ar = await rect(p, null)
      check(`${tag} add: new editor first + label focused`, st.firstIsNew && st.activeIsFirstLabel, st)
      check(`${tag} add: focused label visible`, ar && ar.y >= 0 && ar.bottom <= H, ar)
      await save('actions_new')
      // 2) simulated keyboard: visual viewport shrinks to ~half
      await p.setViewportSize({ width: W, height: VIS }); await p.waitForTimeout(700)
      const ar2 = await rect(p, null), sv = await rect(p, '#qasave'), ad = await rect(p, '#qaadd')
      check(`${tag} kb: focused label visible above keyboard`, ar2 && ar2.y >= 0 && ar2.bottom <= VIS, ar2)
      check(`${tag} kb: Save reachable`, sv && sv.y >= 0 && sv.bottom <= VIS, sv)
      await p.keyboard.type('Flight status'); await p.waitForTimeout(150)
      await p.screenshot({ path: `${OUT}/phone_actions_kb_${tag}.png` }); kbShot(`${OUT}/phone_actions_kb_${tag}.png`, W, H, VIS)
      // message textarea of the new card
      await p.tap('#qalist .qa.new textarea'); await p.waitForTimeout(600)
      const ta = await rect(p, null)
      check(`${tag} kb: message field visible when focused`, ta && ta.y >= 0 && ta.bottom <= VIS, ta)
      await p.keyboard.type('What is the status of my next flight?')
      await p.screenshot({ path: `${OUT}/phone_actions_kb_msg_${tag}.png` }); kbShot(`${OUT}/phone_actions_kb_msg_${tag}.png`, W, H, VIS)
      await p.setViewportSize({ width: W, height: H }); await p.waitForTimeout(300)
      // 3) Settings is its own screen; xAI key field with keyboard
      await p.evaluate(() => { window.confirm = () => true }) // discard unsaved test action
      await p.tap('#qaback'); await p.waitForTimeout(200)
      await p.tap('#setopen'); await p.waitForTimeout(700)
      const listHidden = await p.evaluate(() => document.getElementById('vactions').classList.contains('hidden') && document.getElementById('vlist').classList.contains('hidden'))
      check(`${tag} settings: separate screen`, listHidden)
      await save('settings')
      await p.setViewportSize({ width: W, height: VIS }); await p.waitForTimeout(300)
      await p.tap('#key-xai'); await p.waitForTimeout(700)
      const kx = await rect(p, null)
      check(`${tag} kb: xAI key field visible`, kx && kx.y >= 0 && kx.bottom <= VIS, kx)
      await p.screenshot({ path: `${OUT}/phone_settings_key_kb_${tag}.png` }); kbShot(`${OUT}/phone_settings_key_kb_${tag}.png`, W, H, VIS)
      await p.setViewportSize({ width: W, height: H }); await p.waitForTimeout(300)
      // 4) chat composer with keyboard
      await p.tap('#setback'); await p.waitForTimeout(200)
      await p.tap('#list .c'); await p.waitForTimeout(600)
      await p.setViewportSize({ width: W, height: VIS }); await p.waitForTimeout(300)
      await p.tap('#text'); await p.waitForTimeout(700)
      const tx = await rect(p, '#text'), sd = await rect(p, '#send')
      check(`${tag} kb: chat composer + Send visible`, tx && sd && tx.bottom <= VIS && sd.bottom <= VIS && tx.y >= 0, { tx, sd })
      await p.screenshot({ path: `${OUT}/phone_chat_kb_${tag}.png` }); kbShot(`${OUT}/phone_chat_kb_${tag}.png`, W, H, VIS)
      check(`${tag} no JS errors`, errs.length === 0 && (await p.evaluate(() => window.__harness.errors.length)) === 0, errs)
      await ctx.close()
    }
    // debug banner (webkit + chromium, one size)
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const p = await ctx.newPage(); await p.goto(BASE('?debug')); await p.waitForFunction(() => window.__harness && window.__harness.ready)
    await p.evaluate(() => setTimeout(() => { throw new Error('test error from phone-ui.e2e.cjs') }, 0)); await p.waitForTimeout(300)
    const bar = await p.evaluate(() => document.getElementById('errbar')?.textContent || '')
    check(`${eng} debug: on-screen error banner`, bar.includes('test error from phone-ui.e2e.cjs'), bar.slice(0, 120))
    await p.screenshot({ path: `${OUT}/phone_debug_banner_${eng}.png` })
    await ctx.close(); await b.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
