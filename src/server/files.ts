// The stylesheet reader and writer, on files.
import { accessSync, chmodSync, constants, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { readText, writeText, type Change, type DarkSelector, type Edit } from "./stylesheet.ts"

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

/** Replaces a file's contents in one step: written whole to a file of its
 *  own beside it, then renamed over it, so a crash never leaves half a
 *  stylesheet. (A dev server's watcher sees the rename as the file
 *  changing.) The temporary name is unique, so two writers never share it.
 *
 *  The file stays the file it was: a link is followed and what it points
 *  to replaced, the permissions are kept, and a file the user cannot write
 *  to is refused, as writing in place would. Where a rename cannot be
 *  used (a file with other names, a folder that takes no new files, a
 *  file another program holds open on Windows) it is written in place. */
export function replace(file: string, text: string) {
  const real = realpathSync(file)
  const { mode, nlink } = statSync(real)
  accessSync(real, constants.W_OK)
  if (nlink > 1) return writeFileSync(real, text)
  const tmp = join(dirname(real), `.${basename(real)}.swatch-${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
  try {
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode & 0o7777) // the mode asked for above is cut by the umask
    renameSync(tmp, real)
  } catch (err) {
    rmSync(tmp, { force: true })
    if (!["EPERM", "EBUSY", "EACCES", "EXDEV"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err
    writeFileSync(real, text)
  }
}

/** The whole batch on one read and one write, so a save of forty values is
 *  one change to the file and one hot reload. A failed check writes
 *  nothing. */
export function write(file: string, edits: Edit[], darkAt?: DarkSelector | null): Change[] {
  return writeAll(new Map([[file, edits]]), darkAt)
}

/** What a save will write: each file's new text, worked out from the file
 *  as it is now, and the time and size it had when read. */
export type Plan = { file: string; before: string; css: string; changes: Change[]; mtimeMs: number; size: number }[]
export function plan(batches: Map<string, Edit[]>, darkAt?: DarkSelector | null): Plan {
  return [...batches].map(([file, edits]) => {
    const { mtimeMs, size } = statSync(file)
    const before = readFileSync(file, "utf8")
    return { file, before, mtimeMs, size, ...writeText(before, edits, file, darkAt) }
  })
}

/** Writes a plan. A file that changed on disk after it was read (an
 *  editor's save, say) is never written over: the save stops, and nothing
 *  is written. If a write fails part-way, the files already written are
 *  put back as they were. Either all of them change or none. */
export function commit(planned: Plan): Change[] {
  // (the wider gap, between the panel reading a value and saving over it,
  // is closed by an edit's `was`, in Project.write)
  const moved = planned.find((p) => {
    try { const s = statSync(p.file); return s.mtimeMs !== p.mtimeMs || s.size !== p.size } catch { return true } // gone
  })
  if (moved) throw new Error(`${basename(moved.file)} changed on disk while saving, so nothing was saved; try again`)
  const done: Plan = []
  try {
    for (const p of planned) {
      replace(p.file, p.css)
      done.push(p)
    }
  } catch (err) {
    for (const p of done) { try { replace(p.file, p.before) } catch { /* reported below */ } }
    throw new Error(`could not write ${planned[done.length]?.file ?? "a stylesheet"}, so nothing was saved: ${err instanceof Error ? err.message : err}`)
  }
  return planned.flatMap((p) => p.changes)
}

/** Several files' batches as one save: every file's new text is worked out
 *  before any is written (plan), then written (commit). */
export const writeAll = (batches: Map<string, Edit[]>, darkAt?: DarkSelector | null): Change[] => commit(plan(batches, darkAt))
