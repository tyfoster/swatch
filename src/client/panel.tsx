// Swatch's panel: every colour token of the project's light and dark
// themes, with where each is used, each foreground's contrast against its
// surface, and what an alias resolves to. Edits preview live on the real
// page (an override <style> at the end of <head>), survive a reload
// (localStorage), and Save writes them to their stylesheet through the dev
// server. Reset takes back what this tab wrote. "Find" paints a token
// magenta while held; "Inspect" names the tokens behind elements and
// filters the list to them.
//
// The panel lives in a shadow root (mount.tsx) and draws itself in fixed
// greys, not tokens, so neither the app's CSS nor a bad edit can hide it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { FONT, MONO, parseColor, toHex, type RGBA } from "./colour.ts"
import { http, type Backend, type Change, type Edit, type Sheet, type Theme, type Token } from "./backend.ts"
import { shadow } from "./host.ts"
import { Picker } from "./picker.tsx"

const THEMES: Theme[] = ["light", "dark"]
type Edits = Record<string, Partial<Record<Theme, string>>>

const KEY = "swatch"
const FIND = "#ff00ff"
const NAME = /^--[a-z0-9-]+$/

// Where the tool sits: null is the default, the bottom-left corner (16px
// in); a position is where it was dragged to, from the top left.
type Pos = { x: number; y: number } | null
/** How near the bottom-left corner (px) a drag must end to snap back to it. */
const HOME = 40
type Stored = { edits: Edits; deleted: string[]; open: boolean; pos: Pos; figma: string }
const load = (): Stored => {
  const empty: Stored = { edits: {}, deleted: [], open: false, pos: null, figma: "" }
  try { return { ...empty, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") } } catch { return empty }
}

// ── The journal ──────────────────────────────────────────────────────────
// Every change this tab wrote to the stylesheet, as the server reported it
// (the value the file held, and the one written). Reset puts back what it
// wrote, and "Save & send" sends it, but only where the file still holds
// what was written: a branch switch or someone else's edit since is theirs,
// never reverted or sent. Kept in sessionStorage, so it outlives the reloads
// a save sets off, and ends with the tab.
const JOURNAL_KEY = `${KEY}.journal`
const loadJournal = (): Change[] => { try { return JSON.parse(sessionStorage.getItem(JOURNAL_KEY) ?? "[]") } catch { return [] } }
const storeJournal = (j: Change[]) => { try { sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(j)) } catch { /* private window */ } }
/** One change per token and theme: from what it first held to what it was
 *  last given, and nothing where those are the same. A write that found
 *  the file holding something other than what this tab last wrote followed
 *  an outside change: that value is where the chain starts again, so Reset
 *  goes back to it and never past it. */
function net(journal: Change[]): Change[] {
  const m = new Map<string, Change>()
  for (const c of journal) {
    const k = `${c.name}|${c.theme}`
    const had = m.get(k)
    m.set(k, had && had.to === c.from ? { ...had, to: c.to } : c)
  }
  return [...m.values()].filter((c) => c.from !== c.to)
}

/** The swatch icon (Heroicons "swatch", outline). */
const Icon = ({ size = 20 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" width={size} height={size} aria-hidden style={{ flexShrink: 0 }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 0 0 3.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008Z" />
  </svg>
)

// ── Opening and closing ──────────────────────────────────────────────────
// One container changes size: the launcher grows into the panel from the
// corner they share, and the panel shrinks back into it. The box (its
// background, border and shadow) is never hidden; only what is inside it
// fades. Nothing moves for a visitor who asked for reduced motion.
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const GROW = 140, SHRINK = 110 // ms
const EASE = "cubic-bezier(0.2, 0, 0, 1)"
/** The launcher's box: two 40px buttons, a 4px gap, 4px padding, 1px border. */
const LAUNCHER = { w: 94, h: 50, radius: 25 }
const PANEL_RADIUS = 12

// ── Sections ─────────────────────────────────────────────────────────────
// The project's own (the `groups` option: a title and a pattern, tried in
// order), or, with none set, by the first word of each name: --card and
// --card-foreground under "Card", --chart-1…5 under "Chart". A word fewer
// than three tokens share goes under "Other". Tailwind's --color- prefix
// is not a word. Tokens added here and not yet saved are "New".
type Grouping = { of: (t: Token) => string; order: string[] }
function grouping(sheet: Sheet | null): Grouping {
  if (sheet?.groups) {
    const pats = sheet.groups.map(([title, re]) => [title, new RegExp(re)] as const)
    return { of: (t) => t.isNew ? "New" : pats.find(([, re]) => re.test(t.name))?.[0] ?? "Other", order: [...pats.map(([g]) => g), "Other", "New"] }
  }
  const word = (name: string) => name.replace(/^--(color-)?/, "").split("-")[0]
  const count = new Map<string, number>()
  for (const t of sheet?.tokens ?? []) count.set(word(t.name), (count.get(word(t.name)) ?? 0) + 1)
  const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const order = [...count].filter(([, n]) => n >= 3).map(([w]) => title(w))
  return {
    of: (t) => t.isNew ? "New" : (count.get(word(t.name)) ?? 0) >= 3 ? title(word(t.name)) : "Other",
    order: [...order, "Other", "New"],
  }
}

/** The preview, written as the stylesheet is, so the cascade an edit meets
 *  is the one a save would land in: light on :root, dark on the
 *  stylesheet's own dark selector (or inside its prefers-color-scheme
 *  query), after it. */
function css(edits: Edits, deleted: string[], find: string | null, saved: Token[], dark: Sheet["dark"]) {
  const light: string[] = []
  // dark declarations by the rule they go in: the project's dark selector,
  // or a token's own where its stylesheet selects dark another way
  const darks = new Map<string, string[]>()
  const byName = new Map(saved.map((t) => [t.name, t]))
  const ruleOf = (d: Sheet["dark"]) => d?.media ? `@media ${d.media}{:root{…}}` : `${d?.selector ?? ".dark"}{…}`
  const main = ruleOf(dark)
  darks.set(main, [])
  for (const t of saved) if (t.darkAt && !darks.has(ruleOf(t.darkAt))) darks.set(ruleOf(t.darkAt), [])
  const putDark = (name: string, decl: string) => darks.get(ruleOf(byName.get(name)?.darkAt ?? dark))!.push(decl)
  for (const [name, e] of Object.entries(edits)) {
    if (deleted.includes(name)) continue
    const t = byName.get(name)
    // a value still being typed ("rgb(") would swallow the rest of this
    // sheet: it previews once it is whole
    if (e.light !== undefined && e.light !== "" && wellFormed(e.light)) {
      light.push(`${name}: ${e.light};`)
      // this :root rule comes after the file's dark rule, so a token the
      // dark theme declares keeps its dark value by saying it again here
      if (e.dark === undefined && t?.dark !== undefined) putDark(name, `${name}: ${t.dark};`)
    }
    if (e.dark !== undefined) {
      // an emptied dark value is a save that removes the declaration, so the
      // dark theme inherits the light one: previewed as that light value
      const v = e.dark !== "" ? e.dark : (e.light || t?.light)
      if (v && wellFormed(v)) putDark(name, `${name}: ${v};`)
      // a token with no light value has nothing to inherit: emptied, it is unset
      else if (!v) putDark(name, `${name}: initial;`)
    }
  }
  // a deleted token previews as unset: every var() on it falls back
  for (const name of deleted) { light.push(`${name}: initial;`); putDark(name, `${name}: initial;`) }
  if (find) { light.push(`${find}: ${FIND} !important;`); for (const d of darks.values()) d.push(`${find}: ${FIND} !important;`) }
  return [`:root{${light.join("")}}`, ...[...darks].map(([rule, decls]) => rule.replace("…", decls.join("")))].join("\n")
}

/** Whether the page is showing the dark theme, and a way to flip it for a
 *  preview (none when the stylesheet follows the system's setting). */
function themeSwitch(dark: Sheet["dark"]) {
  if (dark?.media) return { isDark: () => matchMedia(dark.media!).matches, toggle: null }
  const first = (dark?.selector ?? ".dark").split(",")[0].trim().replace(/^(:root|html)/, "")
  const attr = /^\[([\w-]+)=["']?([\w-]+)["']?\]$/.exec(first)
  const html = document.documentElement
  if (attr) return {
    isDark: () => html.getAttribute(attr[1]) === attr[2],
    toggle: () => html.getAttribute(attr[1]) === attr[2] ? html.removeAttribute(attr[1]) : html.setAttribute(attr[1], attr[2]),
  }
  const cls = first.replace(/^\./, "")
  return { isDark: () => html.classList.contains(cls), toggle: () => html.classList.toggle(cls) }
}

// ── Resolving and contrast ───────────────────────────────────────────────
type Table = Map<string, { light?: string; dark?: string }>

/** Each var(…) in `text` with its name and fallback, found by counting
 *  brackets, so a fallback with brackets of its own (var(--a, rgb(0 0 0)))
 *  is read whole. */
function vars(text: string): { start: number; end: number; name: string; fallback?: string }[] {
  const out: { start: number; end: number; name: string; fallback?: string }[] = []
  let from = 0
  for (;;) {
    const start = text.indexOf("var(", from)
    if (start < 0) return out
    let depth = 0, comma = -1, end = -1
    for (let i = start + 3; i < text.length; i++) {
      const ch = text[i]
      if (ch === "(") depth++
      else if (ch === ")" && --depth === 0) { end = i + 1; break }
      else if (ch === "," && depth === 1 && comma < 0) comma = i
    }
    if (end < 0) return out
    const inner = text.slice(start + 4, comma < 0 ? end - 1 : comma).trim()
    out.push({ start, end, name: inner, fallback: comma < 0 ? undefined : text.slice(comma + 1, end - 1).trim() })
    from = end
  }
}

/** The value with every var() replaced by what it holds in `theme`, the
 *  aliases passed through on the way (--a → --b → #fff), and any token it
 *  names that does not exist. */
function literal(name: string, theme: Theme, table: Table, seen: string[] = []): { text?: string; via: string[]; missing: string[] } {
  if (seen.includes(name)) return { via: seen, missing: [] }
  const t = table.get(name)
  const raw = theme === "dark" ? (t?.dark || t?.light) : t?.light
  if (raw === undefined || raw === "") return { via: seen, missing: [] }
  return substitute(raw.replace(IMPORTANT, ""), theme, table, [...seen, name])
}
function substitute(raw: string, theme: Theme, table: Table, seen: string[]): { text?: string; via: string[]; missing: string[] } {
  let via = seen, text = "", at = 0
  const missing: string[] = []
  for (const v of vars(raw)) {
    text += raw.slice(at, v.start)
    at = v.end
    const r = table.has(v.name) ? literal(v.name, theme, table, seen) : { text: undefined, via: seen, missing: [v.name] }
    if (r.via.length > via.length) via = r.via
    let sub = r.text
    if (sub === undefined && v.fallback !== undefined) sub = substitute(v.fallback, theme, table, seen).text
    else missing.push(...r.missing)
    if (sub === undefined) return { via, missing: missing.length ? missing : [v.name] }
    text += sub
  }
  return { text: text + raw.slice(at), via, missing }
}

// literal colours only, so the same text means the same colour in either theme
const cache = new Map<string, RGBA | null>()
const colourOf = (text: string | undefined) => {
  if (!text) return null
  if (!cache.has(text)) {
    // a picker drag makes a new colour on every move: start over rather than grow without end
    if (cache.size > 4000) cache.clear()
    cache.set(text, parseColor(text))
  }
  return cache.get(text)!
}
const over = (top: RGBA, under: RGBA): RGBA => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
const lum = (c: RGBA) => {
  const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 }
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 }
/** WCAG 2's contrast ratio of a foreground over a stack of backgrounds
 *  (nearest first), the stack laid over `base`. */
function ratio(fg: RGBA, layers: RGBA[], base: RGBA) {
  const bg = layers.reduceRight((under, top) => over(top, under), base)
  const [x, y] = [lum(over(fg, bg)), lum(bg)]
  return { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), fg: over(fg, bg), bg }
}
/** The surface a foreground token is read on: --x-foreground on --x, and
 *  --foreground on --background. */
const surfaceOf = (name: string, table: Table) => {
  const s = name === "--foreground" ? "--background" : name.endsWith("-foreground") ? name.slice(0, -"-foreground".length) : null
  return s && table.has(s) ? s : null
}
function contrast(fg: string, bg: string, theme: Theme, table: Table) {
  const f = colourOf(literal(fg, theme, table).text)
  const b = colourOf(literal(bg, theme, table).text)
  if (!f || !b) return null
  // a translucent surface sits on the page, and the page on white or black
  const page = colourOf(literal("--background", theme, table).text)
  return ratio(f, page ? [b, page] : [b], theme === "dark" ? BLACK : WHITE).ratio
}

const IMPORTANT = /\s*!important\s*$/i
/** Whether the text can stand as one declaration's value: its brackets and
 *  quotes closed, no comment, nothing that ends a declaration. The browser
 *  closes an open bracket for itself when asked whether a value is a
 *  colour, so "rgb(0 0 0" would pass as one; in the stylesheet it would
 *  swallow everything after it. */
function wellFormed(value: string) {
  if (/[;{}\\\n\r]|\/\*/.test(value)) return false
  let depth = 0, quote = ""
  for (const ch of value) {
    if (quote) { if (ch === quote) quote = ""; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")" && --depth < 0) return false
  }
  return depth === 0 && !quote
}
/** Why a value cannot be saved, or null when it can: it must be whole, come
 *  to a colour in the theme it is for, and name only tokens that exist. */
function problem(value: string, theme: Theme, table: Table): string | null {
  const v = value.replace(IMPORTANT, "").trim()
  if (!v) return "empty"
  if (!wellFormed(v)) return "an unclosed bracket or quote, or a character a value can't hold"
  // these are valid anywhere, and on a custom property mean "no value"
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) return `"${v}" is not a colour`
  const r = substitute(v, theme, table, [])
  if (r.missing.length) {
    const gone = r.missing.filter((n) => !table.has(n))
    return gone.length ? `no token ${gone.join(", ")}` : `${r.missing.join(", ")} does not come to a value (it may refer back to itself)`
  }
  if (!colourOf(r.text)) return "not a colour"
  return null
}

const S = {
  panel: { position: "fixed", left: 16, bottom: 16, zIndex: 2147483000, width: 720, maxWidth: "calc(100vw - 32px)", height: "min(80vh, 800px)", display: "flex", flexDirection: "column", background: "#1c1c1f", color: "#ececec", border: "1px solid #333", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.45)", font: `12px/1.4 ${FONT}` },
  fab: { position: "fixed", left: 16, bottom: 16, zIndex: 2147483000, padding: "8px 12px", background: "#1c1c1f", color: "#ececec", border: "1px solid #333", borderRadius: 999, font: `600 12px ${FONT}`, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.35)" },
  btn: { padding: "4px 8px", background: "#2a2a2e", color: "#ececec", border: "1px solid #3a3a40", borderRadius: 6, cursor: "pointer", font: "inherit" },
  input: { width: "100%", minWidth: 0, padding: "3px 6px", background: "#111113", color: "#ececec", border: "1px solid #3a3a40", borderRadius: 5, font: `11px ${MONO}` },
  swatch: { width: 22, height: 22, padding: 0, borderRadius: 5, border: "1px solid #555", flexShrink: 0, backgroundImage: "linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%),linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%)", backgroundSize: "8px 8px", backgroundPosition: "0 0,4px 4px", position: "relative", overflow: "hidden", cursor: "pointer" },
  muted: { color: "#8a8a92" },
} satisfies Record<string, CSSProperties>
/** In the page: fills its container, and scrolls inside it. */
const DOCKED: CSSProperties = { position: "relative", left: "auto", bottom: "auto", width: "100%", maxWidth: "none", height: "100%", zIndex: "auto", boxShadow: "0 24px 60px rgba(0,0,0,.35)" }
/** A button that cannot be pressed now says so: dimmed, no pointer. */
const off = (s: CSSProperties, disabled: boolean): CSSProperties => disabled ? { ...s, opacity: 0.4, cursor: "default" } : s
// the name column is the widest: a token's name is what it is found by
const COLS = "minmax(170px,1.3fr) 1fr 1fr 48px"
// the Light column's own padding, on top of the grid's 8px: Light and Dark
// sit 20px apart, so a row's two values read as two
const THEME_GAP = 12

function Chip({ c, title }: { c: string; title?: string }) {
  return <span title={title} style={{ ...S.swatch, width: 12, height: 12, borderRadius: 3, cursor: "inherit", display: "inline-block" }}><span style={{ position: "absolute", inset: 0, background: c }} /></span>
}

// ── A value field that completes token references ────────────────────────
// Type "-" (or "var(-") and the tokens whose names match drop down; picking
// one writes var(--name) in place, so it works inside color-mix() too.
const FRAG = /(?:^|[\s,(])((?:var\()?-{1,2}[\w-]*)$/

function ValueInput({ value, onChange, names, section, table, theme, style, placeholder, title }: {
  value: string; onChange: (v: string) => void; names: string[]
  /** the tokens in this field's own section, listed first */
  section?: string[]
  table: Table; theme: Theme; style: CSSProperties; placeholder?: string; title?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [frag, setFrag] = useState<{ start: number; end: number; needle: string; rect: DOMRect } | null>(null)
  const [active, setActive] = useState(0)

  const look = (text: string, caret: number | null) => {
    const end = caret ?? text.length
    const m = FRAG.exec(text.slice(0, end))
    const rect = ref.current?.getBoundingClientRect()
    setFrag(m && rect ? { start: end - m[1].length, end, needle: m[1].replace(/^var\(/, "").replace(/^-+/, "").toLowerCase(), rect } : null)
    setActive(0)
  }
  // every token matches; within each part, names that start with what was
  // typed come before names that only contain it
  const parts = useMemo(() => {
    if (!frag) return []
    const rank = (list: string[]) => {
      const hits = list.filter((n) => n.slice(2).includes(frag.needle))
      return [...hits.filter((n) => n.slice(2).startsWith(frag.needle)), ...hits.filter((n) => !n.slice(2).startsWith(frag.needle))]
    }
    if (!section) return [{ title: "", names: rank(names) }]
    const own = new Set(section)
    return [
      { title: "Section tokens", names: rank(names.filter((n) => own.has(n))) },
      { title: "All others", names: rank(names.filter((n) => !own.has(n))) },
    ].filter((g) => g.names.length)
  }, [frag, names, section])
  const matches = parts.flatMap((g) => g.names)

  const pick = (name: string) => {
    if (!frag) return
    // the whole name under the caret goes, not just the part left of it
    let end = frag.end
    while (end < value.length && /[\w-]/.test(value[end])) end++
    let rest = value.slice(end)
    // "var(-" typed with its own closing bracket already there
    if (value.slice(frag.start, frag.end).startsWith("var(") && rest.startsWith(")")) rest = rest.slice(1)
    const ins = `var(${name})`
    onChange(value.slice(0, frag.start) + ins + rest)
    setFrag(null)
    const at = frag.start + ins.length
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(at, at) })
  }

  const rect = frag && matches.length ? frag.rect : undefined
  // below the field, or above it where there is more room; a scroll of
  // anything but the list itself leaves it pointing at the wrong place, so it closes
  const list = useRef<HTMLDivElement>(null)
  const openNow = !!rect
  useEffect(() => {
    if (!openNow) return
    const scrolled = (e: Event) => { if (!list.current || !e.composedPath().includes(list.current)) setFrag(null) }
    addEventListener("scroll", scrolled, true)
    return () => removeEventListener("scroll", scrolled, true)
  }, [openNow])
  const below = rect ? innerHeight - rect.bottom - 12 : 0, above = rect ? rect.top - 12 : 0
  const up = below < 200 && above > below
  const room = Math.max(60, Math.min(320, (up ? above : below) - 36))
  return (
    <>
      <input ref={ref} style={style} value={value} placeholder={placeholder} title={rect ? undefined : title} spellCheck={false}
        onChange={(e) => { onChange(e.target.value); look(e.target.value, e.target.selectionStart) }}
        onClick={(e) => look(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setFrag(null), 120)}
        onKeyDown={(e) => {
          if (!rect) return
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length) }
          else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]) }
          else if (e.key === "Escape") { e.preventDefault(); setFrag(null) }
        }} />
      {rect && (
        <div ref={list} style={{ position: "fixed", left: rect.left, ...(up ? { bottom: innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }), width: Math.max(280, rect.width), zIndex: 2147483002, padding: 4, background: "#1c1c1f", border: "1px solid #3a3a40", borderRadius: 8, boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
          <div style={{ maxHeight: room, overflowY: "auto" }}>
            {parts.map((g) => (
              <div key={g.title}>
                {g.title && <div style={{ ...S.muted, padding: "6px 6px 2px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{g.title}</div>}
                {g.names.map((n) => {
                  const i = matches.indexOf(n)
                  const text = literal(n, theme, table).text
                  const c = colourOf(text)
                  return (
                    <div key={n} ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onMouseDown={(e) => { e.preventDefault(); pick(n) }} onMouseEnter={() => setActive(i)}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 5, cursor: "pointer", background: i === active ? "#2f2f35" : "transparent" }}>
                      <Chip c={text ?? "transparent"} />
                      <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: `11px ${MONO}` }}>{n}</code>
                      <span style={{ ...S.muted, font: `10px ${MONO}` }}>{c ? toHex(c) : ""}</span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div style={{ ...S.muted, padding: "4px 6px 2px", fontSize: 10 }}>↑↓ to move · Enter to insert var()</div>
        </div>
      )}
    </>
  )
}

// ── The panel ────────────────────────────────────────────────────────────
/** `backend` is where the stylesheets live (the dev server, unless told
 *  otherwise). `docked` lays the panel out in the page, in its container,
 *  always open: no launcher, no dragging. */
export function Playground({ backend = http, docked = false }: { backend?: Backend; docked?: boolean }) {
  const [state, setState] = useState(load)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [journal, setJournal] = useState<Change[]>(loadJournal)
  const [q, setQ] = useState("")
  const [find, setFind] = useState<string | null>(null)
  const [unusedOnly, setUnusedOnly] = useState(false)
  const [openUses, setOpenUses] = useState<string | null>(null)
  const [status, setStatus] = useState("")
  const [inspect, setInspect] = useState(false)
  // the elements picked with Inspect; the list shows only their tokens
  const [selected, setSelected] = useState<Element[]>([])
  const [picking, setPicking] = useState<{ name: string; theme: Theme; rect: DOMRect } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  // one write at a time: a Reset pressed mid-save would act on the file before the save lands
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ name: "--", value: "" })
  const { edits, deleted } = state
  const open = docked || state.open
  const pos = docked ? null : state.pos
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLDivElement>(null)
  // where the launcher stood when it was opened, and whether the panel just shrank into it
  const grewFrom = useRef<DOMRect | null>(null)
  const shrank = useRef(false)
  const switching = useRef(false)
  // the rows are built once the box has grown: building all of them first
  // held the first frame back by over a tenth of a second
  const [listReady, setListReady] = useState(true)
  // …and they fade in when they arrive, rather than appearing all at once
  // in a box that was empty a frame before
  const listRef = useRef<HTMLDivElement>(null)
  const filledLate = useRef(false)
  useLayoutEffect(() => {
    if (!listReady) { filledLate.current = true; return }
    if (!filledLate.current) return
    filledLate.current = false
    listRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" })
  }, [listReady])
  /** Holds the panel's contents at their full size while its box changes
   *  size around them, pinned to the corner the box grows from. */
  const freeze = (panel: HTMLElement, inner: HTMLElement, on: boolean) => {
    inner.style.width = on ? `${panel.clientWidth}px` : ""
    inner.style.height = on ? `${panel.clientHeight}px` : ""
    inner.style.flex = on ? "none" : ""
    panel.style.overflow = on ? "hidden" : ""
    panel.style.justifyContent = on ? (pos ? "flex-start" : "flex-end") : ""
  }
  const launcherAt = () => ({
    left: Math.min(Math.max(pos?.x ?? 0, 8), innerWidth - LAUNCHER.w - 8),
    top: Math.min(Math.max(pos?.y ?? 0, 8), innerHeight - LAUNCHER.h - 8),
  })
  const setOpenRef = useRef<(next: boolean) => void>(() => {})
  const wanted = useRef<boolean | null>(null)
  const setOpen = async (next: boolean) => {
    if (switching.current) { wanted.current = next; return }
    if (next === open) return
    const panel = panelRef.current, inner = innerRef.current
    if (next || reduced() || !panel || !inner) {
      grewFrom.current = next && !reduced() ? launcherRef.current?.getBoundingClientRect() ?? null : null
      if (grewFrom.current) setListReady(false)
      return setState((s) => ({ ...s, open: next }))
    }
    switching.current = true
    try {
      const r = panel.getBoundingClientRect()
      freeze(panel, inner, true)
      const small = { width: `${LAUNCHER.w}px`, height: `${LAUNCHER.h}px`, borderRadius: `${LAUNCHER.radius}px` }
      const big = { width: `${r.width}px`, height: `${r.height}px`, borderRadius: `${PANEL_RADIUS}px` }
      // dragged somewhere: held by its top left, which may differ for the smaller box
      const to = launcherAt()
      const frames = pos ? [{ ...big, left: `${r.left}px`, top: `${r.top}px` }, { ...small, left: `${to.left}px`, top: `${to.top}px` }] : [big, small]
      inner.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHRINK * 0.6, fill: "forwards" })
      await panel.animate(frames, { duration: SHRINK, easing: EASE, fill: "forwards" }).finished
    } catch { /* the animation was cancelled: close anyway */ } finally {
      switching.current = false
      shrank.current = true
      setState((s) => ({ ...s, open: false }))
      // asked to open again meanwhile (an Inspect click, Figma's values arriving)
      if (wanted.current) setTimeout(() => setOpenRef.current(true))
      wanted.current = null
    }
  }
  useEffect(() => { setOpenRef.current = setOpen })
  // Played once per open or close, never on a re-render (a drag re-renders
  // on every pointer move). Opening: the panel's box starts at the
  // launcher's and grows to its own. Closing: the launcher is already in
  // place where the panel ended, and only its buttons fade in.
  useLayoutEffect(() => {
    if (open) {
      const from = grewFrom.current, panel = panelRef.current, inner = innerRef.current
      grewFrom.current = null
      if (!from || !panel || !inner) { setListReady(true); return }
      const r = panel.getBoundingClientRect()
      freeze(panel, inner, true)
      const small = { width: `${from.width}px`, height: `${from.height}px`, borderRadius: `${LAUNCHER.radius}px` }
      const big = { width: `${r.width}px`, height: `${r.height}px`, borderRadius: `${PANEL_RADIUS}px` }
      const frames = pos ? [{ ...small, left: `${from.left}px`, top: `${from.top}px` }, { ...big, left: `${r.left}px`, top: `${r.top}px` }] : [small, big]
      inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: GROW })
      const grow = panel.animate(frames, { duration: GROW, easing: EASE })
      const done = () => { freeze(panel, inner, false); setListReady(true) }
      grow.finished.then(done, done)
      return () => grow.cancel()
    }
    if (shrank.current) {
      shrank.current = false
      for (const child of launcherRef.current?.children ?? []) child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90 })
    }
    // `pos` is read as it stands when the tool opens or closes
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const tokens = useMemo(() => sheet?.tokens ?? [], [sheet])
  const file = !sheet?.files.length ? "the stylesheet" : sheet.files.length === 1 ? sheet.files[0] : `${sheet.files.length} stylesheets`
  const agent = !!sheet?.agent
  const { of: groupOf, order: groupOrder } = useMemo(() => grouping(sheet), [sheet])
  const at = (w: string, h: string): CSSProperties => pos
    ? { left: `clamp(8px, ${pos.x}px, calc(100vw - ${w} - 8px))`, top: `clamp(8px, ${pos.y}px, calc(100vh - ${h} - 8px))`, bottom: "auto" }
    : {}

  // Drag by the header, or by the whole closed launcher. A press that moves
  // less than 3px is left to the click it would otherwise be; one that moves
  // swallows the click that follows it (`dragged`), so letting go of a
  // dragged launcher does not also open it.
  const dragged = useRef(false)
  const drag = (e: React.PointerEvent<HTMLElement>, box: HTMLElement | null, byControls = false) => {
    if (!box || e.button !== 0) return
    if (!byControls && (e.target as HTMLElement).closest("input, button, label")) return
    const r = box.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return
      moved = true
      ev.preventDefault()
      setState((s) => ({ ...s, pos: {
        x: Math.round(Math.min(Math.max(ev.clientX - dx, 0), innerWidth - r.width)),
        y: Math.round(Math.min(Math.max(ev.clientY - dy, 0), innerHeight - r.height)),
      } }))
    }
    // listened for on the window in the capture phase, so the drag hears
    // its own pointerup even while the Inspector is taking presses on the
    // page (it stops them there, after this has run), and a drag the
    // browser cancels still ends. No pointer capture: that would send the
    // launcher button's click to the box instead.
    const up = () => {
      removeEventListener("pointermove", move, true)
      removeEventListener("pointerup", up, true)
      removeEventListener("pointercancel", up, true)
      // only the launcher's own click needs swallowing after a drag
      dragged.current = moved && byControls
      // (the click, if one comes, is dispatched before this timer runs; a
      // drag let go off the button gets none, and must not eat the next one)
      setTimeout(() => { dragged.current = false })
      // let go by the bottom-left corner, it is back at its default: held
      // there by the corner (not by a pixel position), so it stays put when
      // the window resizes and opens upward from it
      const end = box.getBoundingClientRect()
      if (moved && end.left <= HOME && innerHeight - end.bottom <= HOME) setState((s) => ({ ...s, pos: null }))
    }
    addEventListener("pointermove", move, true)
    addEventListener("pointerup", up, true)
    addEventListener("pointercancel", up, true)
  }

  // the file as last read, for handlers that outlive the render they were
  // made in; set the moment it arrives, not a render later
  const sheetRef = useRef<Sheet | null>(null)
  const refresh = () => backend.read().then((s) => { sheetRef.current = s; setSheet(s) }).catch((e) => setStatus(String(e instanceof Error ? e.message : e)))
  // the values the agent pulled from Figma, taken in as unsaved edits: only
  // those that differ from the file, keeping a token's other theme where it
  // was edited here, and bringing back a token marked for deletion
  const takeIncoming = () => backend.incoming().then((left) => {
    const got = left as { edits?: Edits; note?: string } | null
    if (!got?.edits) return
    const file = new Map((sheetRef.current?.tokens ?? []).map((t) => [t.name, t]))
    const fresh: Edits = {}
    let n = 0
    for (const [name, e] of Object.entries(got.edits)) for (const th of THEMES) {
      const v = e[th]
      if (typeof v !== "string" || v === (file.get(name)?.[th] ?? (th === "dark" ? "" : undefined))) continue
      fresh[name] = { ...fresh[name], [th]: v }
      n++
    }
    setState((s) => {
      const next = { ...s.edits }
      for (const [name, e] of Object.entries(fresh)) next[name] = { ...next[name], ...e }
      return { ...s, edits: next, deleted: s.deleted.filter((d) => !(d in fresh)) }
    })
    if (n) setOpenRef.current(true)
    setStatus(n ? got.note || `Loaded ${n} value${n === 1 ? "" : "s"} from Figma as unsaved edits` : "Figma's values match the file: nothing to change")
    return backend.clearIncoming()
  }).catch((e) => setStatus(`Could not load Figma's values: ${e}`))

  useEffect(() => {
    // the file first, so Figma's values are compared with it
    refresh().then(takeIncoming)
    // the stylesheet changed on disk, or the agent left Figma's values
    return backend.subscribe((what) => { if (what === "css") refresh(); else takeIncoming() })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // kept after a short pause (a drag changes the position on every move),
  // and at once when the page is left
  useEffect(() => {
    const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private window */ } }
    const t = setTimeout(keep, 150)
    addEventListener("pagehide", keep)
    return () => { clearTimeout(t); removeEventListener("pagehide", keep) }
  }, [state])
  // another tab's edits are this tab's too: one set of unsaved edits, not
  // two that overwrite each other (where each tab sits stays its own)
  useEffect(() => {
    const other = (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue) return
      try {
        const s = JSON.parse(e.newValue) as Stored
        const edits = s.edits ?? {}, deleted = s.deleted ?? []
        // the same edits are no change: adopting them anyway would save this
        // tab's own position back, which the other tab would hear, and
        // answer, without end
        setState((mine) => JSON.stringify([mine.edits, mine.deleted]) === JSON.stringify([edits, deleted]) ? mine : { ...mine, edits, deleted })
      } catch { /* not ours */ }
    }
    addEventListener("storage", other)
    return () => removeEventListener("storage", other)
  }, [])
  useEffect(() => storeJournal(journal), [journal])
  useEffect(() => {
    let el = document.getElementById("swatch-style")
    if (!el) { el = document.createElement("style"); el.id = "swatch-style" }
    document.head.appendChild(el) // always last, so it wins over hot-reloaded CSS
    // nothing until the file is read: without its dark values an edit to a
    // light value would show on a dark page
    el.textContent = sheet ? css(edits, deleted, find, tokens, sheet.dark) : ""
  }, [edits, deleted, find, tokens, sheet])

  // which theme the page shows, followed as the app (or the button) flips it
  const theme = useMemo(() => themeSwitch(sheet?.dark ?? null), [sheet])
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const sync = () => setDark(theme.isDark())
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, { attributes: true })
    const mq = sheet?.dark?.media ? matchMedia(sheet.dark.media) : null
    mq?.addEventListener("change", sync)
    return () => { mo.disconnect(); mq?.removeEventListener("change", sync) }
  }, [theme, sheet])

  const setEdit = (name: string, theme: Theme, value: string | undefined) => {
    // the last action's message gives way to the live count
    setStatus("")
    setState((s) => {
      const e = { ...s.edits[name], [theme]: value }
      // back to what the file holds is no edit at all (an empty dark value
      // where the file has none is what it holds)
      const held = tokens.find((t) => t.name === name)?.[theme] ?? (theme === "dark" ? "" : undefined)
      if (value === undefined || value === held) delete e[theme]
      const next = { ...s.edits, [name]: e }
      if (!Object.keys(e).length) delete next[name]
      return { ...s, edits: next }
    })
  }
  const setDeleted = (name: string, on: boolean) => {
    setStatus("")
    setState((s) => ({ ...s, deleted: on ? [...new Set([...s.deleted, name])] : s.deleted.filter((n) => n !== name) }))
  }

  // every custom property in the themes, as the file has it: a new token's
  // name is checked against all of them, not just the colours
  const fileTable = useMemo<Table>(() => new Map(tokens.map((t) => [t.name, { light: t.light, dark: t.dark }])), [tokens])
  // the colour tokens are the ones whose saved value comes to a colour in
  // either theme; the browser decides, so red, currentColor and
  // color(display-p3 …) count as colours too
  const colourTokens = useMemo(() => tokens.filter((t) =>
    THEMES.some((th) => t[th] !== undefined && colourOf(literal(t.name, th, fileTable).text))), [tokens, fileTable])
  // the colour tokens, then any added here and not yet written
  const rows = useMemo<Token[]>(() => {
    const have = new Set(tokens.map((t) => t.name))
    return [...colourTokens, ...Object.keys(edits).filter((n) => !have.has(n)).map((name) => ({ name, uses: [], isNew: true }))]
  }, [colourTokens, tokens, edits])
  const byName = useMemo(() => new Map(tokens.map((t) => [t.name, t])), [tokens])
  // every token's value as the page now previews it
  const table = useMemo<Table>(() => {
    const m: Table = new Map()
    for (const t of [...tokens, ...rows.filter((r) => r.isNew)]) {
      if (deleted.includes(t.name)) continue
      const e = edits[t.name] ?? {}
      m.set(t.name, { light: e.light ?? t.light, dark: e.dark !== undefined ? e.dark || undefined : t.dark })
    }
    return m
  }, [tokens, rows, edits, deleted])
  // the colour tokens a value may refer to
  const names = useMemo(() => rows.map((t) => t.name).filter((n) => table.has(n)), [rows, table])
  // each section's tokens, for the reference dropdown
  const sections = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const t of rows) if (table.has(t.name)) m.set(groupOf(t), [...(m.get(groupOf(t)) ?? []), t.name])
    return m
  }, [rows, table, groupOf])

  const pending: Edit[] = [
    ...Object.entries(edits).filter(([name]) => !deleted.includes(name)).flatMap(([name, e]) =>
      (Object.entries(e) as [Theme, string][]).map(([theme, value]) => ({ name, theme, value }))),
    // a deletion removes both lines; "" is the plugin's removal
    ...deleted.flatMap((name) => THEMES.filter((th) => byName.get(name)?.[th] !== undefined).map((theme) => ({ name, theme, value: "" }))),
  ]
  const bad = pending
    .filter((p) => !deleted.includes(p.name) && !(p.theme === "dark" && p.value === ""))
    .map((p) => ({ ...p, why: problem(p.value, p.theme, table) }))
    .filter((p) => p.why)

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  // what this tab wrote and the file still holds; the rest has been
  // changed since by something else, and is left alone
  const liveOf = (j: Change[], ts: Token[]) => net(j).filter((c) => (ts.find((t) => t.name === c.name)?.[c.theme] ?? null) === c.to)
  const saved = liveOf(journal, tokens)
  const stale = net(journal).length - saved.length

  /** Writes a batch; the stylesheet afterwards, or null. What it changed
   *  goes into the journal. */
  const write = async (batch: Edit[]): Promise<{ sheet: Sheet; journal: Change[] } | null> => {
    setStatus("Saving…")
    setBusy(true)
    try {
      const body = await backend.write(batch)
      const next = [...journal, ...(body.changes ?? [])]
      sheetRef.current = body
      setSheet(body)
      setJournal(next)
      return { sheet: body, journal: next }
    } catch (e) {
      setStatus(`Could not save: ${e}`)
      return null
    } finally {
      setBusy(false)
    }
  }
  /** Drops the edits a write took, and only those: anything typed (or
   *  arrived from Figma) while it was in flight stays pending. */
  const clearSent = (batch: Edit[]) => setState((s) => {
    const next = { ...s.edits }
    const gone = new Set(batch.filter((b) => b.value === "" && s.deleted.includes(b.name)).map((b) => b.name))
    for (const b of batch) {
      if (gone.has(b.name)) { delete next[b.name]; continue }
      const e = next[b.name]
      if (!e || e[b.theme] !== b.value) continue
      const rest = { ...e }
      delete rest[b.theme]
      if (Object.keys(rest).length) next[b.name] = rest
      else delete next[b.name]
    }
    return { ...s, edits: next, deleted: s.deleted.filter((n) => !gone.has(n)) }
  })
  const ask = async (body: unknown) => {
    try { await backend.request(body); return true } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); return false }
  }

  const save = async () => {
    const batch = pending
    if (!(await write(batch))) return
    clearSent(batch)
    setStatus(`Saved ${plural(batch.length, "value")} to ${file}`)
  }
  const saveAndSend = async () => {
    let ts = tokens, j = journal
    const batch = pending
    if (batch.length) {
      const done = await write(batch)
      if (!done) return
      clearSent(batch)
      ts = done.sheet.tokens
      j = done.journal
    }
    const changes = liveOf(j, ts)
    if (!changes.length) return setStatus(`Nothing this tab wrote to ${file} is left to send`)
    if (!(await ask({ kind: "commit", changes }))) return
    // what was sent is the agent's now: Reset goes back only this far
    setJournal([])
    setStatus(`Sent ${plural(changes.length, "change")} to the agent to commit`)
  }
  const reset = async () => {
    setConfirmReset(false)
    // light lines first, so a token put back exists before its dark line
    const back = [...saved].sort((a, b) => (a.theme === b.theme ? 0 : a.theme === "light" ? -1 : 1))
      .map((c) => ({ name: c.name, theme: c.theme, value: c.from ?? "" }))
    if (back.length && !(await write(back))) return
    setJournal([])
    setState((s) => ({ ...s, edits: {}, deleted: [] }))
    setStatus((back.length ? `Reset: put back ${plural(back.length, "value")} in ${file}` : "Reset: dropped the unsaved edits")
      + (stale ? `; left ${plural(stale, "value")} changed since by something else` : ""))
  }
  const figmaSync = async () => {
    const figma = prompt("Figma file to pull the colour variables from:", state.figma)?.trim()
    if (!figma) return
    setState((s) => ({ ...s, figma }))
    if (await ask({ kind: "figma-sync", figma }))
      setStatus("Asked the agent to pull from Figma: its values arrive here as unsaved edits")
  }

  const copy = () => {
    const block = (t: Theme) => pending.filter((p) => p.theme === t).map((p) => p.value ? `    ${p.name}: ${p.value};` : `    /* remove ${p.name} */`).join("\n")
    const darkLabel = sheet?.dark?.media ? `@media ${sheet.dark.media}` : sheet?.dark?.selector.split(",")[0] ?? ".dark"
    navigator.clipboard.writeText(`/* light (:root) */\n${block("light")}\n/* dark (${darkLabel}) */\n${block("dark")}\n`)
    setStatus("Copied the pending values")
  }

  const addToken = () => {
    const name = draft.name.trim()
    if (!NAME.test(name)) return setStatus("A token name is -- then lowercase letters, digits and dashes")
    // any custom property in the themes, colour or not, already has the name
    if (table.has(name) || byName.has(name)) return setStatus(`${name} already exists in ${file}`)
    const why = problem(draft.value, "light", table)
    if (why) return setStatus(`"${draft.value}": ${why}`)
    setEdit(name, "light", draft.value.trim())
    setDraft({ name: "--", value: "" })
    setStatus(`Added ${name} (unsaved)`)
  }

  // the tokens behind the elements picked with Inspect, all of them together
  const colourNames = useMemo(() => colourTokens.map((t) => t.name), [colourTokens])
  const focus = useMemo(() => {
    const live = selected.filter((el) => el.isConnected)
    if (!live.length) return null
    const found = new Set(live.flatMap((el) => tokensIn(inspectEl(el, colourNames))))
    return { label: live.length === 1 ? describe(live[0]) : `${live.length} elements`, all: live.map(describe), names: [...found] }
    // the edits change what each token resolves to, so what matches
    // …and so does the theme the page is showing
  }, [selected, colourNames, table, dark]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const only = focus ? new Set(focus.names) : null
    return rows.filter((t) => {
      if (only && !only.has(t.name)) return false
      if (unusedOnly && (t.isNew || t.uses.length)) return false
      if (!needle) return true
      const e = edits[t.name] ?? {}
      return [t.name, t.light, t.dark, e.light, e.dark].some((v) => v?.toLowerCase().includes(needle))
    })
  }, [rows, q, unusedOnly, focus, edits])

  const grouped = useMemo(() => {
    const m = new Map<string, Token[]>()
    for (const t of shown) { const g = groupOf(t); m.set(g, [...(m.get(g) ?? []), t]) }
    return groupOrder.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const)
  }, [shown, groupOf, groupOrder])

  // a click picks one element, a shift-click adds it (or takes it back out)
  const onSelect = (el: Element, add: boolean) => {
    // elements the page has since removed are dropped on the way
    setSelected((s) => add ? (s.includes(el) ? s.filter((x) => x !== el) : [...s.filter((x) => x.isConnected), el]) : [el])
    setQ("")
    setOpen(true)
  }
  const inspector = inspect && <Inspector names={colourNames} selected={selected} onSelect={onSelect} onExit={() => setInspect(false)} />
  const inspectBtn = (
    <button style={{ ...S.btn, background: inspect ? FIND : S.btn.background, color: inspect ? "#000" : S.btn.color }}
      onClick={() => setInspect((v) => !v)} title="Hover anything for its tokens; click to select it, shift-click to add more; Esc to stop">
      ⌖ Inspect
    </button>
  )
  const picker = picking && (() => {
    const t = rows.find((r) => r.name === picking.name)
    const raw = edits[picking.name]?.[picking.theme] ?? t?.[picking.theme] ?? ""
    return <Picker key={`${picking.name}:${picking.theme}`} value={raw} resolved={literal(picking.name, picking.theme, table).text}
      anchor={picking.rect} onChange={(v) => setEdit(picking.name, picking.theme, v)} onClose={() => setPicking(null)} />
  })()

  const cell = (t: Token, theme: Theme): ReactNode => {
    const isDeleted = deleted.includes(t.name)
    const edited = edits[t.name]?.[theme]
    const saved = t[theme]
    const value = edited ?? saved ?? ""
    const lit = literal(t.name, theme, table)
    const shownColour = lit.text ?? "transparent"
    const why = edited !== undefined && !(theme === "dark" && edited === "") ? problem(edited, theme, table) : null
    const invalid = !!why
    const surface = surfaceOf(t.name, table)
    const ratio = surface && !isDeleted ? contrast(t.name, surface, theme, table) : null
    const resolved = colourOf(lit.text)
    // a plain alias shows the chain it follows; a mix (color-mix() over
    // tokens) only what it comes to
    const raw = value || t.light || ""
    const chain = resolved ? (/^var\(--[\w-]+\)$/.test(raw.trim()) ? `→ ${[...lit.via.slice(1), toHex(resolved)].join(" → ")}` : `= ${toHex(resolved)}`) : ""
    const border = invalid ? "#ff6b6b" : edited !== undefined ? "#ffd479" : "#3a3a40"
    return (
      <span key={theme} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, opacity: isDeleted ? 0.4 : 1, paddingRight: theme === "light" ? THEME_GAP : 0 }}>
        <span style={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0 }}>
          <button type="button" style={S.swatch} disabled={isDeleted} title="Open the colour picker"
            onClick={(e) => setPicking({ name: t.name, theme, rect: e.currentTarget.getBoundingClientRect() })}>
            <span style={{ position: "absolute", inset: 0, background: shownColour }} />
          </button>
          <ValueInput value={value} names={names.filter((n) => n !== t.name)} section={sections.get(groupOf(t))} table={table} theme={theme}
            onChange={(v) => setEdit(t.name, theme, v)}
            style={{ ...S.input, borderColor: border, textDecoration: isDeleted ? "line-through" : undefined }}
            placeholder={theme === "dark" ? "inherits light" : ""}
            title={why ? `Can't save: ${why}` : saved !== undefined ? `saved: ${saved}` : "not set in this theme"} />
          {edited !== undefined && <button style={{ ...S.btn, padding: "1px 5px" }} title="Undo" onClick={() => setEdit(t.name, theme, undefined)}>↺</button>}
          {ratio !== null && (
            <span title={`Contrast on ${surface} in ${theme}: ${ratio.toFixed(2)}:1 (body text needs 4.5, large text 3)`}
              style={{ flexShrink: 0, padding: "1px 4px", borderRadius: 4, font: `600 10px ${MONO}`, color: "#111", background: ratio >= 4.5 ? "#5ad18a" : ratio >= 3 ? "#f2c14e" : "#ff7a7a" }}>
              {ratio.toFixed(1)}
            </span>
          )}
        </span>
        {/* an alias, followed to the colour it lands on */}
        {lit.via.length > 1 && resolved && (
          <span style={{ ...S.muted, paddingLeft: 26, font: `10px ${MONO}`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={chain}>
            {chain}
          </span>
        )}
      </span>
    )
  }

  // Built again only when something the rows show has changed: not on a
  // drag (the position changes on every pointer move), nor while collapsed.
  const list = useMemo(() => !open || !listReady ? <div style={{ flex: 1 }} /> : (
    <div ref={listRef} style={{ overflow: "auto", flex: 1, padding: "4px 12px 12px" }}>
      {grouped.length === 0 && (
        <div style={{ ...S.muted, padding: "24px 0", textAlign: "center" }}>
          {focus ? "No colour token behind this element." : "No token matches."}
        </div>
      )}
      {grouped.map(([g, list]) => (
        <div key={g}>
          {/* one section needs no title */}
          {grouped.length > 1 && <div style={{ margin: "10px 0 4px", color: "#8a8a92", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 10 }}>{g}</div>}
          {list.map((t) => {
            const total = t.uses.reduce((n, u) => n + u.n, 0)
            const isDeleted = deleted.includes(t.name)
            return (
              <div key={t.name}>
                <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, alignItems: "start", padding: "3px 0" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: 22 }}>
                    <button
                      style={{ ...S.btn, padding: "1px 5px", fontSize: 10, background: find === t.name ? FIND : S.btn.background }}
                      onPointerDown={() => setFind(t.name)} onPointerUp={() => setFind(null)} onPointerLeave={() => setFind(null)}
                      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") setFind(t.name) }} onKeyUp={() => setFind(null)} onBlur={() => setFind(null)}
                      title="Hold to paint this token magenta on the page"
                    >Find</button>
                    <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: `11px ${MONO}`, color: isDeleted ? "#ff7a7a" : edits[t.name] ? "#ffd479" : undefined, textDecoration: isDeleted ? "line-through" : undefined }} title={t.name}>{t.name}</code>
                  </span>
                  {THEMES.map((theme) => cell(t, theme))}
                  <button style={{ ...S.btn, padding: "1px 6px", color: t.isNew ? "#8a8a92" : total ? "#ececec" : "#ff8080" }} onClick={() => setOpenUses(openUses === t.name ? null : t.name)}>{t.isNew ? "new" : total}</button>
                </div>
                {openUses === t.name && (
                  <div style={{ margin: "2px 0 8px 0", padding: 8, background: "#141416", borderRadius: 6, color: "#bbb", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      {t.isNew ? "Added here; not in a stylesheet yet." : t.uses.length ? t.uses.map((u) => <div key={u.file}><code>{u.file}</code> × {u.n}</div>) : "Not used anywhere in the project (a candidate to delete)."}
                      {t.file && (sheet?.files.length ?? 0) > 1 && <div style={{ ...S.muted, marginTop: 4 }}>Declared in <code>{t.file}</code></div>}
                    </div>
                    {t.isNew
                      ? <button style={S.btn} onClick={() => { setEdit(t.name, "light", undefined); setEdit(t.name, "dark", undefined) }}>Remove</button>
                      : <button style={{ ...S.btn, color: isDeleted ? "#ececec" : "#ff8080" }} onClick={() => setDeleted(t.name, !isDeleted)}
                          title={total ? `Still used ${total} times: those uses fall back once it is gone` : "Removes it from both themes on save"}>
                          {isDeleted ? "Keep token" : "Delete token"}
                        </button>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {!focus && (
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, alignItems: "center", marginTop: 14, paddingTop: 10, borderTop: "1px solid #2a2a2e" }}>
          <input style={S.input} value={draft.name} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} aria-label="New token name" />
          <span style={{ paddingRight: THEME_GAP, minWidth: 0 }}>
            <ValueInput value={draft.value} names={names} table={table} theme="light" placeholder="light value, or - for a token"
              onChange={(v) => setDraft((d) => ({ ...d, value: v }))} style={S.input} />
          </span>
          <span style={{ ...S.muted, fontSize: 11 }}>dark inherits light</span>
          <button style={S.btn} onClick={addToken}>Add</button>
        </div>
      )}
    </div>
  // every value the rows and their handlers read
  ), [open, listReady, grouped, edits, deleted, table, names, sections, tokens, byName, find, openUses, draft, focus]) // eslint-disable-line react-hooks/exhaustive-deps


  // Minimized: two 40px round icon buttons on one draggable pill. The
  // editor shows its unsaved count as a badge; Inspect turns magenta while on.
  const iconBtn: CSSProperties = { ...S.btn, position: "relative", width: 40, height: 40, padding: 0, display: "grid", placeItems: "center", borderRadius: 999, border: "none" }
  if (!open) return (
    <>
      <div ref={launcherRef} data-swatch style={{ ...S.fab, padding: 4, display: "flex", gap: 4, cursor: "grab", userSelect: "none", ...at("92px", "48px") }}
        onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("[data-inspect-btn]")) drag(e, e.currentTarget, true) }}>
        {/* a real button, so the keyboard reaches the editor too (Tab, then Enter) */}
        <button
          type="button"
          style={{ ...iconBtn, background: "transparent", cursor: "inherit" }}
          onClick={() => { if (dragged.current) { dragged.current = false; return } setOpen(true) }}
          title={`Open Swatch${pending.length ? ` (${plural(pending.length, "unsaved change")})` : ""}; drag to move`}
          aria-label="Open Swatch"
        >
          <Icon />
          {pending.length > 0 && (
            <span style={{ position: "absolute", top: 2, right: 2, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 99, background: "#ffd479", color: "#111", font: `600 10px/16px ${FONT}`, textAlign: "center" }}>{pending.length}</span>
          )}
        </button>
        <span data-inspect-btn style={{ display: "flex" }}>
          <button style={{ ...iconBtn, background: inspect ? FIND : S.btn.background, color: inspect ? "#000" : S.btn.color, fontSize: 18 }}
            onClick={() => setInspect((v) => !v)} title="Inspect: hover anything for its tokens; click to pin it and filter the list to them; Esc to stop" aria-label="Inspect">
            ⌖
          </button>
        </span>
      </div>
      {inspector}
    </>
  )

  return (
    <>
    {inspector}
    {picker}
    <div ref={panelRef} style={{ ...S.panel, ...(docked ? DOCKED : at("min(720px, 100vw - 32px)", "min(80vh, 800px)")) }} data-swatch>
      <div ref={innerRef} style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>
      {/* the whole header drags the panel; its fields and buttons keep their own presses */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #333", display: "flex", flexDirection: "column", gap: 8, cursor: docked ? "default" : "grab", userSelect: "none" }}
        onPointerDown={(e) => { if (!docked) drag(e, e.currentTarget.parentElement) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {focus && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 4px 4px 8px", background: "#3a1f3a", border: `1px solid ${FIND}`, borderRadius: 6, whiteSpace: "nowrap", maxWidth: "40%", cursor: "default" }}
              title={`Showing the ${plural(focus.names.length, "token")} behind ${focus.all.join(", ")}`}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", font: `11px ${MONO}` }}>⌖ {focus.label}</span>
              <span style={S.muted}>{focus.names.length}</span>
              <button style={{ ...S.btn, padding: "0 5px", background: "transparent", border: "none" }} onClick={() => setSelected([])} title="Show every token">✕</button>
            </span>
          )}
          <strong style={{ fontSize: 13, flex: 1, display: "flex", alignItems: "center", gap: 6 }}><Icon size={18} /> Swatch</strong>
          <label style={{ display: "flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} /> unused
          </label>
          {inspectBtn}
          <button style={off(S.btn, !theme.toggle)} disabled={!theme.toggle} onClick={() => theme.toggle?.()}
            title={theme.toggle ? "Preview only: the app's own switch is the one that sticks" : "The dark theme follows the system's setting"}>{dark ? "☾ Dark" : "☀ Light"}</button>
          {!docked && <button style={S.btn} onClick={() => setOpen(false)} title="Close">✕</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input placeholder={focus ? "Filter these tokens" : "Search tokens by name or value"} value={q} onChange={(e) => setQ(e.target.value)}
            style={{ ...S.input, flex: 1, padding: "6px 10px", borderRadius: 7, font: `13px ${FONT}` }} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, padding: "6px 12px", color: "#999", borderBottom: "1px solid #2a2a2e" }}>
          <span>Token</span><span style={{ fontWeight: dark ? 400 : 700, color: dark ? "#999" : "#fff", paddingRight: THEME_GAP }}>Light</span><span style={{ fontWeight: dark ? 700 : 400, color: dark ? "#fff" : "#999" }}>Dark</span><span>Uses</span>
      </div>
      {list}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderTop: "1px solid #333" }}>
        <span style={{ flex: 1, color: bad.length ? "#ff8080" : "#aaa" }}>
          {bad.length ? `Can't save ${plural(bad.length, "value")}: ${bad.slice(0, 2).map((b) => `${b.name} (${b.why})`).join(", ")}`
            : status || (pending.length ? `${plural(pending.length, "unsaved change")} (previewing live)`
              : saved.length ? `${plural(saved.length, "saved change")} this session${agent ? ", not sent to the agent" : ""}` : `${shown.length} of ${rows.length} tokens`)}
        </span>
        {(() => {
          const none = !saved.length && !pending.length
          const canSave = !busy && !!pending.length && !bad.length
          const canSend = !busy && !none && !bad.length
          return <>
            <button style={off(S.btn, !pending.length)} disabled={!pending.length} onClick={copy} title="Copy the unsaved values as CSS">Copy CSS</button>
            {agent && <button style={off(S.btn, busy)} disabled={busy} onClick={figmaSync} title={state.figma ? `Ask the agent to pull the colour variables from ${state.figma}` : "Ask the agent to pull the colour variables from a Figma file"}>Figma sync</button>}
            {/* off until something has changed; a second press confirms */}
            <button style={off(S.btn, busy || none)} disabled={busy || none}
              onClick={() => confirmReset ? reset() : setConfirmReset(true)} onBlur={() => setConfirmReset(false)}
              title={`Undo everything this session: the unsaved edits, and what this tab has saved to ${file}`}>
              {confirmReset ? `Reset ${plural(saved.length + pending.length, "change")}?` : "Reset"}
            </button>
            <button style={off({ ...S.btn, ...(agent ? {} : { background: canSave ? "#f25a43" : S.btn.background, borderColor: "transparent" }) }, !canSave)} disabled={!canSave} onClick={save} title={`Write the unsaved values into ${file}`}>Save</button>
            {agent && (
              <button style={off({ ...S.btn, background: canSend ? "#f25a43" : S.btn.background, borderColor: "transparent" }, !canSend)}
                disabled={!canSend} onClick={saveAndSend}
                title="Save, then ask the agent to commit every change this tab has saved">Save & send to agent</button>
            )}
          </>
        })()}
      </div>
      </div>
    </div>
    </>
  )
}

// ── Inspector ────────────────────────────────────────────────────────────
// Hover an element for the tokens behind its background, text and border;
// click pins the tooltip, filters the panel to those tokens, and
// swallows the click (so links don't navigate while inspecting); Esc
// unpins, then stops. A token is named from the element's own classes where
// it has one (bg-card, hover:bg-accent/60), otherwise by matching the
// computed colour against every token resolved in the element's own theme
// context, which catches plain CSS rules and inline var(--x) styles.

type Line = { label: string; tokens: string[]; color?: string; note?: string }
type Contrast = { ratio: number; large: boolean; fg: string; bg: string; ownText: boolean; gradient: boolean }
type Info = { el: string; bg: Line[]; text: Line[]; border: Line[]; fill: Line[]; contrast: Contrast | null }

/** The element's text colour against what is actually behind it: every
 *  translucent background up the tree, laid over the first opaque one (or
 *  the canvas, white or black by the page's color-scheme). WCAG 2's ratio
 *  and its large-text rule: 24px, or 18.66px bold. */
function contrastOf(el: Element): Contrast | null {
  const cs = getComputedStyle(el)
  const fg = colourOf(cs.color)
  if (!fg) return null
  const layers: RGBA[] = []
  let gradient = false
  for (let a: Element | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a)
    if (s.backgroundImage !== "none") gradient = true
    const c = colourOf(s.backgroundColor)
    if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break }
  }
  const canvas = /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? BLACK : WHITE
  const r = ratio(fg, layers, canvas)
  const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight) || 400
  const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
  return { ratio: r.ratio, large: size >= 24 || (size >= 18.66 && weight >= 700), fg: toHex(r.fg), bg: toHex(r.bg), ownText, gradient }
}

const UTIL = /^((?:[\w-]+(?:\[[^\]]*\])?:)*)(bg|text|border(?:-[trblxy])?|ring|outline|divide)-([a-z][\w-]*?)(?:\/(\d+|\[[^\]]+\]))?$/
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)

function describe(el: Element) {
  const cls = classesOf(el).filter((c) => !c.includes(":")).slice(0, 3).join(".")
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? "." + cls : ""}`
}

// every token as a colour where `el` sits, read from its computed style
// (each custom property comes back with its var()s already substituted in
// that element's own theme), so nothing is added to the page being
// inspected
const keyOf = (c: RGBA) => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a.toFixed(2)}`
function resolve(el: Element, names: string[]) {
  const cs = getComputedStyle(el)
  const map = new Map<string, string[]>()
  for (const n of names) {
    const c = colourOf(cs.getPropertyValue(n).trim())
    if (!c || c.a === 0) continue
    const k = keyOf(c)
    map.set(k, [...(map.get(k) ?? []), n])
  }
  return map
}

function fromClasses(el: Element, kinds: RegExp, names: Set<string>): Line[] {
  const out: Line[] = []
  for (const c of classesOf(el)) {
    const m = UTIL.exec(c)
    // bg-brand is --brand, or Tailwind's own --color-brand
    const token = m && [`--${m[3]}`, `--color-${m[3]}`].find((n) => names.has(n))
    if (!m || !kinds.test(m[2]) || !token) continue
    out.push({ label: m[1] ? m[1].replace(/:$/, "").replace(/:/g, " ") : "", tokens: [token], note: `${m[2]}-${m[3]}${m[4] ? "/" + m[4] : ""}` })
  }
  return out
}

function inspectEl(el: Element, names: string[]): Info {
  const set = new Set(names)
  const map = resolve(el, names)
  const match = (c: string) => { const rgba = colourOf(c); return rgba ? map.get(keyOf(rgba)) ?? [] : [] }
  const cs = getComputedStyle(el)

  // background: the element's own, or the nearest ancestor's that shows through
  const bg: Line[] = []
  let src: Element | null = el
  while (src && TRANSPARENT.test(getComputedStyle(src).backgroundColor) && !fromClasses(src, /^bg$/, set).length) src = src.parentElement
  if (src) {
    const c = getComputedStyle(src).backgroundColor
    const own = fromClasses(src, /^bg$/, set)
    const rest = own.filter((l) => l.label)
    const base = own.filter((l) => !l.label)
    bg.push({ label: src === el ? "" : `from ${describe(src)}`, tokens: base.length ? base.flatMap((l) => l.tokens) : match(c), color: c, note: base.map((l) => l.note).join(" ") || (match(c).length ? "via CSS" : "no token matches") })
    bg.push(...rest)
  }
  if (cs.backgroundImage !== "none" && src === el) bg.push({ label: "image", tokens: [], note: cs.backgroundImage.slice(0, 60) })

  // text: its own class, else the nearest ancestor's, else the computed colour
  const text: Line[] = []
  let tsrc: Element | null = el
  while (tsrc && !fromClasses(tsrc, /^text$/, set).length) tsrc = tsrc.parentElement
  const tc = cs.color
  const tOwn = tsrc ? fromClasses(tsrc, /^text$/, set) : []
  const tBase = tOwn.filter((l) => !l.label)
  text.push({ label: tsrc && tsrc !== el && tBase.length ? `from ${describe(tsrc)}` : "", tokens: tBase.length ? tBase.flatMap((l) => l.tokens) : match(tc), color: tc, note: tBase.map((l) => l.note).join(" ") || (match(tc).length ? "via CSS" : "no token matches") })
  if (tsrc === el) text.push(...tOwn.filter((l) => l.label))

  // border: widths that are drawn, then any ring / outline classes
  const border: Line[] = []
  const widths = ["Top", "Right", "Bottom", "Left"].map((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)))
  const bclasses = fromClasses(el, /^(border|ring|outline|divide)/, set)
  if (widths.some((w) => w > 0)) {
    const c = cs.borderTopColor
    const base = bclasses.filter((l) => !l.label && l.note!.startsWith("border"))
    border.push({ label: `${[...new Set(widths)].join("/")}px`, tokens: base.length ? base.flatMap((l) => l.tokens) : match(c), color: c, note: base.map((l) => l.note).join(" ") || (match(c).length ? "via CSS" : "no token matches") })
  }
  border.push(...bclasses.filter((l) => l.label || !l.note!.startsWith("border")))
  if (!border.length) border.push({ label: "", tokens: [], note: "none" })

  // a drawn shape (SVG): what it is filled and stroked with
  const fill: Line[] = []
  if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) {
    for (const [label, c] of [["", cs.fill], ["stroke", cs.stroke]] as const) {
      if (!c || c === "none") continue
      const paint = /^url\(/.test(c)
      if (label === "stroke" && !match(c).length && !paint) continue
      fill.push({ label, tokens: paint ? [] : match(c), color: paint ? undefined : c, note: paint ? "a gradient or pattern" : match(c).length ? "" : "no token matches" })
    }
  }
  return { el: describe(el), bg, text, border, fill, contrast: fill.length ? null : contrastOf(el) }
}

// a shape is its fill; anything else is its background, text and border
const tokensIn = (info: Info) => [...new Set((info.fill.length ? info.fill : [...info.bg, ...info.text, ...info.border]).flatMap((l) => l.tokens))]

/** Inspect mode. Hovering outlines an element (dashed) and shows the tokens
 *  behind it; a click selects it (solid outline) and the panel lists only
 *  its tokens; a click elsewhere moves the selection there; a shift-click
 *  adds an element to the selection, or takes a selected one back out.
 *  Hovering keeps working with a selection made. Esc stops inspecting; the
 *  selection stays as the panel's filter until its chip is cleared. */
export function Inspector({ names, selected, onSelect, onExit }: {
  names: string[]; selected: Element[]; onSelect: (el: Element, add: boolean) => void; onExit: () => void
}) {
  const [hit, setHit] = useState<{ el: Element; info: Info } | null>(null)
  const [at, setAt] = useState({ x: 0, y: 0 })
  // outlines follow their elements through scrolling and resizing
  const [, setTick] = useState(0)
  // the latest props, for listeners added once
  const live = useRef({ names, onSelect, onExit })
  useEffect(() => { live.current = { names, onSelect, onExit } })

  useEffect(() => {
    // (events from inside the shadow root arrive here with the host as their target)
    const mine = (t: EventTarget | null) => t instanceof Element && !!t.closest("#swatch-host")
    let last: Element | null = null
    const move = (e: PointerEvent) => {
      setAt({ x: e.clientX, y: e.clientY })
      const t = e.target as Element
      if (mine(t)) { last = null; return setHit(null) }
      if (t === last) return
      last = t
      setHit({ el: t, info: inspectEl(t, live.current.names) })
    }
    // the page under the inspector does nothing with a press: no link
    // followed, no menu opened, no focus moved
    const swallow = (e: Event) => { if (mine(e.target)) return; e.preventDefault(); e.stopPropagation() }
    const click = (e: MouseEvent) => {
      if (mine(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      live.current.onSelect(e.target as Element, e.shiftKey)
    }
    // Esc is the inspector's here, not an open dialog's
    // (but the panel's own: an open picker, or a field's dropdown, closes first)
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || mine(e.target) || shadow()?.querySelector("[data-swatch-picker]")) return
      e.preventDefault(); e.stopPropagation(); live.current.onExit()
    }
    const redraw = () => setTick((n) => n + 1)
    addEventListener("pointermove", move, true)
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) addEventListener(t, swallow, true)
    addEventListener("click", click, true)
    addEventListener("keydown", key, true)
    addEventListener("scroll", redraw, true)
    addEventListener("resize", redraw)
    document.documentElement.style.cursor = "crosshair"
    return () => {
      removeEventListener("pointermove", move, true)
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) removeEventListener(t, swallow, true)
      removeEventListener("click", click, true)
      removeEventListener("keydown", key, true)
      removeEventListener("scroll", redraw, true)
      removeEventListener("resize", redraw)
      document.documentElement.style.cursor = ""
    }
  }, [])

  const W = 340
  const left = at.x + 16 + W > innerWidth ? at.x - W - 12 : at.x + 16
  const row = (title: string, lines: Line[]) => (
    <div style={{ display: "grid", gridTemplateColumns: "74px 1fr", gap: 6, padding: "4px 0", borderTop: "1px solid #2e2e33" }}>
      <span style={S.muted}>{title}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {l.color && <Chip c={l.color} />}
            {l.label && <span style={S.muted}>{l.label}:</span>}
            {l.tokens.map((t) => <code key={t} style={{ color: "#ffd479" }}>{t}</code>)}
            {l.note && <span style={{ color: "#aaa" }}>{l.note}</span>}
          </div>
        ))}
      </div>
    </div>
  )
  const box = (r: DOMRect, solid: boolean): CSSProperties => ({
    position: "fixed", left: r.left, top: r.top, width: r.width, height: r.height, outlineOffset: -1,
    outline: `2px ${solid ? "solid" : "dashed"} ${FIND}`, background: solid ? "rgba(255,0,255,.08)" : "rgba(255,0,255,.04)",
  })
  const picked = selected.filter((el) => el.isConnected)
  const hovered = hit && hit.el.isConnected ? hit : null
  const isPicked = hovered ? picked.includes(hovered.el) : false
  // the outlines sit under the panel (one below its layer), so the panel
  // is never covered by a selection behind it; the tooltip stays on top
  return (
    <>
    <div data-swatch style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147482999 }}>
      {picked.map((el, i) => {
        const r = el.getBoundingClientRect()
        return (
          <div key={i} style={box(r, true)}>
            <span style={{ position: "absolute", left: -1, top: r.top < 18 ? "100%" : -18, padding: "1px 5px", background: FIND, color: "#000", font: `600 10px/16px ${FONT}`, whiteSpace: "nowrap", borderRadius: 3 }}>
              {picked.length > 1 ? `${i + 1} · ` : ""}{describe(el)}
            </span>
          </div>
        )
      })}
      {hovered && !isPicked && <div style={box(hovered.el.getBoundingClientRect(), false)} />}
    </div>
    <div data-swatch style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147483001 }}>
      {hovered && (
        <div style={{ position: "fixed", left, top: Math.min(at.y + 16, innerHeight - 250), width: W, padding: "8px 10px", background: "#1c1c1f", color: "#ececec", border: `1px solid ${isPicked ? FIND : "#333"}`, borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,.45)", font: `11px/1.4 ${FONT}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, paddingBottom: 4 }}>
            <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hovered.info.el}</code>
            <span style={{ ...S.muted, whiteSpace: "nowrap" }}>
              {isPicked ? "selected · ⇧-click to remove" : picked.length ? "click to select · ⇧-click to add" : "click to select"}
            </span>
          </div>
          {hovered.info.fill.length > 0 ? row("Fill", hovered.info.fill) : <>
            {row("Background", hovered.info.bg)}
            {row("Text", hovered.info.text)}
            {row("Border", hovered.info.border)}
          </>}
          {hovered.info.contrast && <ContrastRow c={hovered.info.contrast} />}
        </div>
      )}
    </div>
    </>
  )
}

function ContrastRow({ c }: { c: Contrast }) {
  const aa = c.large ? 3 : 4.5, aaa = c.large ? 4.5 : 7
  const pass = (ok: boolean, label: string, need: number) => (
    <span title={`${label} needs ${need}:1 for ${c.large ? "large" : "body"} text`}
      style={{ padding: "0 5px", borderRadius: 4, font: `600 10px ${MONO}`, color: "#111", background: ok ? "#5ad18a" : "#ff7a7a" }}>
      {label} {ok ? "✓" : "✗"}
    </span>
  )
  return (
    <div style={{ display: "grid", gridTemplateColumns: "74px 1fr", gap: 6, padding: "4px 0", borderTop: "1px solid #2e2e33" }}>
      <span style={S.muted}>WCAG</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Chip c={c.fg} /><span style={S.muted}>on</span><Chip c={c.bg} />
          <strong style={{ font: `600 11px ${MONO}` }}>{c.ratio.toFixed(2)}:1</strong>
          {pass(c.ratio >= aa, "AA", aa)}
          {pass(c.ratio >= aaa, "AAA", aaa)}
          <span style={S.muted}>{c.large ? "large text" : "body text"}</span>
        </div>
        {(!c.ownText || c.gradient) && (
          <span style={{ color: "#aaa" }}>
            {!c.ownText ? "No text of its own: the colour its text would take. " : ""}
            {c.gradient ? "A gradient sits behind it: measured on the solid colour only." : ""}
          </span>
        )}
      </div>
    </div>
  )
}
