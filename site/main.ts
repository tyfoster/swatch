// The website runs the real tool on itself: tokens.css is the stylesheet
// Swatch edits, held in the page instead of on a disk.
import { mountDemo } from "../src/client/demo.tsx"
import { HEIGHT, PITCH, ROWS, SIZE, WIDTH } from "./logo.ts"
import siteCss from "./site.css?raw"
import tokens from "./tokens.css?raw"

// ── the logo ──
// One <g> per column of squares; the group carries the animated fill and
// its squares inherit it. Each column starts the shared animation further
// along (a negative delay), so at any moment the five tokens read left to
// right as a gradient, and it flows.
const NS = "http://www.w3.org/2000/svg"
const DURATION = 14 // seconds; matches .logo g in site.css
const SPREAD = 0.8 // of the cycle laid across the logo: --chart-1 at the left edge, --chart-5 at the right
const logo = document.getElementById("logo")!
const columns = new Map<number, SVGGElement>()
for (const [y, runs] of ROWS) for (const [x0, n, pitch = PITCH] of runs) for (let i = 0; i < n; i++) {
  const x = +(x0 + i * pitch).toFixed(2)
  const col = Math.round(x / PITCH)
  let g = columns.get(col)
  if (!g) {
    g = document.createElementNS(NS, "g")
    g.style.animationDelay = `${(-(col * PITCH) / WIDTH * SPREAD * DURATION).toFixed(2)}s`
    columns.set(col, g)
    logo.appendChild(g)
  }
  const rect = document.createElementNS(NS, "rect")
  rect.setAttribute("x", String(x))
  rect.setAttribute("y", String(y))
  rect.setAttribute("width", String(SIZE))
  rect.setAttribute("height", String(SIZE))
  rect.setAttribute("rx", "1")
  g.appendChild(rect)
}
logo.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)

// ── the tool, in the bottom-left corner, as it sits in an app ──
mountDemo({
  file: "tokens.css",
  css: tokens,
  // where the tokens are used: the page's own styles
  sources: { "site.css": siteCss },
  groups: [
    ["Base", "^--(background|foreground|primary|border|ring)$"],
    ["Surfaces", "^--(card|muted|accent)"],
    ["Chart: the logo", "^--chart-"],
  ],
})

// ── copy buttons ──
const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'
const DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
for (const button of document.querySelectorAll<HTMLButtonElement>(".copy")) {
  button.innerHTML = COPY
  button.addEventListener("click", async () => {
    const text = button.parentElement?.querySelector("code")?.textContent ?? ""
    try { await navigator.clipboard.writeText(text) } catch { return }
    button.innerHTML = DONE
    button.dataset.done = ""
    setTimeout(() => { button.innerHTML = COPY; delete button.dataset.done }, 1500)
  })
}
