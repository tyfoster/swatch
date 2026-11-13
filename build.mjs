// Builds the Vite plugin and the command line (Node, their dependencies
// left to the installer) and the panel (one browser file with React inside it, so
// it never meets the host app's React, or needs the app to have one).
import { build } from "esbuild"

await build({
  entryPoints: ["src/vite.ts"],
  outfile: "dist/vite.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
})
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
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
