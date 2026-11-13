// The stylesheet reader and writer, on files.
import { readFileSync, writeFileSync } from "node:fs"
import { readText, writeText, type Change, type Edit } from "./stylesheet.ts"

export const readSheet = (file: string) => readText(readFileSync(file, "utf8"), file)

/** The whole batch on one read and one write, so a save of forty values is
 *  one change to the file and one hot reload. A failed check writes
 *  nothing. */
export function write(file: string, edits: Edit[]): Change[] {
  const { css, changes } = writeText(readFileSync(file, "utf8"), edits, file)
  // written in place (a rename would reach a dev server's watcher as a
  // delete and an add, not as the change its CSS hot reload listens for)
  writeFileSync(file, css)
  return changes
}
