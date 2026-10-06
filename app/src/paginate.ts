// Split text into HUD pages. ~400–500 chars fill the 576×288 canvas; the body
// container is a bit shorter (header line), so default to 340 chars / 8 lines.
export function paginate(text: string, maxChars = 340, maxLines = 8, charsPerLine = 46): string[] {
  const clean = text.replace(/\r/g, '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim()
  const words = clean.split(/(\s+)/)
  const pages: string[] = []
  let cur = ''
  const lines = (s: string) => s.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0)
  for (const w of words) {
    const next = cur + w
    if (cur && (next.length > maxChars || lines(next) > maxLines)) {
      pages.push(cur.trim())
      cur = w.trimStart()
    } else cur = next
  }
  if (cur.trim()) pages.push(cur.trim())
  return pages.length ? pages : ['']
}
