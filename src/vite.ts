// Swatch for Vite: `plugins: [swatch()]`.
//
// In development only (`apply: "serve"`), it adds the panel to the page
// and serves /__swatch, which lists the project's colour tokens and writes
// edits back to their stylesheets. A production build never contains it.
//
//   GET    /__swatch            the tokens (see Sheet)
//   POST   /__swatch            [{ theme, name, value }] writes values; answers as GET, plus `changes`
//   GET    /__swatch/events     server-sent events: "css" when a stylesheet changes, "incoming" when an agent answers
//   GET    /__swatch/client.js  the panel
//   POST   /__swatch/request    leaves a request for a coding agent (server/requests.ts)
//   GET    /__swatch/incoming   what the agent left, or null
//   DELETE /__swatch/incoming   the panel has taken it
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { Project, forget, watched, type Options } from "./server/project.ts"
import { Queue, type Request } from "./server/requests.ts"
import type { Edit } from "./server/stylesheet.ts"

export type { Options }

const LIMIT = 1_000_000 // bytes in a request body
const CLIENT = fileURLToPath(new URL("./client.js", import.meta.url))

export default function swatch(options: Options = {}): Plugin {
  let project: Project
  let queue: Queue
  return {
    name: "swatch",
    apply: "serve",
    configResolved(config) {
      project = new Project(config.root, options)
      queue = new Queue(config.root)
    },
    transformIndexHtml: () => [
      { tag: "script", attrs: { type: "module", src: "/__swatch/client.js" }, injectTo: "body" },
    ],
    configureServer(server) {
      // the panel hears when a stylesheet changes on disk (a save, an
      // agent's edit, a branch switch) and when an agent leaves an answer
      const listeners = new Set<ServerResponse>()
      const tell = (what: "css" | "incoming") => { for (const res of listeners) res.write(`data: ${what}\n\n`) }
      const changed = (f: string, listChanged: boolean) => {
        forget(f, listChanged)
        if (f === queue.incoming) tell("incoming")
        else if (f.endsWith(".css")) tell("css")
      }
      watched()
      server.watcher.add(queue.dir)
      server.watcher.on("change", (f) => changed(f, false))
      server.watcher.on("add", (f) => changed(f, true))
      server.watcher.on("unlink", (f) => changed(f, true))
      server.watcher.on("addDir", () => forget("", true))
      server.watcher.on("unlinkDir", () => forget("", true))

      server.middlewares.use("/__swatch", (req: IncomingMessage, res: ServerResponse) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify(body))
        }
        // only the page on this dev server may read or write: a page on
        // another origin (another localhost port included) is refused
        const origin = req.headers.origin
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(403, { error: "cross-origin request refused" })
        const route = (req.url ?? "/").split("?")[0]
        const method = req.method ?? ""
        const routes: Record<string, string[]> = { "/": ["GET", "POST"], "/events": ["GET"], "/client.js": ["GET"], "/request": ["POST"], "/incoming": ["GET", "DELETE"] }
        if (!routes[route]) return send(404, { error: "no such route" })
        if (!routes[route].includes(method)) return send(405, { error: `${routes[route].join(" or ")} only` })
        if (route === "/client.js") {
          res.setHeader("content-type", "text/javascript")
          res.setHeader("cache-control", "no-cache")
          return res.end(readFileSync(CLIENT))
        }
        if (route === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
          res.write("retry: 2000\n\n")
          listeners.add(res)
          req.on("close", () => listeners.delete(res))
          return
        }
        if (method === "GET" || method === "DELETE") {
          try {
            if (route === "/") return send(200, project.read())
            if (method === "DELETE") { queue.clear(); return send(200, null) }
            return send(200, queue.take())
          } catch (err) {
            return send(500, { error: String(err instanceof Error ? err.message : err) })
          }
        }
        // the body is read to its end even when too large (so the answer
        // can be delivered), but nothing past the limit is kept
        const chunks: Buffer[] = []
        let size = 0
        req.on("data", (c: Buffer) => { size += c.length; if (size <= LIMIT) chunks.push(c) })
        req.on("end", () => {
          if (size > LIMIT) return send(413, { error: "request too large" })
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            if (route === "/request") return send(200, queue.add(body as Request, project.stylesheets().map((f) => f.slice(project.root.length + 1))))
            const changes = project.write(body as Edit[])
            send(200, { ...project.read(), changes })
          } catch (err) {
            send(400, { error: String(err instanceof Error ? err.message : err) })
          }
        })
      })
    },
  }
}
