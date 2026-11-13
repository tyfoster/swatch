import { shadow } from "./host.ts"
// Swatch's colour maths: reading any CSS colour the page
// understands, and converting between RGB, HSV, HSL and OKLCH.

export type RGBA = { r: number; g: number; b: number; a: number } // r g b 0..255, a 0..1
export type Format = "hex" | "rgb" | "hsl" | "oklch"
export const FORMATS: Format[] = ["hex", "rgb", "hsl", "oklch"]

export const FONT = "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif"
export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const round = (v: number, d = 0) => { const p = 10 ** d; return Math.round(v * p) / p }

// ── Parsing ──────────────────────────────────────────────────────────────
// Any literal CSS colour the page understands (color-mix() and
// light-dark() included): the browser computes it on a probe, and the
// computed string is read back as numbers. A value that still holds a var()
// is refused: it means something different in each theme, so the caller
// resolves it for the theme it means first.
const NUM = String.raw`(-?[\d.]+(?:e-?\d+)?)(%?)`
function fromComputed(c: string): RGBA | null {
  let m = new RegExp(`^rgba?\\(${NUM}[ ,]+${NUM}[ ,]+${NUM}(?:\\s*[,/]\\s*${NUM})?\\)$`).exec(c)
  if (m) return { r: m[2] ? +m[1] * 2.55 : +m[1], g: m[4] ? +m[3] * 2.55 : +m[3], b: m[6] ? +m[5] * 2.55 : +m[5], a: m[7] === undefined ? 1 : m[8] ? +m[7] / 100 : +m[7] }
  m = new RegExp(`^color\\(srgb ${NUM} ${NUM} ${NUM}(?: / ${NUM})?\\)$`).exec(c)
  if (m) return { r: +m[1] * 255, g: +m[3] * 255, b: +m[5] * 255, a: m[7] === undefined ? 1 : m[8] ? +m[7] / 100 : +m[7] }
  m = new RegExp(`^oklch\\(${NUM} ${NUM} ${NUM}(?: / ${NUM})?\\)$`).exec(c)
  if (m) return { ...oklchToRgb(m[2] ? +m[1] / 100 : +m[1], m[4] ? +m[3] / 100 * 0.4 : +m[3], +m[5]), a: m[7] === undefined ? 1 : m[8] ? +m[7] / 100 : +m[7] }
  m = new RegExp(`^oklab\\(${NUM} ${NUM} ${NUM}(?: / ${NUM})?\\)$`).exec(c)
  if (m) {
    const [L, A, B] = [m[2] ? +m[1] / 100 : +m[1], m[4] ? +m[3] / 100 * 0.4 : +m[3], m[6] ? +m[5] / 100 * 0.4 : +m[5]]
    return { ...oklchToRgb(L, Math.hypot(A, B), Math.atan2(B, A) * 180 / Math.PI), a: m[7] === undefined ? 1 : m[8] ? +m[7] / 100 : +m[7] }
  }
  return null
}

let canvas: CanvasRenderingContext2D | null = null
export function parseColor(value: string, where: Element | ShadowRoot = shadow() ?? document.body): RGBA | null {
  const v = value.trim()
  if (!v || /var\(/.test(v)) return null
  if (!CSS.supports("color", v)) return null // not a colour
  const probe = document.createElement("i")
  probe.style.cssText = `color:${v};position:absolute;visibility:hidden;pointer-events:none`
  where.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const direct = fromComputed(computed)
  if (direct) return direct
  // anything else (lab(), a wide-gamut color()): let a canvas flatten it to
  // sRGB, painted opaque so the channels don't lose precision to
  // premultiplying; the alpha is read from the computed string instead
  const ALPHA = /\s*\/\s*(none|[\d.]+(?:e[+-]?\d+)?)(%?)\s*\)$/i
  const alpha = ALPHA.exec(computed)
  const a = !alpha ? 1 : alpha[1].toLowerCase() === "none" ? 0 : clamp(alpha[2] ? +alpha[1] / 100 : +alpha[1], 0, 1)
  canvas ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true })
  if (!canvas) return null
  // a colour the canvas does not take leaves the fill as it was: told
  // apart from black by setting a marker first
  canvas.fillStyle = "#010203"
  canvas.fillStyle = computed.replace(ALPHA, ")")
  if (canvas.fillStyle === "#010203") return null
  canvas.clearRect(0, 0, 1, 1)
  canvas.fillRect(0, 0, 1, 1)
  const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data
  return { r, g, b, a }
}

export function formatOf(value: string): Format {
  const v = value.trim().toLowerCase()
  if (v.startsWith("rgb")) return "rgb"
  if (v.startsWith("hsl")) return "hsl"
  if (v.startsWith("oklch")) return "oklch"
  return "hex"
}

// ── Conversions ──────────────────────────────────────────────────────────
export type HSV = { h: number; s: number; v: number }
export function rgbToHsv({ r, g, b }: RGBA): HSV {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}
export function hsvToRgb({ h, s, v }: HSV, a: number): RGBA {
  const f = (n: number) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255 }
  return { r: f(5), g: f(3), b: f(1), a }
}
export function rgbToHsl({ r, g, b }: RGBA) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
  const { h } = rgbToHsv({ r: r * 255, g: g * 255, b: b * 255, a: 1 })
  return { h, s: s * 100, l: l * 100 }
}
export function hslToRgb(h: number, s: number, l: number, a: number): RGBA {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12, c = s * Math.min(l, 1 - l)
  const f = (n: number) => (l - c * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255
  return { r: f(0), g: f(8), b: f(4), a }
}
const toLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const fromLinear = (c: number) => clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055, 0, 1) * 255
export function rgbToOklch(c: RGBA) {
  const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.hypot(A, B)
  return { l: L, c: C, h: C < 1e-4 ? 0 : (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 }
}
function oklchToLinear(L: number, C: number, H: number) {
  const A = C * Math.cos(H * Math.PI / 180), B = C * Math.sin(H * Math.PI / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}
const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4)
/** An OKLCH colour in sRGB. One outside sRGB keeps its lightness and hue
 *  and gives up chroma until it fits (CSS Color 4's gamut mapping, by
 *  bisection), rather than clipping each channel, which shifts the hue. */
export function oklchToRgb(L: number, C: number, H: number): Omit<RGBA, "a"> {
  L = clamp(L, 0, 1)
  let rgb = oklchToLinear(L, C, H)
  if (!inGamut(rgb)) {
    let lo = 0, hi = C
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear(L, mid, H))) lo = mid; else hi = mid }
    rgb = oklchToLinear(L, lo, H)
  }
  return { r: fromLinear(rgb[0]), g: fromLinear(rgb[1]), b: fromLinear(rgb[2]) }
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0")
export function toHex(c: RGBA) {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ""}`
}
/** Written the way most stylesheets write colours: legacy comma syntax for
 *  rgb()/hsl() (rgba(0, 0, 0, 0.04)), the slash form only for oklch(). */
export function formatColor(c: RGBA, f: Format): string {
  const a = round(c.a, 3)
  if (f === "hex") return toHex(c)
  if (f === "rgb") {
    const [r, g, b] = [c.r, c.g, c.b].map((n) => Math.round(clamp(n, 0, 255)))
    return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`
  }
  if (f === "hsl") {
    const { h, s, l } = rgbToHsl(c)
    return a < 1 ? `hsla(${round(h)}, ${round(s, 1)}%, ${round(l, 1)}%, ${a})` : `hsl(${round(h)}, ${round(s, 1)}%, ${round(l, 1)}%)`
  }
  const { l, c: ch, h } = rgbToOklch(c)
  return `oklch(${round(l * 100, 2)}% ${round(ch, 4)} ${round(h, 2)}${a < 1 ? ` / ${a}` : ""})`
}
