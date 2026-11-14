// Swatch's MCP server: `npx @tyfoster/swatch mcp`, run from the project root.
//
// It gives a coding agent tools for what the panel asks of it and for the
// tokens themselves, so the agent never has to know about the files under
// `.swatch/`. It speaks the Model Context Protocol over stdio: one JSON-RPC
// message per line, in and out. Nothing but protocol messages goes to
// stdout; anything else would corrupt the stream.
import { createInterface } from "node:readline"
import { Project, type Options } from "./server/project.ts"
import { Queue, type Proposal } from "./server/requests.ts"
import type { Edit } from "./server/stylesheet.ts"

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

type Tool = { name: string; description: string; inputSchema: object; run: (args: Record<string, unknown>) => unknown | Promise<unknown> }

const edit = {
  type: "object",
  properties: {
    name: { type: "string", description: "The custom property, e.g. --card" },
    theme: { type: "string", enum: ["light", "dark"] },
    value: { type: "string", description: 'The CSS value, e.g. "#f4f4f6" or "var(--foreground)". An empty string removes the declaration (a dark value removed falls back to the light one).' },
  },
  required: ["name", "theme", "value"],
}

export function tools(project: Project, queue: Queue): Tool[] {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  return [
    {
      name: "swatch_list_tokens",
      description: "List the project's CSS custom properties in its light and dark themes: each token's value per theme, the stylesheet it is declared in, and how many times it is used. Use this to see the current colours before proposing or writing changes.",
      inputSchema: { type: "object", properties: {} },
      run: () => {
        const sheet = project.read()
        return {
          stylesheets: sheet.files,
          dark: sheet.dark,
          tokens: sheet.tokens.map((t) => ({ name: t.name, light: t.light ?? null, dark: t.dark ?? null, file: t.file, uses: t.uses.reduce((n, u) => n + u.n, 0) })),
        }
      },
    },
    {
      name: "swatch_pending_requests",
      description: 'List what the person using the Swatch panel has asked for and no agent has dealt with yet. A "commit" request lists stylesheet changes they saved and want committed (each with its token, theme, old and new value). A "figma-sync" request names a Figma file whose colour variables they want pulled in: read them, then call swatch_propose_edits. Call swatch_resolve_request once each is dealt with.',
      inputSchema: { type: "object", properties: {} },
      run: () => ({ requests: queue.pending() }),
    },
    {
      name: "swatch_wait_for_request",
      description: "Wait until the person using the Swatch panel asks for something, then return the pending requests. Returns an empty list if nothing arrives within the timeout; call it again to keep waiting.",
      inputSchema: { type: "object", properties: { timeout_seconds: { type: "number", description: "How long to wait, 1 to 300. Default 60." } } },
      run: async (args) => {
        const limit = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 300) * 1000
        const until = Date.now() + limit
        for (;;) {
          const requests = queue.pending()
          if (requests.length || Date.now() >= until) return { requests }
          await sleep(500)
        }
      },
    },
    {
      name: "swatch_resolve_request",
      description: "Mark a request from swatch_pending_requests as dealt with, so it is not listed again.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, note: { type: "string", description: "What was done, in a few words." } }, required: ["id"] },
      run: (args) => { queue.resolve(String(args.id), args.note === undefined ? undefined : String(args.note)); return { resolved: args.id } },
    },
    {
      name: "swatch_propose_edits",
      description: "Show colour values in the Swatch panel as unsaved edits: the person sees them previewed live on the page and chooses whether to save. Nothing is written to a stylesheet. Use this to answer a figma-sync request, or to suggest colours. Prefer this over swatch_write_tokens unless you were asked to change the files directly. The dev server must be running for the panel to pick them up.",
      inputSchema: {
        type: "object",
        properties: {
          edits: { type: "object", description: 'Token name to its values, e.g. { "--card": { "light": "#eeeeee", "dark": "#1d1d22" } }. Give only the themes that change.', additionalProperties: { type: "object", properties: { light: { type: "string" }, dark: { type: "string" } } } },
          note: { type: "string", description: 'One line the panel shows with them, e.g. "12 values from Figma".' },
        },
        required: ["edits"],
      },
      run: (args) => ({ proposed: queue.propose(args.edits as Proposal, args.note === undefined ? undefined : String(args.note)) }),
    },
    {
      name: "swatch_write_tokens",
      description: "Write colour token values straight into the project's stylesheets, leaving every other byte of each file as it was. A value that would break the stylesheet is refused and nothing is written. Returns each change with the old and new value.",
      inputSchema: { type: "object", properties: { edits: { type: "array", items: edit } }, required: ["edits"] },
      run: (args) => ({ changes: project.write(args.edits as Edit[]) }),
    },
  ]
}

type Message = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> }

/** Answers one message, or returns nothing for a notification. */
export async function handle(msg: Message, all: Tool[], version: string): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } })
  if (msg.id === undefined) return undefined // a notification: nothing to answer
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "")
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "swatch", version },
        instructions: "Swatch is a live colour-token editor in the project's dev server. Call swatch_pending_requests (or swatch_wait_for_request) to see what the person using its panel has asked for.",
      })
    }
    case "ping": return reply({})
    case "tools/list": return reply({ tools: all.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case "tools/call": {
      const tool = all.find((t) => t.name === msg.params?.name)
      if (!tool) return fail(-32602, `unknown tool "${msg.params?.name}"`)
      try {
        const out = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {})
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] })
      } catch (err) {
        // a tool's own failure is a result the agent can read and act on
        return reply({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default: return fail(-32601, `method not found: ${msg.method}`)
  }
}

export function serve(root: string, options: Options, version: string) {
  const all = tools(new Project(root, options), new Queue(root))
  const out = (m: object) => process.stdout.write(JSON.stringify(m) + "\n")
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return
    let msg: Message
    try { msg = JSON.parse(line) } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) }
    const answer = await handle(msg, all, version)
    if (answer) out(answer)
  })
}
