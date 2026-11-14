// Builds the Vite plugin and the command line (Node, their dependencies
// left to the installer) and the panel (one browser file with React inside it, so
// it never meets the host app's React, or needs the app to have one).
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"

// `--types`, run after tsc has written the declaration files: the source
// imports its neighbours as "./x.ts", and tsc copies that into the .d.ts
// files, where no such file exists (only x.d.ts). "./x.js" is the spelling
// TypeScript resolves to x.d.ts, so a project that installs Swatch gets the
// plugin's option types instead of `any`.
if (process.argv.includes("--types")) {
  const fix = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) fix(path)
      else if (path.endsWith(".d.ts")) writeFileSync(path, readFileSync(path, "utf8").replace(/(from\s+"\.{1,2}\/[^"]+)\.ts"/g, '$1.js"'))
    }
  }
  fix("dist")
  process.exit(0)
}

await build({
  entryPoints: ["src/vite.ts"],
  outfile: "dist/vite.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
})
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
})
await build({
  entryPoints: ["src/client/mount.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
})
