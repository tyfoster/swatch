/**
 * The MCP server: the protocol's handshake and tool calls, and what each
 * tool does to the request queue and the stylesheets. Driven through
 * `handle`, the function the stdio loop calls for every message.
 *
 * Node runs this file directly: `node --test test/`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handle, tools } from "../src/mcp.ts"
import { Project } from "../src/server/project.ts"
import { Queue } from "../src/server/requests.ts"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "swatch-mcp-"))
  writeFileSync(join(root, "style.css"), ":root {\n  --card: #f4f4f6;\n  --text: #111;\n}\n.dark {\n  --card: #1d1d22;\n}\n")
  writeFileSync(join(root, "app.tsx"), '<div className="bg-card" style={{ color: "var(--text)" }} />')
  const queue = new Queue(root)
  const all = tools(new Project(root), queue)
  let id = 0
  const rpc = (method: string, params?: Record<string, unknown>) => handle({ jsonrpc: "2.0", id: ++id, method, params }, all, "0.0.0") as Promise<{ result?: any; error?: any }>
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await rpc("tools/call", { name, arguments: args })
    return { isError: !!result.isError, out: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) }
  }
  return { root, queue, rpc, call }
}

test("initialize answers with the version asked for, and falls back to its newest", async () => {
  const { rpc } = setup()
  assert.equal((await rpc("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion, "2024-11-05")
  const r = (await rpc("initialize", { protocolVersion: "1999-01-01" })).result
  assert.equal(r.protocolVersion, "2025-06-18")
  assert.deepEqual(r.capabilities, { tools: {} })
  assert.equal(r.serverInfo.name, "swatch")
})

test("a notification gets no answer, and an unknown method an error", async () => {
  const { rpc } = setup()
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, [], "0"), undefined)
  assert.equal((await rpc("nope")).error.code, -32601)
})

test("tools/list names every tool with a schema", async () => {
  const { rpc } = setup()
  const list = (await rpc("tools/list")).result.tools
  assert.deepEqual(list.map((t: { name: string }) => t.name), ["swatch_list_tokens", "swatch_pending_requests", "swatch_wait_for_request", "swatch_resolve_request", "swatch_propose_edits", "swatch_write_tokens"])
  for (const t of list) assert.equal(t.inputSchema.type, "object")
})

test("list_tokens gives each token's values, file and uses", async () => {
  const { call } = setup()
  const { out } = await call("swatch_list_tokens")
  assert.deepEqual(out.stylesheets, ["style.css"])
  assert.deepEqual(out.tokens.find((t: { name: string }) => t.name === "--card"), { name: "--card", light: "#f4f4f6", dark: "#1d1d22", file: "style.css", uses: 1 })
  assert.equal(out.tokens.find((t: { name: string }) => t.name === "--text").dark, null)
})

test("a request is pending until it is resolved, and resolving it twice is refused", async () => {
  const { queue, call } = setup()
  const { id } = queue.add({ kind: "figma-sync", figma: "https://www.figma.com/design/abc/File" }, ["style.css"])
  const pending = (await call("swatch_pending_requests")).out.requests
  assert.equal(pending.length, 1)
  assert.equal(pending[0].figma, "https://www.figma.com/design/abc/File")
  assert.equal((await call("swatch_resolve_request", { id, note: "done" })).isError, false)
  assert.equal((await call("swatch_pending_requests")).out.requests.length, 0)
  assert.equal((await call("swatch_resolve_request", { id })).isError, true)
})

test("wait_for_request returns at once when something is pending, and empty at the timeout", async () => {
  const { queue, call } = setup()
  const t0 = Date.now()
  assert.equal((await call("swatch_wait_for_request", { timeout_seconds: 1 })).out.requests.length, 0)
  assert.ok(Date.now() - t0 >= 900)
  queue.add({ kind: "commit", changes: [{ name: "--card", theme: "light", from: "#f4f4f6", to: "#eee" }] }, ["style.css"])
  const t1 = Date.now()
  assert.equal((await call("swatch_wait_for_request", { timeout_seconds: 30 })).out.requests.length, 1)
  assert.ok(Date.now() - t1 < 500)
})

test("propose_edits leaves the values for the panel and writes no stylesheet", async () => {
  const { root, queue, call } = setup()
  const before = readFileSync(join(root, "style.css"), "utf8")
  assert.deepEqual((await call("swatch_propose_edits", { edits: { "--card": { light: " #eee ", dark: "#222" } }, note: "from Figma" })).out, { proposed: 2 })
  assert.deepEqual(queue.take(), { edits: { "--card": { light: "#eee", dark: "#222" } }, note: "from Figma" })
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), before)
})

test("a proposal with a value that would break a stylesheet is refused whole", async () => {
  const { queue, call } = setup()
  const r = await call("swatch_propose_edits", { edits: { "--text": { light: "#000" }, "--card": { light: "rgb(0 0 0" } } })
  assert.equal(r.isError, true)
  assert.equal(queue.take(), null)
})

test("write_tokens changes the stylesheet and reports old and new, and refuses a bad value", async () => {
  const { root, call } = setup()
  const { out } = await call("swatch_write_tokens", { edits: [{ name: "--card", theme: "light", value: "#eee" }] })
  assert.deepEqual(out.changes, [{ name: "--card", theme: "light", from: "#f4f4f6", to: "#eee" }])
  assert.equal(readFileSync(join(root, "style.css"), "utf8"), ":root {\n  --card: #eee;\n  --text: #111;\n}\n.dark {\n  --card: #1d1d22;\n}\n")
  assert.equal((await call("swatch_write_tokens", { edits: [{ name: "--card", theme: "light", value: "url(" }] })).isError, true)
})

test("a tool that does not exist is an error, not a crash", async () => {
  const { rpc } = setup()
  assert.equal((await rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602)
})
