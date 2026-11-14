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
// again on Reset) and then deletes. A request it has dealt with is taken
// out of requests.jsonl and noted in `.swatch/done.jsonl` (the last 100).
//
// The MCP server (mcp.ts) is this file's other reader and writer, so an
// agent needs no knowledge of these files: it has tools for them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
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

  private get file() { return join(this.dir, "requests.jsonl") }
  // the parsed queue, kept while the file is unchanged: an agent waiting
  // for a request asks twice a second, and almost always nothing is new
  private seen: { mtime: number; size: number; requests: Queued[] } | null = null

  /** The requests no agent has dealt with yet, oldest first. A request that
   *  has been dealt with is taken out of the file (below), so the file only
   *  ever holds what is pending, and stays small. */
  pending(): Queued[] {
    if (!existsSync(this.file)) return []
    const { mtimeMs, size } = statSync(this.file)
    if (this.seen && this.seen.mtime === mtimeMs && this.seen.size === size) return this.seen.requests
    const requests = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l) as Queued] } catch { return [] } })
      .filter((r) => r && typeof r.id === "string")
    this.seen = { mtime: mtimeMs, size, requests }
    return requests
  }

  /** Takes a request out of the queue, as dealt with, and notes it (with
   *  its note) in done.jsonl, which keeps the last hundred. The panel may
   *  append a request while this rewrites the file: the file is read again
   *  and the rewrite retried if it grew in between, so no request is lost. */
  resolve(id: string, note?: string) {
    if (!this.pending().some((r) => r.id === id)) throw new Error(`no pending request "${id}"`)
    for (let attempt = 0; attempt < 5; attempt++) {
      const text = readFileSync(this.file, "utf8")
      const kept = text.split("\n").filter((l) => {
        if (!l.trim()) return false
        try { return (JSON.parse(l) as Queued).id !== id } catch { return true }
      })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "")
      if (statSync(this.file).size !== Buffer.byteLength(text)) continue // something was added: read again
      renameSync(tmp, this.file)
      this.seen = null
      const done = join(this.dir, "done.jsonl")
      const log = existsSync(done) ? readFileSync(done, "utf8").split("\n").filter(Boolean) : []
      log.push(JSON.stringify({ id, at: new Date().toISOString(), ...(note ? { note: String(note).slice(0, 500) } : {}) }))
      writeFileSync(done, log.slice(-100).join("\n") + "\n")
      return
    }
    throw new Error("the queue kept changing while it was being updated; try again")
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
