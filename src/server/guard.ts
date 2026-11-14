// Who may change the project's files through the dev server.
//
// Reading the tokens is open to the page; writing (a save, an agent
// request, clearing an agent's answer) is not open to everyone who can
// reach the port. A browser always says where a write comes from (the
// Origin header), and that origin must be this dev server: the address in
// the request's Host header, or one the project lets Vite answer to
// (`server.allowedHosts`), which is how a tunnel or a forwarded port
// reaches it, or one named in Swatch's own `allowedOrigins`. A page on
// another origin, another localhost port included, is refused. A write
// with no Origin header comes from a program, not a browser, and is
// accepted only from this machine: a dev server opened to the network
// (`vite --host`) takes no writes from scripts on other machines.
import type { IncomingMessage } from "node:http"

export type Trust = {
  /** Vite's `server.allowedHosts`: true for any host, or a list (a leading "." allows subdomains) */
  allowedHosts?: true | string[]
  /** origins named in Swatch's options, e.g. "https://my-tunnel.example" */
  allowedOrigins?: string[]
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/

const LOCAL = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/
const hostname = (host: string) => host.replace(/^\[([^\]]+)\](:\d+)?$/, "$1").replace(/:\d+$/, "").toLowerCase()

/** Why a write is refused, or null when it may go ahead. */
export function refuseWrite(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } }, trust: Trust = {}): string | null {
  const origin = req.headers.origin
  if (origin === undefined) {
    return LOOPBACK.test(req.socket.remoteAddress ?? "") ? null : "a write with no Origin is only accepted from this machine"
  }
  let url: URL
  try { url = new URL(origin) } catch { return "cross-origin request refused" }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "cross-origin request refused"
  // this dev server, as the browser addressed it
  if (req.headers.host && url.host.toLowerCase() === req.headers.host.toLowerCase()) return null
  if (trust.allowedOrigins?.some((o) => o.replace(/\/$/, "").toLowerCase() === url.origin.toLowerCase())) return null
  const name = hostname(url.host)
  // A page on this machine must be this very server, port and all: another
  // local port is another program. And an origin on the server's own host
  // name but another port is another program too. Vite lists the server's
  // own address among its allowed hosts, so those are ruled out before
  // the list is consulted.
  if (LOCAL.test(name)) return "cross-origin request refused"
  if (req.headers.host && name === hostname(req.headers.host)) return "cross-origin request refused"
  if (trust.allowedHosts === true) return null
  if (trust.allowedHosts?.some((h) => h.startsWith(".") ? name === h.slice(1) || name.endsWith(h) : name === h.toLowerCase())) return null
  return "cross-origin request refused"
}
