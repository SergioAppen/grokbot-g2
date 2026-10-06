// HUD text layout for the G2 text container (fixed proportional firmware font, no font control).
// Pages are built from measured glyph widths and carry explicit '\n' line breaks, so the firmware never
// re-wraps them and a page can never overflow its container (overflow would hide lines / trigger firmware scroll).
import { ASCII_W, WIDE } from './glyphs'

const W = new Map<string, number>()
ASCII_W.forEach((w, i) => W.set(String.fromCharCode(32 + i), w))
for (const [w, s] of Object.entries(WIDE)) for (const c of s) W.set(c, Number(w))

/** Advance width of one character in px. Unknown glyphs are estimated on the wide side. */
export function charWidth(c: string): number {
  const w = W.get(c)
  if (w !== undefined) return w
  const cp = c.codePointAt(0) ?? 0
  return cp >= 0x2e80 ? 24 : 14 // CJK / other scripts: assume wide
}
export const textWidth = (s: string) => { let n = 0; for (const c of s) n += charWidth(c); return n }

// Characters the firmware font cannot draw (measured: they render as blank boxes) → drawable stand-ins.
const REPLACE: Record<string, string> = {
  '\u00a0': ' ', '\u2011': '-', '\u2012': '-', '\u2010': '-', '\u2212': '-', '\u2043': '-',
  '\u201b': "'", '\u201f': '"', '\u2023': '•', '\u2024': '.', '\u2027': '·', '\u203c': '!!', '\u2049': '!?', '\u2048': '?!',
  '\u2713': 'v', '\u2714': 'v', '\u2705': 'v', '\u2611': '[x]', '\u2610': '[ ]', '\u2612': '[x]', '\u2717': 'x', '\u2718': 'x', '\u274c': 'x',
  '\u25ba': '>', '\u25b8': '>', '\u25b9': '>', '\u276f': '>', '\u276e': '<', '\u21b5': '<-', '\u2192': '→',
  '\u25aa': '•', '\u25ab': '•', '\u25e6': '•', '\u2219': '·', '\u22c5': '·', '\u2026': '…',
}

/** Markdown → plain text the HUD can draw (no bold/italic/code styling exists on the glasses). */
export function sanitize(text: string): string {
  let t = text.replace(/\r\n?/g, '\n').normalize('NFC')
  t = t.replace(/^[ \t]*```[^\n]*\n?/gm, '')                          // code fences
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                 // images → alt text
  t = t.replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, l, u) => (l === u ? u : `${l} (${u})`)) // links
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, '$1')                 // autolinks
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*\n?/gm, '') // table separator rows
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((c: string) => c.trim()).join(' | ')) // table rows
  t = t.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '──────────')      // horizontal rule
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, '$1')        // headings
  t = t.replace(/^([ \t]*)>[ \t]?/gm, '$1| ')                           // block quotes
  t = t.replace(/^([ \t]*)[-*+][ \t]+\[( |x|X)\][ \t]+/gm, (_, s, x) => `${s}${x === ' ' ? '[ ]' : '[x]'} `) // task lists
  t = t.replace(/^([ \t]*)[-*+•][ \t]+/gm, (_, s: string) => `${' '.repeat(Math.min(4, Math.floor(s.length / 2) * 2))}• `) // bullets
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')           // bold
  t = t.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2') // *italic*
  t = t.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, '$1$2')  // _italic_ (keeps snake_case)
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')                  // strikethrough
  t = t.replace(/`([^`\n]+)`/g, '$1')                              // inline code
  // emoji / pictographs / variation selectors / zero-width chars: not in the firmware font
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{2060}-\u{206F}\u{E0020}-\u{E007F}]/gu, '')
  t = [...t].map((c) => REPLACE[c] ?? (/[\u2600-\u27BF]/.test(c) && !W.has(c) ? '' : c)).join('')
  t = t.replace(/\t/g, '  ').replace(/[ ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

export type Layout = { width: number; lines: number; maxBytes: number }
// Body container: 576 px wide, padding 4 → 568 px of text; keep 24 px spare in case the
// hardware font is a little wider than the simulator's. 27 px line pitch.
export const HUD_LAYOUT: Layout = { width: 544, lines: 7, maxBytes: 900 }

const BREAK_AFTER = new Set(['-', '/', '?', '&', '=', '_', '.', ',', ';', ':', ')', ']', '}', '|', '—', '–'])

/** Word-wrap one paragraph line into lines that each fit `width` px. Long words / URLs are hard-broken. */
export function wrapLine(line: string, width: number): string[] {
  if (!line) return ['']
  const indent = /^(\s*(?:• |\d{1,3}[.)] |\| ))/.exec(line)?.[1] ?? ''
  const hang = ' '.repeat(Math.min(6, Math.round(textWidth(indent) / charWidth(' '))))
  const out: string[] = []
  const tokens = line.match(/\S+|\s+/g) ?? []
  let cur = '', curW = 0
  const flush = () => { out.push(cur.replace(/\s+$/, '')); cur = out.length ? hang : ''; curW = textWidth(cur) }
  for (const tok of tokens) {
    const tw = textWidth(tok)
    if (/^\s+$/.test(tok)) { if (curW + tw <= width) { cur += tok; curW += tw } else flush(); continue }
    if (curW + tw <= width) { cur += tok; curW += tw; continue }
    if (cur.trim() && tw <= width - textWidth(hang)) { flush(); cur += tok; curW += tw; continue }
    // Word longer than a line (URL, path): break it, preferring a break after / - ? & = etc.
    let rest = tok
    while (rest) {
      const room = width - curW
      let fit = 0, w = 0, lastBreak = -1
      for (const c of rest) { if (w + charWidth(c) > room) break; w += charWidth(c); fit += c.length; if (BREAK_AFTER.has(c)) lastBreak = fit }
      if (fit === rest.length) { cur += rest; curW += w; break }
      const cut = lastBreak > fit * 0.5 ? lastBreak : fit
      if (cut === 0) { if (cur.trim()) { flush(); continue } cur += rest.slice(0, 1); rest = rest.slice(1); flush(); continue }
      cur += rest.slice(0, cut); rest = rest.slice(cut); flush()
    }
  }
  if (cur.trim() || !out.length) out.push(cur.replace(/\s+$/, ''))
  return out
}

const enc = new TextEncoder()
/** Split a message into HUD pages: sanitized, wrapped by measured width, ≤ layout.lines lines and ≤ maxBytes each. */
export function paginate(text: string, layout: Layout = HUD_LAYOUT): string[] {
  const lines = sanitize(text).split('\n').flatMap((l) => wrapLine(l, layout.width))
  const pages: string[] = []
  let cur: string[] = []
  const bytes = (ls: string[]) => enc.encode(ls.join('\n')).length
  for (const l of lines) {
    if (!cur.length && !l.trim()) continue // no blank line at the top of a page
    if (cur.length >= layout.lines || (cur.length && bytes([...cur, l]) > layout.maxBytes)) { pages.push(cur.join('\n').replace(/\s+$/, '')); cur = [] ; if (!l.trim()) continue }
    cur.push(l)
  }
  if (cur.join('').trim()) pages.push(cur.join('\n').replace(/\s+$/, ''))
  return pages.length ? pages : ['']
}
