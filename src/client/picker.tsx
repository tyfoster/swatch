// The token playground's colour picker: a saturation/value square, hue and
// alpha sliders, and the value written as HEX, RGB, HSL or OKLCH. It
// replaces the browser's own picker, which has no alpha and no formats, so
// an rgba() token could not be picked at all.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { FONT, FORMATS, MONO, clamp, formatColor, formatOf, hslToRgb, hsvToRgb, oklchToRgb, parseColor, rgbToHsl, rgbToHsv, rgbToOklch, round, toHex, type Format, type HSV, type RGBA } from "./colour.ts"

// ── Picker ───────────────────────────────────────────────────────────────
const CHECKER: CSSProperties = {
  backgroundImage: "linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%),linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%)",
  backgroundSize: "8px 8px", backgroundPosition: "0 0,4px 4px", backgroundColor: "#ccc",
}
const field: CSSProperties = { width: "100%", minWidth: 0, padding: "4px 5px", background: "#111113", color: "#ececec", border: "1px solid #3a3a40", borderRadius: 5, font: `12px ${MONO}`, textAlign: "center" }

/** A number field that keeps what is being typed while it has focus: the
 *  colour follows each valid keystroke, but the field is not rewritten
 *  from the colour mid-entry ("0." would otherwise snap back to 0). */
function Num({ label, value, max, step, onSet }: { label: string; value: number; max: number; step: number; onSet: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flex: 1, minWidth: 0 }}>
      <input type="number" style={field} value={draft ?? value} min={0} max={max} step={step}
        onChange={(e) => { setDraft(e.target.value); const n = parseFloat(e.target.value); if (!Number.isNaN(n)) onSet(clamp(n, 0, max)) }}
        onBlur={() => setDraft(null)} />
      <span style={{ color: "#8a8a92", fontSize: 10 }}>{label}</span>
    </label>
  )
}

/** Drag inside `el`, reporting the pointer as 0..1 on each axis. */
function useDrag(onMove: (x: number, y: number) => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      onMove(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1))
    }
    el.setPointerCapture(e.pointerId)
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    // a drag the browser takes over (a touch turned scroll) ends like any other
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up) }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }
}

/** `value` is the token's text, which sets the starting format; `resolved`
 *  is that value with its var() aliases replaced for the column's theme,
 *  which sets the starting colour. */
export function Picker({ value, resolved, anchor, onChange, onClose }: {
  value: string; resolved?: string; anchor: DOMRect; onChange: (v: string) => void; onClose: () => void
}) {
  // read once, when the picker opens; after that it holds its own colour
  const [start] = useState(() => parseColor(resolved || value) ?? { r: 0, g: 0, b: 0, a: 1 })
  const [hsv, setHsv] = useState(() => rgbToHsv(start))
  const [alpha, setAlpha] = useState(start.a)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  const [fmt, setFmt] = useState<Format>(() => formatOf(value))
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 })

  const rgba = hsvToRgb(hsv, alpha)
  const emit = (next: HSV, a: number, f: Format = fmt) => { setHsv(next); setAlpha(a); onChange(formatColor(hsvToRgb(next, a), f)) }
  // a grey has no hue: keep the one the square is showing, or the one just typed
  const setRgba = (c: RGBA, hue = hsv.h) => {
    const next = rgbToHsv(c)
    emit(next.s === 0 ? { ...next, h: hue } : next, clamp(c.a, 0, 1))
  }
  // OKLCH's hue is its own scale: the one typed is kept for a grey, which has none
  const [okHue, setOkHue] = useState<number | null>(null)
  // focus comes into the picker, so its fields and sliders are a Tab away
  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [])

  // below the swatch, or above it when there is no room; inside the window
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const top = anchor.bottom + 6 + r.height > innerHeight - 8 ? anchor.top - 6 - r.height : anchor.bottom + 6
    setPos({ left: clamp(anchor.left, 8, innerWidth - r.width - 8), top: clamp(top, 8, innerHeight - r.height - 8) })
  }, [anchor])

  // a press anywhere else closes it; capture, since the panel's host stops
  // its own events before they reach the document
  useEffect(() => {
    // (a press inside the shadow root reaches the window with the host as its target)
    const down = (e: PointerEvent) => { if (!box.current || !e.composedPath().includes(box.current)) close.current() }
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close.current() } }
    addEventListener("pointerdown", down, true)
    addEventListener("keydown", key, true)
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key, true) }
  }, [])

  const sv = useDrag((x, y) => emit({ ...hsv, s: x, v: 1 - y }, alpha))
  const hue = useDrag((x) => emit({ ...hsv, h: x * 360 }, alpha))
  const alp = useDrag((x) => emit(hsv, round(x, 2)))
  const opaque = `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`

  const num = (label: string, v: number, max: number, set: (n: number) => void, step = 1) =>
    <Num key={label} label={label} value={v} max={max} step={step} onSet={set} />
  // arrow keys move a slider: a step at a time, ten with Shift
  const keys = (onStep: (dx: number, dy: number) => void) => (e: React.KeyboardEvent) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]
    if (!d) return
    e.preventDefault()
    const k = e.shiftKey ? 10 : 1
    onStep(d[0] * k, d[1] * k)
  }
  const alphaField = num("A", round(alpha * 100), 100, (n) => emit(hsv, n / 100))

  let fields
  if (fmt === "hex") {
    const shown = hexDraft ?? toHex(rgba)
    fields = <>
      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flex: 3 }}>
        <input style={field} value={shown} spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.trim()
            setHexDraft(v)
            if (/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
              const c = parseColor(v.startsWith("#") ? v : `#${v}`)
              if (c) setRgba(c)
            }
          }}
          onBlur={() => setHexDraft(null)} />
        <span style={{ color: "#8a8a92", fontSize: 10 }}>HEX</span>
      </label>
      {alphaField}
    </>
  } else if (fmt === "rgb") {
    const set = (k: "r" | "g" | "b") => (n: number) => setRgba({ ...rgba, [k]: n })
    fields = <>{num("R", Math.round(rgba.r), 255, set("r"))}{num("G", Math.round(rgba.g), 255, set("g"))}{num("B", Math.round(rgba.b), 255, set("b"))}{alphaField}</>
  } else if (fmt === "hsl") {
    const hsl = rgbToHsl(rgba)
    const { s, l } = hsl
    // a grey reports hue 0; show (and build on) the hue being worked with
    const h = s < 0.05 ? hsv.h : hsl.h
    fields = <>
      {num("H", round(h), 360, (n) => setRgba(hslToRgb(n, s, l, alpha), n))}
      {num("S", round(s), 100, (n) => setRgba(hslToRgb(h, n, l, alpha), h))}
      {num("L", round(l), 100, (n) => setRgba(hslToRgb(h, s, n, alpha)))}
      {alphaField}
    </>
  } else {
    const ok = rgbToOklch(rgba)
    const { l, c } = ok
    const h = c < 0.0005 && okHue !== null ? okHue : ok.h
    fields = <>
      {num("L", round(l * 100, 1), 100, (n) => setRgba({ ...oklchToRgb(n / 100, c, h), a: alpha }), 0.5)}
      {num("C", round(c, 3), 0.4, (n) => setRgba({ ...oklchToRgb(l, n, h), a: alpha }), 0.005)}
      {num("H", round(h), 360, (n) => { setOkHue(n); setRgba({ ...oklchToRgb(l, c, n), a: alpha }) })}
      {alphaField}
    </>
  }

  const eyeDropper = (globalThis as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
  const thumb = (x: number): CSSProperties => ({ position: "absolute", top: "50%", left: `${x * 100}%`, width: 12, height: 12, borderRadius: 99, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,.4)", transform: "translate(-50%,-50%)", pointerEvents: "none" })

  return (
    <div ref={box} tabIndex={-1} data-swatch-picker style={{ outline: "none", position: "fixed", ...pos, zIndex: 2147483002, width: 244, padding: 10, display: "flex", flexDirection: "column", gap: 10, background: "#1c1c1f", color: "#ececec", border: "1px solid #3a3a40", borderRadius: 10, boxShadow: "0 12px 36px rgba(0,0,0,.5)", font: `12px ${FONT}` }}>
      <div onPointerDown={sv} tabIndex={0} role="slider" aria-label="Saturation and brightness" aria-valuetext={`saturation ${round(hsv.s * 100)}%, brightness ${round(hsv.v * 100)}%`}
        onKeyDown={keys((dx, dy) => emit({ ...hsv, s: clamp(hsv.s + dx / 100, 0, 1), v: clamp(hsv.v + dy / 100, 0, 1) }, alpha))} style={{ position: "relative", height: 150, borderRadius: 6, cursor: "crosshair", touchAction: "none", background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}>
        <span style={{ position: "absolute", left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, width: 14, height: 14, borderRadius: 99, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,.5)", transform: "translate(-50%,-50%)", pointerEvents: "none" }} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {eyeDropper && (
          <button title="Pick a colour from the screen" style={{ width: 26, height: 26, flexShrink: 0, background: "#2a2a2e", color: "#ececec", border: "1px solid #3a3a40", borderRadius: 6, cursor: "pointer" }}
            onClick={() => new eyeDropper().open().then((r) => { const c = parseColor(r.sRGBHex); if (c) setRgba({ ...c, a: alpha }) }).catch(() => {})}>⌁</button>
        )}
        <div style={{ ...CHECKER, width: 26, height: 26, flexShrink: 0, borderRadius: 99, overflow: "hidden", border: "1px solid #555" }}>
          <div style={{ width: "100%", height: "100%", background: formatColor(rgba, "rgb") }} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div onPointerDown={hue} tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={round(hsv.h)}
            onKeyDown={keys((dx, dy) => emit({ ...hsv, h: clamp(hsv.h + dx + dy, 0, 360) }, alpha))} style={{ position: "relative", height: 10, borderRadius: 99, cursor: "pointer", touchAction: "none", background: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" }}>
            <span style={{ ...thumb(hsv.h / 360), background: `hsl(${hsv.h} 100% 50%)` }} />
          </div>
          <div onPointerDown={alp} tabIndex={0} role="slider" aria-label="Opacity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={round(alpha * 100)}
            onKeyDown={keys((dx, dy) => emit(hsv, round(clamp(alpha + (dx + dy) / 100, 0, 1), 2)))} style={{ ...CHECKER, position: "relative", height: 10, borderRadius: 99, cursor: "pointer", touchAction: "none" }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: 99, background: `linear-gradient(to right, transparent, ${opaque})` }} />
            <span style={{ ...thumb(alpha), background: opaque }} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 2, padding: 2, background: "#111113", borderRadius: 6 }}>
        {FORMATS.map((f) => (
          <button key={f} onClick={() => { setFmt(f); setHexDraft(null); onChange(formatColor(rgba, f)) }}
            style={{ flex: 1, padding: "3px 0", border: "none", borderRadius: 4, cursor: "pointer", font: `600 10px ${FONT}`, letterSpacing: ".04em", background: f === fmt ? "#3a3a40" : "transparent", color: f === fmt ? "#fff" : "#8a8a92" }}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4 }}>{fields}</div>
    </div>
  )
}
