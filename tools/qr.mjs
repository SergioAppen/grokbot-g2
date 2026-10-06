// Usage: node tools/qr.mjs <url> <out.png>   (prints also as terminal QR when 3rd arg "term")
import { createRequire } from 'node:module'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const QR = require('qrcode')
const [url, out, term] = process.argv.slice(2)
await QR.toFile(out, url, { width: 512, margin: 2 })
if (term) console.log(await QR.toString(url, { type: 'terminal', small: true }))
