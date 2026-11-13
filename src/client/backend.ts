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
  subscribe: (on) => {
    const events = new EventSource("/__swatch/events")
    events.onmessage = (e) => { if (e.data === "css" || e.data === "incoming") on(e.data) }
    return () => events.close()
  },
}
