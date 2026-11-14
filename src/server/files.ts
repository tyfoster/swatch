// The stylesheet reader and writer, on files.
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { readText, writeText, type Change, type Edit } from "./stylesheet.ts"

// A file is parsed again only when it has changed since it was last read.
const parsed = new Map<string, { mtime: number; size: number; sheet: ReturnType<typeof readText> }>()
export function readSheet(file: string) {
  const { mtimeMs, size } = statSync(file)
  const hit = parsed.get(file)
  if (hit && hit.mtime === mtimeMs && hit.size === size) return hit.sheet
  const sheet = readText(readFileSync(file, "utf8"), file)
  parsed.set(file, { mtime: mtimeMs, size, sheet })
  return sheet
}

/** The whole batch on one read and one write, so a save of forty values is
 *  one change to the file and one hot reload. A failed check writes
 *  nothing. */
export function write(file: string, edits: Edit[]): Change[] {
  return writeAll(new Map([[file, edits]]))
}

/** Several files' batches as one save: every file's new text is worked out
 *  before any is written, and if a write fails part-way the files already
 *  written are put back as they were. Either all of them change or none. */
export function writeAll(batches: Map<string, Edit[]>): Change[] {
  const planned = [...batches].map(([file, edits]) => {
    const before = readFileSync(file, "utf8")
    return { file, before, ...writeText(before, edits, file) }
  })
  const done: typeof planned = []
  try {
    for (const p of planned) {
      // written in place (a rename would reach a dev server's watcher as a
      // delete and an add, not as the change its CSS hot reload listens for)
      writeFileSync(p.file, p.css)
      done.push(p)
    }
  } catch (err) {
    for (const p of done) { try { writeFileSync(p.file, p.before) } catch { /* reported below */ } }
    throw new Error(`could not write ${planned[done.length]?.file ?? "a stylesheet"}, so nothing was saved: ${err instanceof Error ? err.message : err}`)
  }
  return planned.flatMap((p) => p.changes)
}
