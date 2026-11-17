// Swatch with no dev server: the stylesheet is a string on the page, read
// and written by the same code that reads and writes files, and applied
// through a <style> element so a save shows at once. This is how the
// website runs the real panel on itself.
import { createRoot } from "react-dom/client"
import { readText, writeText } from "../server/stylesheet.ts"
import type { Backend, Sheet } from "./backend.ts"
import { Playground } from "./panel.tsx"
import { DOCKED, makeHost } from "./shell.ts"

export type Demo = {
  /** where the panel goes, docked and always open; left out, it floats in
   *  the bottom-left corner behind its launcher, as it does in an app */
  target?: HTMLElement
  /** the stylesheet's name, as the panel shows it */
  file: string
  /** the stylesheet's text */
  css: string
  /** other text where uses of the tokens are counted, by name */
  sources?: Record<string, string>
  /** section titles, each with a pattern its token names match */
  groups?: [string, string][]
  /** called with the stylesheet after every save */
  onSave?: (css: string) => void
}

export function mountDemo({ target, file, css, sources = {}, groups, onSave }: Demo) {
  let text = css
  const style = document.createElement("style")
  style.id = "swatch-demo-tokens"
  style.textContent = text
  document.head.appendChild(style)

  const uses = (name: string) => {
    const re = new RegExp(`var\\(\\s*${name}\\s*[,)]`, "g")
    return Object.entries({ [file]: text, ...sources })
      .map(([f, t]) => ({ file: f, n: (t.match(re) ?? []).length }))
      .filter((u) => u.n > 0)
  }
  const read = (): Sheet => {
    const sheet = readText(text, file)
    return {
      files: [file],
      tokens: [...sheet.tokens].map(([name, v]) => ({ name, ...v, file, uses: uses(name) })),
      dark: sheet.dark,
      groups: groups ?? null,
      agent: false,
    }
  }
  const backend: Backend = {
    read: async () => read(),
    write: async (edits) => {
      const out = writeText(text, edits, file)
      text = out.css
      style.textContent = text
      onSave?.(text)
      return { ...read(), changes: out.changes }
    },
    request: async () => { throw new Error("There is no agent on this page") },
    incoming: async () => null,
    clearIncoming: async () => {},
    subscribe: () => () => {},
  }

  const { host, mountAt } = makeHost()
  if (target) {
    // docked in the page: the host and the mount fill their container
    host.style.cssText = DOCKED
    mountAt.style.height = "100%"
    target.appendChild(host)
  } else document.body.appendChild(host)
  createRoot(mountAt).render(<Playground backend={backend} docked={!!target} />)
}
