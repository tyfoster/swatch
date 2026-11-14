/**
 * The dev server's half: its routes, run through a real Vite dev server
 * with the plugin, and the rules behind them (who may write, saves across
 * several stylesheets, the agent's queue, which folders are searched).
 *
 * Node runs this file directly: `node --test test/`.
 */
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type ViteDevServer } from "vite"

import swatch from "../src/vite.ts"
import { refuseWrite } from "../src/server/guard.ts"
import { Project } from "../src/server/project.ts"
import { Queue } from "../src/server/requests.ts"

const STYLE = ":root {\n  --card: #f4f4f6;\n}\n.dark {\n  --card: #1d1d22;\n}\n"
let root = "", server: ViteDevServer, base = ""

before(async () => {
  root = mkdtempSync(join(tmpdir(), "swatch-routes-"))
  writeFileSync(join(root, "index.html"), "<!doctype html><html><body></body></html>")
  writeFileSync(join(root, "style.css"), STYLE)
  server = await createServer({ root, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, plugins: [swatch()] })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})
after(async () => { await server?.close() })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers })

test("GET /__swatch lists the tokens", async () => {
  const r = await fetch(base + "/__swatch")
  assert.equal(r.status, 200)
  const sheet = await r.json()
  assert.deepEqual(sheet.files, ["style.css"])
  assert.equal(sheet.tokens.find((t: { name: string }) => t.name === "--card").dark, "#1d1d22")
})

test("the page's script names the project, by a hash and not its path", async () => {
  const html = await server.transformIndexHtml("/index.html", readFileSync(join(root, "index.html"), "utf8"))
  const id = /data-swatch-project="([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(id && id.length === 12)
  assert.ok(!html.includes(root))
})

test("a save from the page writes the stylesheet, and the version moves", async () => {
  const v0 = await (await fetch(base + "/__swatch/version")).json()
  const r = await post("/__swatch", [{ theme: "light", name: "--card", value: "#eeeeee" }], { origin: base })
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
  const big = await post("/__swatch", "x".repeat(1_100_000), { origin: base })
  assert.equal(big.status, 413)
})

test("a value that would break the stylesheet is a 400, and nothing is written", async () => {
  const r = await post("/__swatch", [{ theme: "light", name: "--card", value: "rgb(0 0 0" }], { origin: base })
  assert.equal(r.status, 400)
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), STYLE)
})

test("who may write", () => {
  const req = (origin: string | undefined, host: string, remote: string) => ({ headers: { origin, host }, socket: { remoteAddress: remote } })
  // the page itself
  assert.equal(refuseWrite(req("http://localhost:5173", "localhost:5173", "127.0.0.1")), null)
  // through a tunnel that rewrites Host: trusted when Vite is told to answer to it
  assert.ok(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1")))
  assert.equal(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1"), { allowedHosts: [".ngrok.app"] }), null)
  assert.equal(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1"), { allowedOrigins: ["https://abc.ngrok.app"] }), null)
  assert.equal(refuseWrite(req("https://abc.ngrok.app", "localhost:5173", "127.0.0.1"), { allowedHosts: true }), null)
  // a script with no Origin: from this machine yes, from the network no
  assert.equal(refuseWrite(req(undefined, "localhost:5173", "127.0.0.1")), null)
  assert.equal(refuseWrite(req(undefined, "localhost:5173", "::1")), null)
  assert.ok(refuseWrite(req(undefined, "192.168.1.5:5173", "192.168.1.9")))
  // a teammate's browser on the network, at the address the server was opened on
  assert.equal(refuseWrite(req("http://192.168.1.5:5173", "192.168.1.5:5173", "192.168.1.9")), null)
  // another program on this machine, or on the server's host at another port, even when Vite lists that host
  assert.ok(refuseWrite(req("http://127.0.0.1:3000", "127.0.0.1:5173", "127.0.0.1"), { allowedHosts: ["127.0.0.1"] }))
  assert.ok(refuseWrite(req("http://localhost:3000", "localhost:5173", "127.0.0.1"), { allowedHosts: true }))
  assert.ok(refuseWrite(req("http://192.168.1.5:3000", "192.168.1.5:5173", "192.168.1.9"), { allowedHosts: ["192.168.1.5"] }))
})

test("a save across several stylesheets changes all of them or none", () => {
  const dir = mkdtempSync(join(tmpdir(), "swatch-atomic-"))
  writeFileSync(join(dir, "a.css"), ":root { --a: red; }\n")
  writeFileSync(join(dir, "b.css"), ":root { --b: blue; }\n")
  const project = new Project(dir)
  // b.css cannot be written: a's change must not stay behind
  chmodSync(join(dir, "b.css"), 0o444)
  assert.throws(() => project.write([{ theme: "light", name: "--a", value: "green" }, { theme: "light", name: "--b", value: "navy" }]), /nothing was saved/)
  assert.equal(readFileSync(join(dir, "a.css"), "utf8"), ":root { --a: red; }\n")
  chmodSync(join(dir, "b.css"), 0o644)
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
