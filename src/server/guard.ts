// Who may change the project's files through the dev server.
//
// Reading the tokens is open to the page; writing (a save, an agent
// request, clearing an agent's answer) needs all of these:
//
// 1. The session key. The plugin makes a random key each time the dev
//    server starts; the panel finds it on its script tag, or asks for it
//    (GET /__swatch/key, answered only to the dev server's own page), and
//    sends it back in a header with every write. A custom header makes a
//    browser ask the server first (a CORS preflight) before a page on
//    another site may send it.
// 2. JSON. A write must say `Content-Type: application/json`, which a
//    page on another site cannot send without that same preflight.
// 3. The right origin. A browser always says where a write comes from;
//    that must be this dev server, as the browser addressed it (the Host
//    header, or the X-Forwarded-Host a proxy in front of it sets), or an
//    origin named in Swatch's `allowedOrigins`.
// 4. A host name the dev server is known by. A page on any domain can
//    point that domain at 127.0.0.1 (DNS rebinding) and so become "the
//    dev server's own page" by rule 3. So where Origin and Host agree, the
//    name must be localhost, an IP address, a name in Vite's
//    `server.allowedHosts` list, or one in `allowedOrigins`.
// 5. A write with no Origin header comes from a program, not a browser.
//    It is accepted only from this machine, and only when nothing has
//    forwarded it: behind a proxy or tunnel on the same machine every
//    client looks local, so a request that carries a proxy's
//    forwarding headers is not treated as local.
//
// How much the key adds depends on Vite: versions before 5.4.12 and 6.0.9
// (and `server.cors: true` on any) let every site read the dev server's
// pages, the key with them. Rules 3 and 4 do not depend on it.
//
// None of this hides the dev server from someone who can load its pages:
// a dev server opened to a network, or put behind a tunnel, is open to
// whoever can reach it, as it is without Swatch.
import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export type Trust = {
  /** origins named in Swatch's options, e.g. "https://my-tunnel.example" */
  allowedOrigins?: string[]
  /** Vite's `server.allowedHosts`, when it is a list (a leading "." allows subdomains) */
  allowedHosts?: string[]
}
export const KEY_HEADER = "x-swatch-key"
/** The refusal a panel answers by asking for the key again. */
export const STALE_KEY = "this page's Swatch session is out of date: reload the page"

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"]
// localhost, or an address: names nobody else's DNS can point here
const LOCAL_NAME = /^(localhost|.+\.localhost|\d+\.\d+\.\d+\.\d+|[0-9a-f:.]*:[0-9a-f:.]*)$/

type Req = Pick<IncomingMessage, "headers" | "method"> & { socket: { remoteAddress?: string } }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""
const hostname = (host: string) => host.replace(/^\[([^\]]+)\](:\d+)?$/, "$1").replace(/:\d+$/, "").toLowerCase()

function sameKey(sent: string, key: string) {
  const a = Buffer.from(sent), b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

const named = (url: URL, trust: Trust) => !!trust.allowedOrigins?.some((o) => o.replace(/\/$/, "").toLowerCase() === url.origin.toLowerCase())
const forwardedHosts = (req: Req) => one(req.headers["x-forwarded-host"]).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
/** Is `host` (a Host header) a name this dev server is known by? (rule 4) */
function known(host: string, trust: Trust) {
  const name = hostname(host)
  if (LOCAL_NAME.test(name)) return true
  if (trust.allowedHosts?.some((h) => h.startsWith(".") ? name === h.slice(1).toLowerCase() || name.endsWith(h.toLowerCase()) : name === h.toLowerCase())) return true
  return !!trust.allowedOrigins?.some((o) => { try { return new URL(o).host.toLowerCase() === host.toLowerCase() } catch { return false } })
}

/** Why a page at `from` is not this dev server's own page, or null when it is. */
function notOurs(from: string, req: Req, trust: Trust): string | null {
  let url: URL
  try { url = new URL(from) } catch { return "cross-origin request refused" }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "cross-origin request refused"
  if (named(url, trust)) return null
  const host = url.host.toLowerCase()
  // through a proxy that says where the browser went
  if (forwardedHosts(req).includes(host)) return null
  const add = `add "${url.origin}" to swatch({ allowedOrigins: [...] }) in your Vite config`
  if (host !== one(req.headers.host).toLowerCase()) return `saves from ${url.origin} are not accepted. If that is your dev server behind a proxy or tunnel, ${add}`
  if (!known(host, trust)) return `saves from ${url.origin} are not accepted: it is not a name the dev server is known by. If it is yours, ${add}`
  return null
}

/** Why a write is refused, or null when it may go ahead. */
export function refuseWrite(req: Req, key: string, trust: Trust = {}): string | null {
  if (!key || !sameKey(one(req.headers[KEY_HEADER]), key)) return STALE_KEY
  if (req.method === "POST" && !/^application\/json\b/i.test(one(req.headers["content-type"]))) return "a write must be sent as application/json"
  const origin = req.headers.origin
  if (origin === undefined) {
    const local = LOOPBACK.test(req.socket.remoteAddress ?? "")
    const forwarded = FORWARDED.some((h) => req.headers[h] !== undefined)
    return local && !forwarded ? null : "a write with no Origin is only accepted from this machine, directly"
  }
  return notOurs(origin, req, trust)
}

/** Why the key is not handed out, or null when it may be: only to a page
 *  of this dev server. A browser says so itself (Sec-Fetch-Site) where the
 *  page is one it trusts with that header; elsewhere (plain http on a
 *  network address) the Referer must be this server. */
export function refuseKey(req: Req, trust: Trust = {}): string | null {
  const site = one(req.headers["sec-fetch-site"])
  const referer = one(req.headers.referer)
  if (site ? site !== "same-origin" : !referer) return "the key is only given to the dev server's own page"
  if (referer) return notOurs(referer, req, trust)
  const host = one(req.headers.host)
  return forwardedHosts(req).length || known(host, trust) ? null : "the key is only given to the dev server's own page"
}
