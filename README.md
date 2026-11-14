# Swatch

Edit your CSS colour tokens live, on the page.

Swatch is a dev-only panel for [Vite](https://vite.dev) apps. It finds the
custom properties in your stylesheets, shows each one in light and dark,
previews every edit on the real app as you type, and writes the result back
to the file. A production build never contains it.

## Install

```bash
npm install swatch-token -D
```

```ts
// vite.config.ts
import swatch from "swatch-token/vite"

export default {
  plugins: [swatch()],
}
```

Start your dev server. Swatch sits in the bottom-left corner.

There is nothing to configure: Swatch scans the project for stylesheets
that declare custom properties on a theme and lists the ones whose values
are colours.

## What it does

- **Live preview.** An edit shows on the page at once; nothing touches the
  file until you press Save. Reset takes back everything the tab has saved.
- **Light and dark, side by side.** Dark is read from `.dark`,
  `[data-theme="dark"]` (also `data-mode`, `data-color-scheme`), or
  `@media (prefers-color-scheme: dark)`.
- **A colour picker** with alpha, in HEX, RGB, HSL or OKLCH.
- **Token references.** Type `-` in a value to search the other tokens and
  insert `var(--name)`.
- **Contrast.** Each `--x-foreground` shows its WCAG ratio against `--x`.
- **Uses.** How many times each token is used across the project, by file,
  counting `var(--x)` and Tailwind utilities (`bg-x`, `text-x/60`).
- **Inspect.** Hover the page to see the tokens behind an element and its
  contrast; click to filter the list to them, shift-click to add more.
- **Find.** Hold it to paint a token magenta wherever it lands on the page.

## What counts as a token

Custom properties declared in:

| Where | Theme |
| --- | --- |
| `:root { … }` or `html { … }` (also inside `@layer`) | light |
| Tailwind's `@theme { … }` | light |
| `.dark { … }`, `[data-theme="dark"] { … }` | dark |
| `@media (prefers-color-scheme: dark) { :root { … } }` | dark |

`@theme inline { … }` is skipped: it maps utility names to tokens declared
elsewhere. A property is listed when its value comes to a colour in either
theme, as the browser reads it, so `red`, `currentColor`, `color-mix()` and
`color(display-p3 …)` all count, and `--radius: 10px` does not.

## How it writes

Stylesheets are parsed with PostCSS and printed back with every byte
outside the edited declaration unchanged: comments, formatting, `@media`
and `@layer` blocks all stay as they were. A value that would break the
file (an unclosed bracket, quote or comment) is refused before anything is
written.

## Options

```ts
swatch({
  // the stylesheet(s) holding the tokens; default: found automatically
  css: "src/styles/tokens.css",
  // where uses are counted; default: the whole project
  src: "src",
  // section titles for the panel; default: grouped by the first word of each name
  groups: { Surfaces: /^--(background|card|popover)/, Text: /-foreground$/ },
  // show "Save & send to agent" and "Figma sync" (see below)
  agent: true,
  // folders to leave out of the search (node_modules, hidden folders and the build output already are)
  ignore: ["storybook-static"],
  // origins besides the dev server's own that may save, such as a tunnel
  allowedOrigins: ["https://my-tunnel.example"],
})
```

Saving is only accepted from the page on your dev server. Behind a tunnel
or a forwarded port, add its host to Vite's `server.allowedHosts` (which
Vite asks for anyway) or its origin to `allowedOrigins`. A dev server opened
to the network with `--host` takes saves from browsers on the page, but not
from scripts on other machines.

## Working with a coding agent

Swatch ships an [MCP](https://modelcontextprotocol.io) server, so a coding
agent can read your tokens, pick up what you ask for from the panel, and
send colours back for you to preview.

Run it from the project root. With Claude Code:

```bash
claude mcp add swatch -- npx swatch-token mcp
```

For any other MCP client:

```json
{ "mcpServers": { "swatch": { "command": "npx", "args": ["swatch-token", "mcp"] } } }
```

Then turn the panel's agent buttons on:

```ts
swatch({ agent: true })
```

- **Save & send to agent** saves your edits and asks the agent to commit
  them, listing each token with its old and new value.
- **Figma sync** asks the agent to pull the colour variables from a Figma
  file (the agent needs its own access to Figma). What it sends back loads
  as unsaved edits, so you see every value on the page before saving.

The agent's tools:

| Tool | What it does |
| --- | --- |
| `swatch_list_tokens` | Every token: light and dark value, stylesheet, number of uses |
| `swatch_pending_requests` | What you asked for from the panel and nobody has handled |
| `swatch_wait_for_request` | Waits (up to 5 minutes) for the next request |
| `swatch_resolve_request` | Marks a request as handled |
| `swatch_propose_edits` | Shows values in the panel as unsaved edits; writes no file |
| `swatch_write_tokens` | Writes values straight into the stylesheets |

`npx swatch-token mcp` finds the stylesheets the same way the plugin does; pass
`--css src/tokens.css` (and `--src src`) if you set those options there.

Requests are kept in `.swatch/` at the project root: add it to
`.gitignore`.

## Frameworks

Swatch injects itself through Vite's `index.html`, which covers plain Vite
apps (React, Vue, Svelte, Solid, vanilla). Where the framework renders the
HTML itself (SvelteKit, Astro, Remix), add the script to your root layout
in development:

```html
<script type="module" src="/__swatch/client.js"></script>
```

The panel runs in a shadow root with its own copy of React, so it works the
same whatever the app is built with.

## Development

```bash
npm install
npm test             # the stylesheet reader and writer, and the MCP server
npm run example      # build, then run the example app with Swatch in it
npm run site         # the website, which runs the real panel on itself
npm run site:build   # the website as static files, in site/dist
```

## Licence

MIT
