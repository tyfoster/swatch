// Draws the SWATCH wordmark's squares and writes logo.ts.
//   node site/logo-gen.mjs          writes site/logo.ts
//   node site/logo-gen.mjs --lab    also writes site/logo-lab.html, the variants side by side
//
// Squares are 9px on an 11px pitch, 12 rows. S, T, C and H are upright
// blocks. W and A are drawn from slanted strokes that shift half a pitch
// (5.5px) per row: with that shear every place two strokes meet lands on
// the pitch, so each row is whole squares with even gaps and every
// diagonal edge is a straight line.
import { writeFileSync } from "node:fs"

const PITCH = 11, SIZE = 9, ROWS = 12, SHEAR = PITCH / 2

/** Upright letters, as text: one character per square. */
const block = (lines) => lines.map((line) => {
  const runs = []
  for (let i = 0; i < line.length; i++) if (line[i] === "#") {
    if (i && line[i - 1] === "#") runs.at(-1)[1]++
    else runs.push([i * PITCH, 1])
  }
  return runs
})
const S = block([
  "###########", "###########", "#####.#####", "#####.#####", "#####......", "###########",
  "###########", "......#####", "#####.#####", "#####.#####", "###########", "###########",
])
const T = block(["###########", "###########", ...Array(10).fill("...#####...")])
const C = block([
  "###########", "###########", "#####.#####", "#####.#####", "#####.#####", "#####......",
  "#####......", "#####.#####", "#####.#####", "#####.#####", "###########", "###########",
])
const H = block([...Array(5).fill("#####..#####"), "############", ...Array(6).fill("#####..#####")])

/** A letter from strokes: each gives, per row, the x of its left edge (or
 *  null where it is not drawn). Strokes that touch or overlap in a row
 *  become one run of squares. */
function strokes(list, thick) {
  return Array.from({ length: ROWS }, (_, r) => {
    const spans = list.map((f) => f(r)).filter((x) => x !== null).map((x) => [x, x + thick * PITCH]).sort((a, b) => a[0] - b[0])
    const runs = []
    for (const [a, b] of spans) {
      const last = runs.at(-1)
      if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b)
      else runs.push([a, b])
    }
    return runs.map(([a, b]) => [a, Math.round((b - a) / PITCH)])
  })
}
/** W: two outer strokes leaning in, and a middle peak `peak` rows tall. */
function W(thick, peak) {
  const down = (ROWS - 1) * SHEAR                // how far an outer stroke travels
  const top = ROWS - 1 - peak                    // the row the peak reaches
  const v1 = down, v2 = down + 2 * peak * SHEAR  // the two valleys
  return strokes([
    (r) => r * SHEAR,
    (r) => r >= top ? v1 + (ROWS - 1 - r) * SHEAR : null,
    (r) => r >= top ? v1 + peak * SHEAR + (r - top) * SHEAR : null,
    (r) => v2 + (ROWS - 1 - r) * SHEAR,
  ], thick)
}
/** A: two legs leaning out from a shared top, and a crossbar. */
function A(thick, bar) {
  const lean = (ROWS - 1) * SHEAR
  const rows = strokes([(r) => lean - r * SHEAR, (r) => lean + r * SHEAR], thick)
  rows[bar] = [[lean - bar * SHEAR, thick + bar]]
  return rows
}

const width = (rows) => Math.max(...rows.flat().map(([x, n]) => x + n * PITCH - (PITCH - SIZE)))
/** Sets letters side by side: [letter, gap before it]. */
function word(letters) {
  let x = 0
  const out = Array.from({ length: ROWS }, () => [])
  for (const [rows, gap] of letters) {
    x += gap
    rows.forEach((runs, r) => out[r].push(...runs.map(([rx, n]) => [+(rx + x).toFixed(1), n])))
    x += width(rows)
  }
  return { rows: out, width: x }
}
// The W's last stroke and the A's first lean the same way, so the space
// between them is the same in every row: the gap between the two letters'
// boxes, plus how far each stroke travels (LEAN). Setting the boxes
// KERN - LEAN apart puts KERN of space between the strokes, the same as
// between the C and the H. The A's last row ends where the T's bar begins,
// as in the original drawing.
const KERN = 20, LEAN = (ROWS - 1) * SHEAR
const build = (w, a) => word([[S, 0], [w, 11], [a, KERN - LEAN], [T, 0], [C, 14], [H, KERN]])

const chosen = build(W(4, 5), A(4, 8))
const n = chosen.rows.flat().reduce((k, [, c]) => k + c, 0)
writeFileSync(new URL("./logo.ts", import.meta.url), `// The SWATCH wordmark as squares: for each row (its y), runs of squares as
// [x of the first, how many]. Squares are ${SIZE}px on an ${PITCH}px pitch, in a
// ${chosen.width} by ${ROWS * PITCH - 2} box. ${n} squares in all. Written by logo-gen.mjs: change the
// letters there, not here.
export const WIDTH = ${chosen.width}, HEIGHT = ${ROWS * PITCH - 2}, SIZE = ${SIZE}, PITCH = ${PITCH}
export const ROWS: [number, [number, number][]][] = [
${chosen.rows.map((runs, r) => `  [${r * PITCH}, ${JSON.stringify(runs)}],`).join("\n")}
]
`)
console.log(`logo.ts: ${n} squares, ${chosen.width} wide`)

if (process.argv.includes("--lab")) {
  const svg = ({ rows, width: w }, label) => `<p>${label}</p><svg viewBox="0 0 ${w} ${ROWS * PITCH - 2}" width="${w}">${rows.map((runs, r) =>
    runs.map(([x, c]) => Array.from({ length: c }, (_, i) => `<rect x="${x + i * PITCH}" y="${r * PITCH}" width="9" height="9" rx="1"/>`).join("")).join("")).join("")}</svg>`
  const variants = [
    [build(W(4, 4), A(4, 8)), "1. W peak 4 rows"],
    [build(W(4, 5), A(4, 8)), "2. W peak 5 rows"],
    [build(W(4, 6), A(4, 8)), "3. W peak 6 rows"],
    [build(W(4, 7), A(4, 8)), "4. W peak 7 rows (as it was, with the new kerning)"],
    [build(W(3, 5), A(4, 8)), "5. W strokes 3 wide, peak 5 rows"],
  ]
  writeFileSync(new URL("./logo-lab.html", import.meta.url), `<!doctype html><meta charset="utf-8"><title>logo lab</title>
<style>body{margin:24px;background:#ebecf0;font:13px system-ui}svg{display:block;fill:#4f46e5;margin-bottom:22px}p{margin:0 0 6px}</style>
${variants.map(([v, l]) => svg(v, l)).join("\n")}`)
}
