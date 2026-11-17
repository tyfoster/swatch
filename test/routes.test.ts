/**
 * The dev server's half: its routes, run through a real Vite dev server
 * with the plugin, and the rules behind them (who may write, saves across
 * several stylesheets, the agent's queue, which folders are searched).
 *
 * Node runs this file directly: `node --test test/`.
 */
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, lstatSync, statSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type ViteDevServer } from "vite"

import swatch from "../src/vite.ts"
import { STALE_KEY, refuseKey, refuseWrite } from "../src/server/guard.ts"
import { Project } from "../src/server/project.ts"
import { commit, plan, writeAll } from "../src/server/files.ts"
import { Queue } from "../src/server/requests.ts"

const STYLE = ":root {\n  --card: #f4f4f6;\n}\n.dark {\n  --card: #1d1d22;\n}\n"
let root = "", server: ViteDevServer, base = "", key = ""

before(async () => {
  root = mkdtempSync(join(tmpdir(), "swatch-routes-"))
  writeFileSync(join(root, "index.html"), "<!doctype html><html><body></body></html>")
  writeFileSync(join(root, "style.css"), STYLE)
  server = await createServer({ root, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, plugins: [swatch()] })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
  // the session key, as the panel finds it on its script tag
  const html = await server.transformIndexHtml("/index.html", readFileSync(join(root, "index.html"), "utf8"))
  key = /data-swatch-key="([0-9a-f]+)"/.exec(html)?.[1] ?? ""
})
after(async () => { await server?.close() })

/** A write as the panel sends it (its key, JSON, its origin), with `headers` laid over that. */
const post = (path: string, body: unknown, headers: Record<string, string | undefined> = {}) => {
  const all: Record<string, string> = {}
  for (const [k, v] of Object.entries({ "x-swatch-key": key, "content-type": "application/json", origin: base, ...headers })) if (v !== undefined) all[k] = v
  return fetch(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: all })
}

test("GET /__swatch lists the tokens", async () => {
  const r = await fetch(base + "/__swatch")
  assert.equal(r.status, 200)
  const sheet = await r.json()
  assert.deepEqual(sheet.files, ["style.css"])
  assert.equal(sheet.tokens.find((t: { name: string }) => t.name === "--card").dark, "#1d1d22")
})

test("the page's script names the project, by a hash and not its path, and carries the session key", async () => {
  const html = await server.transformIndexHtml("/index.html", readFileSync(join(root, "index.html"), "utf8"))
  const id = /data-swatch-project="([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(id && id.length === 12)
  assert.ok(!html.includes(root))
  assert.equal(key.length, 48)
})

test("a save from the page writes the stylesheet, and the version moves", async () => {
  const v0 = await (await fetch(base + "/__swatch/version")).json()
  const r = await post("/__swatch", [{ theme: "light", name: "--card", value: "#eeeeee" }])
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).changes, [{ name: "--card", theme: "light", from: "#f4f4f6", to: "#eeeeee" }])
  assert.match(readFileSync(join(root, "style.css"), "utf8"), /--card: #eeeeee;/)
  // the watcher reports the change a moment later
  for (let i = 0; i < 40; i++) {
    const v = await (await fetch(base + "/__swatch/version")).json()
    if (v.css > v0.css) break
    assert.ok(i < 39, "the css version never moved")
    await new Promise((r) => setTimeout(r, 50))
  }
  writeFileSync(join(root, "style.css"), STYLE)
})

test("a save from another origin, another localhost port included, is refused", async () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:1", "https://evil.example", "null"]) {
    const r = await post("/__swatch", [{ theme: "light", name: "--card", value: "red" }], { origin })
    assert.equal(r.status, 403, origin)
  }
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), STYLE)
})

test("unknown routes are 404, wrong methods 405, and too large a body 413", async () => {
  assert.equal((await fetch(base + "/__swatch/nope")).status, 404)
  assert.equal((await fetch(base + "/__swatch/version", { method: "POST", headers: { origin: base } })).status, 405)
  assert.equal((await fetch(base + "/__swatch", { method: "DELETE", headers: { origin: base } })).status, 405)
  const big = await post("/__swatch", "x".repeat(1_100_000))
  assert.equal(big.status, 413)
})

test("a value that would break the stylesheet is a 400, and nothing is written", async () => {
  const r = await post("/__swatch", [{ theme: "light", name: "--card", value: "rgb(0 0 0" }])
  assert.equal(r.status, 400)
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), STYLE)
})

test("a write without the session key, or not sent as JSON, is refused, and nothing is written", async () => {
  const edit = [{ theme: "light", name: "--card", value: "red" }]
  assert.equal((await post("/__swatch", edit, { "x-swatch-key": undefined })).status, 403)
  assert.equal((await post("/__swatch", edit, { "x-swatch-key": "0".repeat(48) })).status, 403)
  // a page on another site can send text/plain without asking first; that is refused
  assert.equal((await post("/__swatch", edit, { "content-type": "text/plain" })).status, 403)
  assert.equal((await post("/__swatch/request", { kind: "figma-sync", figma: "https://www.figma.com/design/x/y" }, { "content-type": "text/plain" })).status, 403)
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), STYLE)
})

test("a panel whose script tag was written by hand, or outlived a restart, is given the key; no other page is", async () => {
  const own = { "sec-fetch-site": "same-origin", referer: base + "/" }
  const got = await fetch(base + "/__swatch/key", { headers: own })
  assert.deepEqual(await got.json(), { key })
  assert.equal((await fetch(base + "/__swatch/key", { headers: { "sec-fetch-site": "cross-site", referer: "https://evil.example/" } })).status, 403)
  assert.equal((await fetch(base + "/__swatch/key", { headers: { "sec-fetch-site": "same-site" } })).status, 403)
  assert.equal((await fetch(base + "/__swatch/key")).status, 403, "a program with neither header")
  // an old key is refused in a way the panel can tell apart, so it asks again
  const stale = await post("/__swatch", [], { "x-swatch-key": "0".repeat(48) })
  assert.equal(stale.headers.get("x-swatch-refused"), "key")
  assert.equal((await stale.json()).error, STALE_KEY)
  const g = (headers: Record<string, string>, host = "localhost:5173") => ({ method: "GET", headers: { host, ...headers }, socket: { remoteAddress: "127.0.0.1" } })
  // plain http on a network address: browsers send no Sec-Fetch-Site there, so the Referer decides
  assert.equal(refuseKey(g({ referer: "http://192.168.1.5:5173/app" }, "192.168.1.5:5173")), null)
  assert.ok(refuseKey(g({ referer: "http://192.168.1.7:3000/" }, "192.168.1.5:5173")))
  // a rebound domain is same-origin to the browser, and still not given the key
  assert.ok(refuseKey(g({ "sec-fetch-site": "same-origin", referer: "http://evil.example:5173/" }, "evil.example:5173")))
  assert.ok(refuseKey(g({ "sec-fetch-site": "same-origin" }, "evil.example:5173")))
})

test("who may write", () => {
  const K = "k".repeat(48)
  const req = (origin: string | undefined, host: string, remote: string, more: Record<string, string> = {}) =>
    ({ method: "POST", headers: { "x-swatch-key": K, "content-type": "application/json", origin, host, ...more }, socket: { remoteAddress: remote } })
  // the page itself
  assert.equal(refuseWrite(req("http://localhost:5173", "localhost:5173", "127.0.0.1"), K), null)
  // without the key, or with JSON not declared
  assert.ok(refuseWrite(req("http://localhost:5173", "localhost:5173", "127.0.0.1"), "other".repeat(10)))
  assert.ok(refuseWrite(req("http://localhost:5173", "localhost:5173", "127.0.0.1", { "content-type": "text/plain" }), K))
  // behind a proxy that rewrites Host but says where the browser went
  assert.equal(refuseWrite(req("https://app.local.dev", "localhost:5173", "127.0.0.1", { "x-forwarded-host": "app.local.dev" }), K), null)
  // or named in allowedOrigins
  assert.equal(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1"), K, { allowedOrigins: ["https://abc.ngrok.app"] }), null)
  // another page on a wildcard domain the proxy serves is not this page
  assert.ok(refuseWrite(req("https://evil.local.dev", "localhost:5173", "127.0.0.1", { "x-forwarded-host": "app.local.dev" }), K))
  // another program on this machine, at another port
  assert.ok(refuseWrite(req("http://127.0.0.1:3000", "127.0.0.1:5173", "127.0.0.1"), K))
  // a domain pointed at this machine (DNS rebinding) is its own page by Origin and Host, and still refused
  assert.match(refuseWrite(req("http://evil.example:5173", "evil.example:5173", "127.0.0.1"), K) ?? "", /not a name the dev server is known by.*allowedOrigins/)
  // unless Vite is told the name, or Swatch is; an address needs neither
  assert.equal(refuseWrite(req("http://dev.box:5173", "dev.box:5173", "127.0.0.1"), K, { allowedHosts: [".box"] }), null)
  assert.equal(refuseWrite(req("http://dev.box:5173", "dev.box:5173", "127.0.0.1"), K, { allowedOrigins: ["http://dev.box:5173"] }), null)
  assert.equal(refuseWrite(req("http://192.168.1.5:5173", "192.168.1.5:5173", "192.168.1.9"), K), null)
  assert.equal(refuseWrite(req("http://[::1]:5173", "[::1]:5173", "::1"), K), null)
  // a name Vite allows is not trusted as another origin: only as this server's own
  assert.ok(refuseWrite(req("https://evil.local.dev", "app.local.dev", "127.0.0.1"), K, { allowedHosts: [".local.dev"] }))
  // a refusal says what to do
  assert.match(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1"), K) ?? "", /add "https:\/\/abc\.ngrok\.app" to swatch\(\{ allowedOrigins/)
  assert.equal(refuseWrite(req("http://localhost:5173", "localhost:5173", "127.0.0.1"), "x".repeat(48)), STALE_KEY)
  // a script with no Origin: from this machine directly yes; through a local proxy, or from the network, no
  assert.equal(refuseWrite(req(undefined, "localhost:5173", "127.0.0.1"), K), null)
  assert.equal(refuseWrite(req(undefined, "localhost:5173", "::1"), K), null)
  assert.ok(refuseWrite(req(undefined, "localhost:5173", "127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), K))
  assert.ok(refuseWrite(req(undefined, "localhost:5173", "127.0.0.1", { forwarded: "for=203.0.113.9" }), K))
  assert.ok(refuseWrite(req(undefined, "192.168.1.5:5173", "192.168.1.9"), K))
})

test("a save across several stylesheets changes all of them or none", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-atomic-"))
  writeFileSync(join(dir, "a.css"), ":root { --a: red; }\n")
  writeFileSync(join(dir, "b.css"), ":root { --b: blue; }\n")
  const project = new Project(dir)
  // b.css is read-only: it is not written over, and a's change must not stay behind
  chmodSync(join(dir, "b.css"), 0o444)
  try {
    assert.throws(() => project.write([{ theme: "light", name: "--a", value: "green" }, { theme: "light", name: "--b", value: "navy" }]), /nothing was saved/)
    assert.equal(readFileSync(join(dir, "a.css"), "utf8"), ":root { --a: red; }\n")
    assert.equal(readFileSync(join(dir, "b.css"), "utf8"), ":root { --b: blue; }\n")
  } finally { chmodSync(join(dir, "b.css"), 0o644) }
})

test("a save keeps the file the file it was: a link stays a link, the permissions stay, a locked folder is no obstacle", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-same-"))
  mkdirSync(join(dir, "design")); mkdirSync(join(dir, "app"))
  writeFileSync(join(dir, "design", "tokens.css"), ":root { --a: red; }\n")
  chmodSync(join(dir, "design", "tokens.css"), 0o600)
  symlinkSync(join(dir, "design", "tokens.css"), join(dir, "app", "tokens.css"))
  new Project(join(dir, "app")).write([{ theme: "light", name: "--a", value: "green" }])
  assert.ok(lstatSync(join(dir, "app", "tokens.css")).isSymbolicLink())
  assert.equal(readFileSync(join(dir, "design", "tokens.css"), "utf8"), ":root { --a: green; }\n")
  assert.equal(statSync(join(dir, "design", "tokens.css")).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(join(dir, "design")), ["tokens.css"])
  // a folder that takes no new files: the stylesheet is written in place
  chmodSync(join(dir, "design"), 0o555)
  try {
    new Project(join(dir, "app")).write([{ theme: "light", name: "--a", value: "blue" }])
    assert.equal(readFileSync(join(dir, "design", "tokens.css"), "utf8"), ":root { --a: blue; }\n")
  } finally { chmodSync(join(dir, "design"), 0o755) }
})

test("an edit that says what it replaces is refused when the stylesheet holds something else", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-was-"))
  writeFileSync(join(dir, "a.css"), ":root { --a: red; --b: blue; }\n")
  const project = new Project(dir)
  // the panel read red; an editor has since made it crimson
  writeFileSync(join(dir, "a.css"), ":root { --a: crimson; --b: blue; }\n")
  assert.throws(() => project.write([{ theme: "light", name: "--b", value: "navy", was: "blue" }, { theme: "light", name: "--a", value: "green", was: "red" }]), /--a changed in the stylesheet .*red then, crimson now.*nothing was saved/)
  assert.equal(readFileSync(join(dir, "a.css"), "utf8"), ":root { --a: crimson; --b: blue; }\n")
  // knowing what is there, it goes through; so does a new token (was: null) and an edit that does not say
  project.write([{ theme: "light", name: "--a", value: "green", was: "crimson" }, { theme: "light", name: "--c", value: "teal", was: null }, { theme: "light", name: "--b", value: "navy" }])
  assert.equal(readFileSync(join(dir, "a.css"), "utf8"), ":root { --a: green; --b: navy; --c: teal; }\n")
})

test("folders named public, build or vendor are searched; node_modules, hidden folders and the build output are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-skip-"))
  for (const [path, css] of [["public/theme.css", "--p"], ["src/build/x.css", "--b"], ["vendor/v.css", "--v"], ["dist/out.css", "--d"], ["node_modules/pkg/n.css", "--n"], [".cache/c.css", "--c"], ["ignored/i.css", "--i"]]) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), `:root { ${css}: red; }\n`)
  }
  const names = new Project(dir, { ignore: ["ignored"] }).read().tokens.map((t) => t.name).sort()
  assert.deepEqual(names, ["--b", "--p", "--v"])
})

test("a request dealt with leaves the queue, and the log keeps only the last hundred", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-queue-"))
  const queue = new Queue(dir)
  const ids = Array.from({ length: 105 }, () => queue.add({ kind: "figma-sync", figma: "https://www.figma.com/design/x/y" }, []).id)
  assert.equal(queue.pending().length, 105)
  for (const id of ids.slice(0, 104)) queue.resolve(id)
  assert.deepEqual(queue.pending().map((r) => r.id), [ids[104]])
  assert.equal(readFileSync(join(dir, ".swatch", "requests.jsonl"), "utf8").trim().split("\n").length, 1)
  assert.equal(readFileSync(join(dir, ".swatch", "done.jsonl"), "utf8").trim().split("\n").length, 100)
  // a request added after the queue was last read is still seen
  const late = queue.add({ kind: "figma-sync", figma: "https://www.figma.com/design/x/z" }, []).id
  assert.ok(queue.pending().some((r) => r.id === late))
})

test("a stylesheet that changed on disk after it was read is not written over", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-race-"))
  const file = join(dir, "a.css")
  writeFileSync(file, ":root { --a: red; }\n")
  const planned = plan(new Map([[file, [{ theme: "light" as const, name: "--a", value: "green" }]]]))
  // an editor saves between Swatch's read and its write
  writeFileSync(file, ":root { --a: blue; }\n")
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  assert.throws(() => commit(planned), /changed on disk/)
  assert.equal(readFileSync(file, "utf8"), ":root { --a: blue; }\n", "the editor's save stands")
  // a save with nothing in the way goes through, and leaves no temporary file
  assert.deepEqual(writeAll(new Map([[file, [{ theme: "light" as const, name: "--a", value: "green" }]]])).map((c) => c.to), ["green"])
  assert.deepEqual(readdirSync(dir), ["a.css"])
})

test("the queue's folder ignores itself, so it is never committed", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-ignore-"))
  new Queue(dir).add({ kind: "figma-sync", figma: "https://www.figma.com/design/x/y" }, [])
  assert.match(readFileSync(join(dir, ".swatch", ".gitignore"), "utf8"), /^\*$/m)
})

test("a src folder that does not exist is a warning, not a failed read", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-nosrc-"))
  writeFileSync(join(dir, "a.css"), ":root { --a: red; }\n")
  assert.deepEqual(new Project(dir, { src: "no-such-folder" }).read().tokens.map((t) => t.name), ["--a"])
  assert.ok(!existsSync(join(dir, "no-such-folder")))
})

