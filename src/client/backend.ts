// What the panel needs from wherever the stylesheets live. Under a dev
// server that is the Vite plugin, over HTTP; on the website it is the page
// itself (demo.ts), with the same reader and writer running in the browser.
export type Theme = "light" | "dark"
export type Dark = { selector: string; media: string | null }
export type Token = {
  name: string; light?: string; dark?: string; file?: string
  /** how its stylesheet selects the dark theme, where that differs from the project's */
  darkAt?: Dark
  uses: { file: string; n: number }[]; isNew?: boolean
}
export type Edit = { name: string; theme: Theme; value: string }
export type Change = { name: string; theme: Theme; from: string | null; to: string | null }
/** The stylesheets, their tokens, how the dark theme is selected, the
 *  project's own section titles (if it set any), and whether a coding
 *  agent is listening for requests. */
export type Sheet = {
  files: string[]; tokens: Token[]; dark: Dark | null
  groups: [string, string][] | null; agent: boolean; changes?: Change[]
}

export type Backend = {
  read(): Promise<Sheet>
  /** Writes a batch; rejects with the reason when it is refused. */
  write(edits: Edit[]): Promise<Sheet>
  /** Leaves a request for a coding agent. */
  request(body: unknown): Promise<void>
  /** What an agent left for the panel, or null; and taking it. */
  incoming(): Promise<unknown>
  clearIncoming(): Promise<void>
  /** Told when a stylesheet changes, or an agent leaves something. Returns how to stop. */
  subscribe(on: (what: "css" | "incoming") => void): () => void
}

const json = async (r: Response) => {
  const body = await r.json()
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
  return body
}
export const http: Backend = {
  read: () => fetch("/__swatch").then(json),
  write: (edits) => fetch("/__swatch", { method: "POST", body: JSON.stringify(edits) }).then(json),
  request: (body) => fetch("/__swatch/request", { method: "POST", body: JSON.stringify(body) }).then(json),
  incoming: () => fetch("/__swatch/incoming").then(json),
  clearIncoming: () => fetch("/__swatch/incoming", { method: "DELETE" }).then(json),
  // Asks every two seconds whether anything moved, while the tab is in
  // view. Asking, rather than holding a connection open, keeps every tab
  // from taking one of the few connections a browser allows each site.
  subscribe: (on) => {
    let last: { css: number; incoming: number } | null = null
    let busy = false
    const check = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const now = await fetch("/__swatch/version").then(json) as { css: number; incoming: number }
        if (last && now.css !== last.css) on("css")
        if (last && now.incoming !== last.incoming) on("incoming")
        last = now
      } catch { /* the dev server is restarting: ask again next time */ } finally { busy = false }
    }
    check()
    const timer = setInterval(check, 2000)
    // back in view: catch up at once rather than on the next tick
    const shown = () => { if (!document.hidden) check() }
    document.addEventListener("visibilitychange", shown)
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", shown) }
  },
}
