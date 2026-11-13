// Asking a coding agent.
//
// The panel cannot reach an agent itself, so it leaves requests in a queue
// the agent reads: one JSON line each in `.swatch/requests.jsonl` at the
// project root (add `.swatch` to .gitignore).
//   { kind: "commit", changes }   commit these stylesheet changes
//   { kind: "figma-sync", figma } pull the colour variables from that file
// The agent answers a Figma sync (or proposes colours of its own) by
// writing `.swatch/incoming.json`, { edits: { "--name": { light?, dark? } },
// note? }, which the panel loads as unsaved edits (previewed, and gone
// again on Reset) and then deletes. A request it has dealt with is noted
// in `.swatch/done.jsonl`, and is no longer pending.
//
// The MCP server (mcp.ts) is this file's other reader and writer, so an
// agent needs no knowledge of these files: it has tools for them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { THEMES, check, type Change, type Theme } from "./stylesheet.ts"

export type Request = { kind: "commit"; changes: Change[] } | { kind: "figma-sync"; figma: string }
export type Queued = Request & { id: string; at: string; files: string[] }
export type Proposal = Record<string, Partial<Record<Theme, string>>>

export class Queue {
  readonly dir: string
  readonly incoming: string
  constructor(root: string) {
    this.dir = join(root, ".swatch")
    this.incoming = join(this.dir, "incoming.json")
  }

  /** The queue holds only what was checked field by field: nothing a
   *  caller adds to the body, and no field of ours a caller can replace. */
  add(r: Request, files: string[]) {
    let body: Request
    if (r?.kind === "commit") {
      if (!Array.isArray(r.changes) || !r.changes.length || r.changes.length > 2000) throw new Error("nothing to commit")
      const text = (v: unknown) => v === null || (typeof v === "string" && v.length <= 2000 && !/[\n\r]/.test(v))
      body = { kind: "commit", changes: r.changes.map((c) => {
        if (typeof c?.name !== "string" || !/^--[a-zA-Z0-9_-]+$/.test(c.name) || !THEMES.includes(c.theme) || !text(c.from) || !text(c.to)) throw new Error("bad change")
        return { name: c.name, theme: c.theme, from: c.from, to: c.to }
      }) }
    } else if (r?.kind === "figma-sync") {
      let host = ""
      try { if (typeof r.figma === "string" && r.figma.length <= 500 && !/\s/.test(r.figma)) { const u = new URL(r.figma); if (u.protocol === "https:") host = u.hostname } } catch { /* not a URL */ }
      if (host !== "figma.com" && host !== "www.figma.com") throw new Error("not a figma.com link")
      body = { kind: "figma-sync", figma: r.figma }
    } else throw new Error("unknown request")
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const line: Queued = { ...body, id, at: new Date().toISOString(), files }
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, "requests.jsonl"), JSON.stringify(line) + "\n")
    return { id: line.id }
  }

  /** What the agent left, or null (also while it is half written). */
  take(): unknown {
    if (!existsSync(this.incoming)) return null
    try { return JSON.parse(readFileSync(this.incoming, "utf8")) } catch { return null }
  }
  clear() { rmSync(this.incoming, { force: true }) }

  private lines(file: string): unknown[] {
    const path = join(this.dir, file)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  }

  /** The requests no agent has dealt with yet, oldest first. */
  pending(): Queued[] {
    const done = new Set((this.lines("done.jsonl") as { id: string }[]).map((d) => d.id))
    return (this.lines("requests.jsonl") as Queued[]).filter((r) => r && typeof r.id === "string" && !done.has(r.id))
  }

  /** Notes a request as dealt with. */
  resolve(id: string, note?: string) {
    if (!this.pending().some((r) => r.id === id)) throw new Error(`no pending request "${id}"`)
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, "done.jsonl"), JSON.stringify({ id, at: new Date().toISOString(), ...(note ? { note: String(note).slice(0, 500) } : {}) }) + "\n")
  }

  /** Leaves values for the panel to load as unsaved edits: every one
   *  checked as a write would be, and the file put in place whole, so the
   *  panel never reads half of it. Returns how many values. */
  propose(edits: Proposal, note?: string): number {
    if (!edits || typeof edits !== "object" || Array.isArray(edits)) throw new Error("edits must be an object of token name to { light?, dark? }")
    const clean: Proposal = {}
    let n = 0
    for (const [name, values] of Object.entries(edits)) {
      if (!values || typeof values !== "object") throw new Error(`bad values for ${name}`)
      for (const theme of THEMES) {
        const value = values[theme]
        if (value === undefined) continue
        check({ name, theme, value })
        clean[name] = { ...clean[name], [theme]: value.trim() }
        n++
      }
    }
    if (!n) throw new Error("no values to propose")
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.incoming}.tmp`
    writeFileSync(tmp, JSON.stringify({ edits: clean, ...(note ? { note: String(note).slice(0, 300) } : {}) }))
    renameSync(tmp, this.incoming)
    return n
  }
}
