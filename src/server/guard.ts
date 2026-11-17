// Who may change the project's files through the dev server.
//
// Reading the tokens is open to the page; writing (a save, an agent
// request, clearing an agent's answer) needs all of these:
//
// 1. The session key. The plugin makes a random key each time the dev
//    server starts and puts it on the panel's script tag; the panel sends
//    it back in a header with every write. A page on another site cannot
//    read the dev server's HTML, so it cannot know the key, and a custom
//    header makes the browser ask the server first (a CORS preflight),
//    which Vite refuses for other sites.
// 2. JSON. A write must say `Content-Type: application/json`, which a
//    page on another site cannot send without that same preflight.
// 3. The right origin. A browser always says where a write comes from;
//    that must be this dev server, as the browser addressed it (the Host
//    header, or the X-Forwarded-Host a proxy in front of it sets), or an
//    origin named in Swatch's `allowedOrigins`. Vite's `allowedHosts` is
//    not trusted for this: it can name whole domains.
// 4. A write with no Origin header comes from a program, not a browser.
//    It is accepted only from this machine, and only when nothing has
//    forwarded it: behind a proxy or tunnel on the same machine every
//    client looks local, so a request that carries a proxy's
//    forwarding headers is not treated as local.
//
// The key does not hide the dev server from someone who can load its
// pages: a dev server opened to a network, or put behind a tunnel, is
// open to whoever can reach it, as it is without Swatch.
import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export type Trust = {
  /** origins named in Swatch's options, e.g. "https://my-tunnel.example" */
  allowedOrigins?: string[]
}
export const KEY_HEADER = "x-swatch-key"

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"]

type Req = Pick<IncomingMessage, "headers" | "method"> & { socket: { remoteAddress?: string } }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""

function sameKey(sent: string, key: string) {
  const a = Buffer.from(sent), b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Why a write is refused, or null when it may go ahead. */
export function refuseWrite(req: Req, key: string, trust: Trust = {}): string | null {
  if (!key || !sameKey(one(req.headers[KEY_HEADER]), key)) return "this request did not come from Swatch's panel"
  if (req.method === "POST" && !/^application\/json\b/i.test(one(req.headers["content-type"]))) return "a write must be sent as application/json"
  const origin = req.headers.origin
  if (origin === undefined) {
    const local = LOOPBACK.test(req.socket.remoteAddress ?? "")
    const forwarded = FORWARDED.some((h) => req.headers[h] !== undefined)
    return local && !forwarded ? null : "a write with no Origin is only accepted from this machine, directly"
  }
  let url: URL
  try { url = new URL(origin) } catch { return "cross-origin request refused" }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "cross-origin request refused"
  // this dev server, as the browser addressed it: directly, or through a proxy that says so
  const hosts = [one(req.headers.host), ...one(req.headers["x-forwarded-host"]).split(",")].map((h) => h.trim().toLowerCase()).filter(Boolean)
  if (hosts.includes(url.host.toLowerCase())) return null
  if (trust.allowedOrigins?.some((o) => o.replace(/\/$/, "").toLowerCase() === url.origin.toLowerCase())) return null
  return "cross-origin request refused"
}
