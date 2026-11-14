// Draws the SWATCH wordmark's squares and writes logo.ts.
//   node site/logo-gen.mjs          writes site/logo.ts
//   node site/logo-gen.mjs --lab    also writes site/logo-lab.html, the variants side by side
//
// Squares are 9px on an 11px pitch, 12 rows. S, T, C and H are upright
// blocks. W and A are drawn from slanted strokes. How far a stroke leans
// from row to row is the `lean` below: where it moves in half pitches,
// every place two strokes meet lands on the pitch, so each row is whole
// squares with even gaps.
import { writeFileSync } from "node:fs"

const PITCH = 11, SIZE = 9, ROWS = 12, LAST = ROWS - 1, HALF = PITCH / 2

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

/** How far a slanted stroke has moved sideways by row r. */
const lean = {
  /** half a pitch every row: the widest letters */
  half: (r) => r * HALF,
  /** half a pitch every second row: steeper, in six small steps */
  step2: (r) => Math.floor(r / 2) * HALF,
  /** a whole pitch every third row: every square on one grid */
  grid3: (r) => Math.floor(r / 3) * PITCH,
  /** a straight line of any slope */
  line: (s) => (r) => r * s,
}

/** A row of a letter from spans [from, to): spans that touch or overlap
 *  become one run. A run is whole squares at the pitch where its width
 *  allows; where it does not (a lean that is not in half pitches), its
 *  squares are spread evenly so both of its edges stay on the strokes'
 *  lines. A run is [x, how many] or [x, how many, its own pitch]. */
function row(spans) {
  const runs = []
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    const last = runs.at(-1)
    if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b)
    else runs.push([a, b])
  }
  return runs.map(([a, b]) => {
    const n = Math.round((b - a) / PITCH)
    const pitch = n > 1 ? (b - a - PITCH) / (n - 1) : PITCH
    return Math.abs(pitch - PITCH) < 0.01 ? [a, n] : [a, n, +pitch.toFixed(3)]
  })
}
/** W: two outer strokes leaning in, and a middle peak `peak` rows tall. */
function W(thick, peak, f = lean.half) {
  const t = thick * PITCH, top = LAST - peak, L = f(LAST)
  const il = (r) => 2 * L - f(r)             // up from the first valley
  const ir = (r) => il(top) + f(r) - f(top)  // down from the peak
  const or = (r) => ir(LAST) + L - f(r)      // up from the second valley
  return Array.from({ length: ROWS }, (_, r) =>
    row([f(r), ...(r >= top ? [il(r), ir(r)] : []), or(r)].map((x) => [x, x + t])))
}
/** A: two legs leaning out from a shared top, and a crossbar on row `bar`. */
function A(thick, bar, f = lean.half) {
  const t = thick * PITCH, L = f(LAST)
  return Array.from({ length: ROWS }, (_, r) =>
    row(r === bar ? [[L - f(r), L + f(r) + t]] : [[L - f(r), L - f(r) + t], [L + f(r), L + f(r) + t]]))
}

const right = (runs) => Math.max(...runs.map(([x, n, p = PITCH]) => x + (n - 1) * p + SIZE))
const left = (runs) => Math.min(...runs.map(([x]) => x))
const width = (rows) => Math.max(...rows.map(right))
/** How far apart to set two letters' boxes so that, in the row where they
 *  come closest, there is `gap` between them. */
const kern = (a, b, gap) => Math.max(...a.map((runs, r) => right(runs) - left(b[r]))) + gap - width(a)
/** Sets letters side by side: [letter, gap before its box], or
 *  [letter, { kern }] to space it by its closest row instead. */
function word(letters) {
  let x = 0, prev = null
  const out = Array.from({ length: ROWS }, () => [])
  for (const [rows, gap] of letters) {
    x += typeof gap === "number" ? gap : kern(prev, rows, gap.kern)
    rows.forEach((runs, r) => out[r].push(...runs.map(([rx, n, p]) => p ? [+(rx + x).toFixed(2), n, p] : [+(rx + x).toFixed(2), n])))
    x += width(rows)
    prev = rows
  }
  return { rows: out, width: +x.toFixed(2) }
}
// S-W and T-C keep the original drawing's spacing. W-A and A-T are set by
// their closest row: KERN between them, the space between the C and the H.
const KERN = 20
const build = (w, a) => word([[S, 0], [w, 11], [a, { kern: KERN }], [T, { kern: KERN }], [C, 14], [H, KERN]])

// Strokes three squares wide, leaning 4px a row: the A comes out exactly as
// wide as the S (its feet land on the pitch), and the W about 1.4 times that.
const LEAN = lean.line(4)
const chosen = build(W(3, 6, LEAN), A(3, 8, LEAN))
const n = chosen.rows.flat().reduce((k, [, c]) => k + c, 0)
writeFileSync(new URL("./logo.ts", import.meta.url), `// The SWATCH wordmark as squares: for each row (its y), runs of squares as
// [x of the first, how many, their pitch where it is not the usual one].
// Squares are ${SIZE}px on an ${PITCH}px pitch, in a ${chosen.width} by ${ROWS * PITCH - 2} box. ${n} squares in
// all. Written by logo-gen.mjs: change the letters there, not here.
export const WIDTH = ${chosen.width}, HEIGHT = ${ROWS * PITCH - 2}, SIZE = ${SIZE}, PITCH = ${PITCH}
export const ROWS: [number, ([number, number] | [number, number, number])[]][] = [
${chosen.rows.map((runs, r) => `  [${r * PITCH}, ${JSON.stringify(runs)}],`).join("\n")}
]
`)
console.log(`logo.ts: ${n} squares, ${chosen.width} wide`)

if (process.argv.includes("--lab")) {
  const svg = ({ rows, width: w }, label) => `<p>${label} (${w} wide)</p><svg viewBox="0 0 ${w} ${ROWS * PITCH - 2}" width="${w * 1.25}">${rows.map((runs, r) =>
    runs.map(([x, c, p = PITCH]) => Array.from({ length: c }, (_, i) => `<rect x="${+(x + i * p).toFixed(2)}" y="${r * PITCH}" width="9" height="9" rx="1"/>`).join("")).join("")).join("")}</svg>`
  const third = lean.line(PITCH / 3), twoFifths = lean.line(PITCH * 0.4)
  const variants = [
    [build(W(3, 4), A(3, 8)), "A. half a pitch per row, strokes 3 wide, W peak 4 rows"],
    [build(W(3, 6, twoFifths), A(3, 8, twoFifths)), "B. a straight lean of 0.4 pitch per row, strokes 3 wide, W peak 6"],
    [build(W(3, 6, third), A(3, 8, third)), "C. a straight lean of a third of a pitch per row, strokes 3 wide, W peak 6"],
    [build(W(3, 7, third), A(3, 8, third)), "D. as C, W peak 7"],
  ]
  writeFileSync(new URL("./logo-lab.html", import.meta.url), `<!doctype html><meta charset="utf-8"><title>logo lab</title>
<style>body{margin:24px;background:#ebecf0;font:13px system-ui}svg{display:block;fill:#4f46e5;margin-bottom:20px}p{margin:0 0 6px}</style>
${variants.map(([v, l]) => svg(v, l)).join("\n")}`)
}
