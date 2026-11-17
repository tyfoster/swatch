// `npx swatch-token mcp [--root <dir>] [--css <file>[,<file>]] [--src <dir>] [--ignore <dir>[,<dir>]]`
import { readFileSync } from "node:fs"
import { serve } from "./mcp.ts"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version

if (args[0] === "mcp") {
  // the same options the plugin takes, so the agent sees the stylesheets the panel does
  const list = (name: string) => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean)
  serve(flag("root") ?? process.cwd(), { css: list("css"), src: flag("src"), ignore: list("ignore") }, version)
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(version)
} else {
  console.error(`swatch ${version}

Usage:
  npx swatch-token mcp [--root <dir>] [--css <file>[,<file>]] [--src <dir>] [--ignore <dir>[,<dir>]]
      Run the MCP server for a coding agent, from the project root.

The panel itself is a Vite plugin: import swatch from "swatch-token/vite".`)
  process.exit(args.length ? 1 : 0)
}
