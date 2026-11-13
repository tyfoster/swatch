// The website runs the real panel on itself: tokens.css is the stylesheet
// Swatch edits, held in the page instead of on a disk.
import { mountDemo } from "../src/client/demo.tsx"
import siteCss from "./site.css?raw"
import tokens from "./tokens.css?raw"

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// the file, shown as it stands; lines a save changed are marked
const original = tokens.split("\n")
function showFile(css: string) {
  const pre = $("file-text")
  const lines = css.replace(/\n$/, "").split("\n")
  pre.replaceChildren(...lines.map((line, i) => {
    const span = document.createElement("span")
    span.textContent = line || " "
    if (line !== original[i]) span.className = "changed"
    return span
  }))
  const n = lines.filter((line, i) => line !== original[i]).length
  $("file-note").textContent = n ? `${n} line${n === 1 ? "" : "s"} changed by Swatch` : "as it was written"
  if (n) pre.querySelector(".changed")?.scrollIntoView({ block: "nearest" })
}
showFile(tokens)

mountDemo({
  target: $("swatch-demo"),
  file: "tokens.css",
  css: tokens,
  // where the tokens are used: the page's own styles, and its markup (the painting)
  sources: { "site.css": siteCss, "index.html": document.documentElement.outerHTML },
  groups: [
    ["The page", "^--(canvas|happy-little-cloud|soft-spoken|phthalo-blue|wet-on-wet|happy-accident)"],
    ["The painting", "."],
  ],
  onSave: showFile,
})

// the page's own light/dark switch
const theme = $<HTMLButtonElement>("theme")
const label = () => { theme.textContent = document.documentElement.classList.contains("dark") ? "Light" : "Dark" }
theme.addEventListener("click", () => document.documentElement.classList.toggle("dark"))
new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
label()

// copy the install command
$("copy").addEventListener("click", async () => {
  const copy = $("copy")
  try { await navigator.clipboard.writeText($("cmd").textContent ?? ""); copy.textContent = "Copied" } catch { copy.textContent = "Press ⌘C" }
  setTimeout(() => { copy.textContent = "Copy" }, 1600)
})
