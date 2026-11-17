// Reading and writing one stylesheet's custom properties: text in, text
// out. Nothing here touches the disk (files.ts does), so the same code
// runs in a browser, which is how the website's live demo works.
//
// The file is parsed with PostCSS and never matched as text: an edit
// changes one declaration node and the file is printed back with every
// other byte as it was, so comments, @media and @layer blocks, !important,
// strings with semicolons in them and two declarations on one line all
// come through untouched.
import postcss, { type AtRule, type Container, type Declaration, type Root, type Rule } from "postcss"

export type Theme = "light" | "dark"
export const THEMES: Theme[] = ["light", "dark"]
export type Edit = { theme: Theme; name: string; value: string }
export type Change = { name: string; theme: Theme; from: string | null; to: string | null }

// ── Which blocks are a theme ─────────────────────────────────────────────
// Light is :root or html at the top level (or only inside @layer), and
// Tailwind's `@theme { … }` block, whose properties land on :root. Dark is a
// rule whose first selector names a dark class or attribute (.dark,
// [data-theme="dark"], html.dark …), or :root inside
// @media (prefers-color-scheme: dark). Anything else is not a theme and is
// never read as one or written to: a :root inside @media (min-width), a
// component rule, and `@theme inline`, which maps names to tokens declared
// elsewhere rather than declaring any.
const LIGHT_SEL = /^(:root|html|:root,\s*html|html,\s*:root)$/
const DARK_FIRST = /^(:root|html)?(\.dark|\[data-(theme|mode|color-scheme)=["']?dark["']?\])$/
const DARK_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/

/** A block that holds a theme's declarations: a rule, or an `@theme` block. */
type Block = Rule | AtRule

/** The media query a block sits in, when it is the dark preference; null
 *  with `ok: false` when it sits inside anything else that is not a layer. */
function enclosing(block: Block): { media: string | null; ok: boolean } {
  let media: string | null = null
  for (let p = block.parent as Container | undefined; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type !== "atrule") return { media, ok: false }
    const at = p as AtRule
    if (at.name === "layer") continue
    if (at.name === "media" && DARK_MEDIA.test(at.params.trim()) && !media) { media = at.params; continue }
    return { media, ok: false }
  }
  return { media, ok: true }
}

function contextOf(block: Block): { theme: Theme | null; media: string | null } {
  const { media, ok } = enclosing(block)
  if (!ok) return { theme: null, media }
  if (block.type === "atrule") {
    // `@theme`, `@theme static`: declarations. `@theme inline` / `reference`: mappings.
    const declares = block.name === "theme" && !/\b(inline|reference)\b/.test(block.params)
    return { theme: declares && !media ? "light" : null, media }
  }
  const sel = block.selector.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim()
  if (media) return { theme: LIGHT_SEL.test(sel) ? "dark" : null, media }
  if (LIGHT_SEL.test(sel)) return { theme: "light", media }
  const first = sel.split(",")[0].trim()
  return { theme: DARK_FIRST.test(first) ? "dark" : null, media }
}

type Found = { decl: Declaration; theme: Theme }
export type DarkSelector = { selector: string; media: string | null }
export type Parsed = { root: Root; decls: Found[]; blocks: Record<Theme, Block[]>; dark: DarkSelector | null }

export function parse(css: string, from: string): Parsed {
  const root = postcss.parse(css, { from })
  const decls: Found[] = []
  const blocks: Record<Theme, Block[]> = { light: [], dark: [] }
  let dark: DarkSelector | null = null
  const take = (block: Block) => {
    const { theme, media } = contextOf(block)
    if (!theme) return
    blocks[theme].push(block)
    if (theme === "dark" && !dark && block.type === "rule") dark = { selector: block.selector.replace(/\s+/g, " ").trim(), media }
    for (const node of block.nodes ?? []) if (node.type === "decl" && node.prop.startsWith("--")) decls.push({ decl: node, theme })
  }
  root.walk((node) => {
    if (node.type === "rule") take(node)
    else if (node.type === "atrule" && node.name === "theme") take(node)
  })
  return { root, decls, blocks, dark }
}

/** A declaration's value as the panel shows it. */
export const shown = (d: Declaration | undefined) => d ? d.value.trim() + (d.important ? " !important" : "") : null

/** Every custom property of the two themes in one stylesheet. The last
 *  declaration in a theme is the one the cascade uses. */
export function readText(css: string, from = "stylesheet.css") {
  const { decls, dark } = parse(css, from)
  const tokens = new Map<string, { light?: string; dark?: string }>()
  for (const { decl, theme } of decls) {
    const t = tokens.get(decl.prop) ?? {}
    t[theme] = shown(decl)!
    tokens.set(decl.prop, t)
  }
  return { tokens, dark }
}

export function check(e: Edit) {
  if (!e || typeof e !== "object") throw new Error("bad edit")
  if (!THEMES.includes(e.theme)) throw new Error(`unknown theme "${e.theme}"`)
  if (typeof e.name !== "string" || !/^--[a-zA-Z0-9_-]+$/.test(e.name)) throw new Error(`bad token name "${e.name}"`)
  // a backslash escapes the next character (a CSS escape such as \201C is
  // fine); one at the very end would escape the semicolon after it
  if (typeof e.value !== "string" || /[;{}\n\r]/.test(e.value) || /(^|[^\\])(\\\\)*\\\s*$/.test(e.value) || e.value.length > 2000) throw new Error(`bad value for ${e.name}`)
  if (e.value.trim() === "") return
  // the value must stand as one declaration's value: an unclosed comment,
  // quote or bracket would swallow whatever follows it in the file
  try {
    const rule = postcss.parse(`a{--x:${e.value}}`).first
    if (rule?.type !== "rule" || rule.nodes.length !== 1 || rule.first?.type !== "decl") throw new Error()
    if (/\/\*/.test(e.value)) throw new Error()
  } catch {
    throw new Error(`bad value for ${e.name}: ${e.value}`)
  }
}

/** The stylesheet with a batch of edits applied, and what each changed. A
 *  failed check, or a result that would not read back as a stylesheet,
 *  throws and gives nothing. */
/** `darkAt` is how the project selects its dark theme, used when this
 *  stylesheet has no dark block yet and needs one (".dark" without it). */
export function writeText(css: string, edits: Edit[], from = "stylesheet.css", darkAt?: DarkSelector | null): { css: string; changes: Change[] } {
  edits.forEach(check)
  const parsed = parse(css, from)
  const changes: Change[] = []
  // the last declaration of the name in each block: a token declared in two
  // blocks of one theme (dark under a class and under the system's
  // preference, say) is one token, and an edit reaches both
  const lastPerBlock = (theme: Theme, name: string) => {
    const m = new Map<unknown, Found>()
    for (const d of parsed.decls) if (d.theme === theme && d.decl.prop === name) m.set(d.decl.parent, d)
    return [...m.values()]
  }
  const drop = (d: Found) => {
    const decl = d.decl, block = decl.parent as Block
    // the comment after it on its own line was about it, and goes with it
    const next = decl.next()
    if (next?.type === "comment" && !/\n/.test(next.raws.before ?? "")) next.remove()
    // a last declaration with no semicolon holds the whitespace before the
    // closing brace in its value; the brace keeps it
    if (block.last === decl) {
      const tail = decl.value.match(/\s*$/)?.[0] ?? ""
      if (tail && !block.raws.after) { block.raws.after = tail; block.raws.semicolon = true }
    }
    decl.remove()
    parsed.decls.splice(parsed.decls.indexOf(d), 1)
  }
  for (const { theme, name, value: raw } of edits) {
    const important = /\s*!important\s*$/i.test(raw)
    const value = raw.replace(/\s*!important\s*$/i, "").trim()
    const all = parsed.decls.filter((d) => d.theme === theme && d.decl.prop === name)
    const from = shown(all.at(-1)?.decl)
    const to = value === "" ? null : value + (important ? " !important" : "")
    if (from !== to) changes.push({ name, theme, from, to })
    if (value === "") { for (const d of all) drop(d); continue }
    if (all.length) {
      for (const { decl } of lastPerBlock(theme, name)) {
        // a comment written inside the value stays in it
        const kept = decl.raws.value?.raw.match(/\/\*[\s\S]*?\*\//g)
        // a custom property's value keeps its own trailing whitespace (the
        // newline before a closing brace with no semicolon); keep it too
        const next = value + (decl.value.match(/\s*$/)?.[0] ?? "")
        decl.value = next
        if (kept) decl.raws.value = { value: next, raw: `${value} ${kept.join(" ")}` }
        decl.important = important
      }
      continue
    }
    if (!parsed.blocks[theme].length) {
      // a stylesheet with no block for this theme yet gets one at its end,
      // selected the way the project selects that theme
      const rule = postcss.rule({ selector: theme === "dark" ? (darkAt?.media ? ":root" : darkAt?.selector ?? ".dark") : ":root" })
      if (theme === "dark" && darkAt?.media) parsed.root.append(postcss.atRule({ name: "media", params: darkAt.media, nodes: [rule] }))
      else parsed.root.append(rule)
      parsed.blocks[theme].push(rule)
    }
    // a new token goes into the first block of each way the theme is
    // selected (a class, and the system's preference, where a file has both)
    const firsts = new Map<string, Block>()
    for (const b of parsed.blocks[theme]) { const k = enclosing(b).media ?? ""; if (!firsts.has(k)) firsts.set(k, b) }
    for (const block of firsts.values()) {
      // appended after the block's last declaration, in its indent; that one
      // gets the semicolon it may have gone without, and the whitespace it
      // held before the closing brace moves to the brace
      const prev = [...(block.nodes ?? [])].reverse().find((n): n is Declaration => n.type === "decl")
      const decl = postcss.decl({ prop: name, value, important })
      if (prev) {
        const tail = prev.value.match(/\s*$/)?.[0] ?? ""
        if (tail) { prev.value = prev.value.slice(0, -tail.length); if (!block.raws.after) block.raws.after = tail }
        decl.raws.before = prev.raws.before
        decl.raws.between = prev.raws.between
      }
      block.raws.semicolon = true
      block.append(decl)
      parsed.decls.push({ decl, theme })
    }
  }
  // what is about to be written must read back as a stylesheet, or nothing is written
  const out = parsed.root.toString()
  parse(out, from)
  return { css: out, changes }
}
