// `npx swatch-token mcp [--root <dir>] [--css <file>[,<file>]] [--src <dir>]`
import { readFileSync } from "node:fs"
import { serve } from "./mcp.ts"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version

if (args[0] === "mcp") {
  const css = flag("css")?.split(",").filter(Boolean)
  serve(flag("root") ?? process.cwd(), { css, src: flag("src") }, version)
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(version)
} else {
  console.error(`swatch ${version}

Usage:
  npx swatch-token mcp [--root <dir>] [--css <file>[,<file>]] [--src <dir>]
      Run the MCP server for a coding agent, from the project root.

The panel itself is a Vite plugin: import swatch from "swatch-token/vite".`)
  process.exit(args.length ? 1 : 0)
}
