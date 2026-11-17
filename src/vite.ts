// Swatch for Vite: `plugins: [swatch()]`.
//
// In development only (`apply: "serve"`), it adds the panel to the page
// and serves /__swatch, which lists the project's colour tokens and writes
// edits back to their stylesheets. A production build never contains it.
//
//   GET    /__swatch            the tokens (see Sheet)
//   POST   /__swatch            [{ theme, name, value }] writes values; answers as GET, plus `changes`
//   GET    /__swatch/version    { css, incoming }: counters that move when a stylesheet changes or an agent answers
//   GET    /__swatch/client.js  the panel
//   POST   /__swatch/request    leaves a request for a coding agent (server/requests.ts)
//   GET    /__swatch/incoming   what the agent left, or null
//   DELETE /__swatch/incoming   the panel has taken it
//
// Writes (POST and DELETE) are held to server/guard.ts.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { refuseWrite, type Trust } from "./server/guard.ts"
import { Project, type Options } from "./server/project.ts"
import { Queue, type Request } from "./server/requests.ts"
import type { Edit } from "./server/stylesheet.ts"

export type { Options }

const LIMIT = 1_000_000 // bytes in a request body
const CLIENT = fileURLToPath(new URL("./client.js", import.meta.url))

export default function swatch(options: Options = {}): Plugin {
  let project: Project
  let queue: Queue
  let trust: Trust = {}
  // names this project for the panel's saved state, so two projects served
  // on the same port never share unsaved edits; a hash, so the page never
  // carries the project's path
  let id = ""
  // the session key the panel sends with every write (server/guard.ts):
  // new each time the dev server starts
  const key = randomBytes(24).toString("hex")
  return {
    name: "swatch",
    apply: "serve",
    configResolved(config) {
      project = new Project(config.root, options, [config.build.outDir, config.cacheDir, config.publicDir].filter(Boolean))
      queue = new Queue(config.root)
      id = createHash("sha256").update(project.root).digest("hex").slice(0, 12)
      trust = { allowedOrigins: options.allowedOrigins }
    },
    transformIndexHtml: () => [
      { tag: "script", attrs: { type: "module", src: "/__swatch/client.js", "data-swatch-project": id, "data-swatch-key": key }, injectTo: "body" },
    ],
    configureServer(server) {
      // The panel asks every couple of seconds whether anything moved: a
      // stylesheet changed on disk (a save, an agent's edit, a branch
      // switch) or an agent left an answer. Asking, rather than holding a
      // connection open, keeps every tab from taking one of the few
      // connections a browser allows each site.
      const version = { css: 0, incoming: 0 }
      const changed = (f: string, listChanged: boolean) => {
        project.forget(f, listChanged)
        if (f === queue.incoming) version.incoming++
        else if (f.endsWith(".css")) version.css++
      }
      project.watch()
      server.watcher.add(queue.dir)
      server.watcher.on("change", (f) => changed(f, false))
      server.watcher.on("add", (f) => changed(f, true))
      server.watcher.on("unlink", (f) => changed(f, true))
      server.watcher.on("addDir", (f) => project.forget(f, true))
      server.watcher.on("unlinkDir", (f) => project.forget(f, true))

      server.middlewares.use("/__swatch", (req: IncomingMessage, res: ServerResponse) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader("content-type", "application/json")
          res.setHeader("cache-control", "no-store")
          res.end(JSON.stringify(body))
        }
        const route = (req.url ?? "/").split("?")[0]
        const method = req.method ?? ""
        const routes: Record<string, string[]> = { "/": ["GET", "POST"], "/version": ["GET"], "/client.js": ["GET"], "/request": ["POST"], "/incoming": ["GET", "DELETE"] }
        if (!routes[route]) return send(404, { error: "no such route" })
        if (!routes[route].includes(method)) return send(405, { error: `${routes[route].join(" or ")} only` })
        if (method !== "GET") {
          const why = refuseWrite(req, key, trust)
          if (why) return send(403, { error: why })
        }
        if (route === "/client.js") {
          res.setHeader("content-type", "text/javascript")
          res.setHeader("cache-control", "no-cache")
          return res.end(readFileSync(CLIENT))
        }
        if (route === "/version") return send(200, version)
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
