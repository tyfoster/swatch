// A project's tokens: which stylesheets hold them, every token with the
// file it lives in and where it is used, and writes sent to the right file.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import postcss, { type AtRule } from "postcss"
import { readSheet, writeAll } from "./files.ts"
import { THEMES, check, type Change, type DarkSelector, type Edit, type Theme } from "./stylesheet.ts"

export type Options = {
  /** The stylesheet(s) the tokens live in, from the project root. Left
   *  out, every stylesheet in the project that declares custom properties
   *  on a theme is used. */
  css?: string | string[]
  /** Where uses are counted, from the project root. Default: the whole
   *  project, without the folders below. */
  src?: string
  /** Section titles for the panel, each with a pattern its token names
   *  match, tried in order. Left out, tokens are grouped by the first
   *  word of their name. */
  groups?: Record<string, RegExp | string>
  /** Show "Save & send to agent" and "Figma sync", which leave requests in
   *  `.swatch/requests.jsonl` for a coding agent to pick up. */
  agent?: boolean
  /** Folders, from the project root, that are neither searched for
   *  stylesheets nor counted for uses (node_modules, hidden folders and the
   *  build output are left out already). */
  ignore?: string[]
  /** Origins besides the dev server's own that may save, e.g. a tunnel's
   *  "https://my-tunnel.example". A proxy that sets X-Forwarded-Host needs
   *  none. */
  allowedOrigins?: string[]
}

export type Token = {
  name: string; light?: string; dark?: string
  /** the stylesheet each value is in, from the project root */
  file: string
  /** how its stylesheet selects the dark theme, where that differs from the project's */
  darkAt?: DarkSelector
  uses: { file: string; n: number }[]
}
export type Sheet = {
  files: string[]; tokens: Token[]; dark: DarkSelector | null
  groups: [string, string][] | null; agent: boolean; changes?: Change[]
}

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|css|scss|vue|svelte|astro|html|mdx?)$/

/** Every file under `dir` whose name passes `test`, leaving out
 *  node_modules, hidden folders, and the folders in `skip` (absolute). */
function walk(dir: string, test: RegExp, skip: Set<string>, acc: string[] = []): string[] {
  let entries: string[]
  // a folder that cannot be read (permissions, or a `src` that does not
  // exist) is passed over with a warning, not the end of every read
  try { entries = readdirSync(dir) } catch (err) {
    console.warn(`[swatch] could not read ${dir}: ${err instanceof Error ? err.message : err}`)
    return acc
  }
  for (const f of entries) {
    if (f === "node_modules" || f.startsWith(".")) continue
    const p = join(dir, f)
    if (skip.has(p)) continue
    let s
    try { s = statSync(p) } catch { continue } // a dangling link
    if (s.isDirectory()) walk(p, test, skip, acc)
    else if (test.test(f)) acc.push(p)
  }
  return acc
}

// ── Uses ─────────────────────────────────────────────────────────────────
// Counted once per file and kept until the file changes: every var(--x),
// and every Tailwind utility on a token (bg-x, hover:text-x/60, bg-(--x)).
// A utility `bg-brand` is a use of `--brand` and of Tailwind's own
// `--color-brand`, whichever the project declares. In a stylesheet,
// Tailwind's @theme mappings (--color-x: var(--x)) are not uses, and its
// comments are never read (a script's text is counted as it stands,
// comments included). A name followed by a colon is a CSS property
// (border-radius: 4px), not a utility. Longer utility names come first in
// the pattern (ring-offset before ring), or "ring-offset-background" would
// be read as ring on a token called --offset-background.
const KINDS = "bg|text|border-[trblxyse]|border|ring-offset|ring|fill|stroke|from|via|to|outline|shadow|divide|placeholder|caret|decoration|accent"
const PREFIX = String.raw`(?<![\w-])(?:[\w-]+(?:\[[^\]\s]*\])?:)*`
const UTIL = new RegExp(`${PREFIX}(?:${KINDS})-([a-z][\\w-]*?)(?:\\/[\\w.[\\]]+)?(?![\\w-])(?!\\s*:)`, "g")
const UTIL_VAR = new RegExp(`${PREFIX}(?:${KINDS})-[([](--[\\w-]+)[)\\]]`, "g")
const VAR = /var\(\s*(--[\w-]+)/g

type Counts = Map<string, number>
const counted = new Map<string, { mtime: number; counts: Counts }>()

/** A file's uses, counted again only when it has changed: `trusted` (under
 *  a dev server, whose watcher says what changed) skips even the stat. */
function countIn(path: string, trusted: boolean): Counts {
  const hit = counted.get(path)
  if (trusted && hit) return hit.counts
  const mtime = statSync(path).mtimeMs
  if (hit && hit.mtime === mtime) return hit.counts
  const text = readFileSync(path, "utf8")
  const counts: Counts = new Map()
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
  const util = (name: string) => { add(`--${name}`); add(`--color-${name}`) }
  if (/\.s?css$/.test(path)) {
    try {
      postcss.parse(text, { from: path }).walk((node) => {
        if (node.type === "decl") {
          let p = node.parent
          while (p && p.type !== "root") { if (p.type === "atrule" && (p as AtRule).name === "theme") return; p = p.parent }
          for (const m of node.value.matchAll(VAR)) add(m[1])
        } else if (node.type === "atrule" && node.name === "apply") {
          for (const m of node.params.matchAll(UTIL)) util(m[1])
        }
      })
    } catch (err) {
      console.warn(`[swatch] could not count uses in ${path}: ${err}`)
    }
  } else {
    for (const m of text.matchAll(VAR)) add(m[1])
    for (const m of text.matchAll(UTIL)) util(m[1])
    for (const m of text.matchAll(UTIL_VAR)) add(m[1])
  }
  counted.set(path, { mtime, counts })
  return counts
}

// ── The project ──────────────────────────────────────────────────────────
export class Project {
  readonly root: string
  readonly options: Options
  /** folders left out of every search, absolute */
  private readonly skip: Set<string>
  // Under a dev server its file watcher says what changed, so a read walks
  // no directories: the lists of stylesheets and sources are kept until a
  // file is added or removed (or a stylesheet changes, which can give it
  // tokens or take them away), and a file's use counts until it changes.
  // Without a watcher (a test, the MCP server) every read looks at the disk.
  private watching = false
  private sheets: string[] | null = null
  private sources: string[] | null = null
  constructor(root: string, options: Options = {}, skip: string[] = []) {
    this.root = resolve(root)
    this.options = options
    this.skip = new Set([...skip, "dist", "coverage", ...(options.ignore ?? [])].map((d) => resolve(this.root, d)))
  }

  private get src() { return join(this.root, this.options.src ?? "") }

  watch() { this.watching = true }
  /** A file changed (or was added or removed: `listChanged`). */
  forget(path: string, listChanged: boolean) {
    counted.delete(path)
    if (listChanged) this.sources = null
    if (listChanged || path.endsWith(".css")) this.sheets = null
  }

  /** The stylesheets that hold tokens: the ones named, or every one in the
   *  project that declares a custom property on a theme. */
  stylesheets(): string[] {
    const named = this.options.css
    if (named) return [named].flat().map((f) => join(this.root, f)).filter((f) => existsSync(f))
    if (this.watching && this.sheets) return this.sheets
    const found = walk(this.root, /\.css$/, this.skip).filter((f) => {
      try { return readSheet(f).tokens.size > 0 } catch { return false }
    })
    if (this.watching) this.sheets = found
    return found
  }

  read(): Sheet {
    const files = this.stylesheets()
    const tokens = new Map<string, Token>()
    // Stylesheets need not agree on how dark is selected (a class in one,
    // the system's preference in another). The project's is the one most
    // dark values sit under; a token under another carries its own.
    const key = (d: DarkSelector | null) => d ? `${d.media ?? ""}|${d.selector}` : ""
    const darkOf = new Map<string, DarkSelector | null>() // token → its stylesheet's
    const votes = new Map<string, { dark: DarkSelector; n: number }>()
    for (const file of files) {
      let sheet
      try { sheet = readSheet(file) } catch (err) { console.warn(`[swatch] could not read ${file}: ${err}`); continue }
      for (const [name, v] of sheet.tokens) {
        // a later file's value is the one the cascade usually ends on
        const t = tokens.get(name) ?? { name, file: relative(this.root, file), uses: [] }
        if (v.light !== undefined) { t.light = v.light; t.file = relative(this.root, file) }
        if (v.dark !== undefined) {
          t.dark = v.dark
          darkOf.set(name, sheet.dark)
          if (sheet.dark) { const k = key(sheet.dark); votes.set(k, { dark: sheet.dark, n: (votes.get(k)?.n ?? 0) + 1 }) }
        } else if (!darkOf.has(name)) darkOf.set(name, sheet.dark)
        tokens.set(name, t)
      }
    }
    const dark = [...votes.values()].sort((a, b) => b.n - a.n)[0]?.dark ?? [...darkOf.values()].find(Boolean) ?? null
    for (const t of tokens.values()) {
      const own = darkOf.get(t.name)
      if (own && key(own) !== key(dark)) t.darkAt = own
    }
    const sources = (this.watching && this.sources) || walk(this.src, SOURCE, this.skip)
    if (this.watching) this.sources = sources
    for (const path of sources) {
      for (const [name, n] of countIn(path, this.watching)) tokens.get(name)?.uses.push({ file: relative(this.root, path), n })
    }
    const groups = this.options.groups
      ? Object.entries(this.options.groups).map(([title, re]): [string, string] => [title, typeof re === "string" ? re : re.source])
      : null
    return { files: files.map((f) => relative(this.root, f)), tokens: [...tokens.values()], dark, groups, agent: !!this.options.agent }
  }

  /** Sends each edit to the stylesheet that holds the token in that theme;
   *  failing that, the one that holds it in the other theme; failing that
   *  (a new token), the one with the most tokens. Every edit is checked,
   *  and every file's new text worked out, before any file is touched. An
   *  edit that says what it expects to replace (`was`) is refused, with
   *  the whole batch, when the stylesheets hold something else. */
  write(edits: Edit[]): Change[] {
    if (!Array.isArray(edits)) throw new Error("expected a list of edits")
    edits.forEach(check)
    const files = this.stylesheets()
    if (!files.length) throw new Error("no stylesheet with tokens was found: name one with the `css` option")
    const sheets = files.map((file) => { const s = readSheet(file); return { file, tokens: s.tokens, dark: s.dark } })
    const biggest = [...sheets].sort((a, b) => b.tokens.size - a.tokens.size)[0].file
    // how the project selects dark (the selector most dark values sit
    // under), for a stylesheet that needs a dark block it has not got
    const votes = new Map<string, { at: DarkSelector; n: number }>()
    for (const s of sheets) if (s.dark) {
      const n = [...s.tokens.values()].filter((t) => t.dark !== undefined).length
      const k = `${s.dark.media ?? ""}|${s.dark.selector}`
      votes.set(k, { at: s.dark, n: (votes.get(k)?.n ?? 0) + n })
    }
    const darkAt = [...votes.values()].sort((a, b) => b.n - a.n)[0]?.at ?? null
    // what the project holds for a token now, as read() gives it
    const held = (name: string, theme: Theme) => {
      let v: string | null = null
      for (const s of sheets) { const here = s.tokens.get(name)?.[theme]; if (here !== undefined) v = here }
      return v
    }
    for (const e of edits) {
      if (e.was === undefined) continue
      const now = held(e.name, e.theme)
      if (now !== e.was) throw new Error(`${e.name} changed in the stylesheet since it was read (${e.was ?? "not set"} then, ${now ?? "not set"} now), so nothing was saved; save again to write over it`)
    }
    const holds = (name: string, theme?: Theme) => sheets.filter((s) => {
      const t = s.tokens.get(name)
      return t && (theme ? t[theme] !== undefined : true)
    }).map((s) => s.file)
    const batches = new Map<string, Edit[]>()
    for (const e of edits) {
      const here = holds(e.name, e.theme)
      // A value in a theme the token's stylesheet has no block for stays in
      // that stylesheet, in a new block after the one that declares it (so
      // it is the later of the two wherever the file is loaded), selected
      // the way the project selects dark.
      const targets = here.length ? here : e.value.trim() === "" ? [] : [holds(e.name).at(-1) ?? biggest]
      for (const f of targets) batches.set(f, [...(batches.get(f) ?? []), e])
    }
    // every file changes, or none does
    const changes = writeAll(batches, darkAt)
    // one change per token and theme, however many files held it
    const seen = new Set<string>()
    return changes.filter((c) => { const k = `${c.name}|${c.theme}`; if (seen.has(k)) return false; seen.add(k); return true })
  }
}

export { THEMES }
export type { Change, Edit, Theme }
