// The host element and shadow root Swatch renders into: the app's CSS
// cannot restyle the panel, the panel's cannot leak into the app, and the
// React in here (bundled with it) never meets the app's own.
import { FONT, MONO } from "./colour.ts"
import { setShadow } from "./host.ts"

/** Makes the host (not yet in the page) and returns where to render. */
export function makeHost(): { host: HTMLElement; mountAt: HTMLElement } {
  document.querySelectorAll("#swatch-host").forEach((n) => n.remove())
  document.getElementById("swatch-style")?.remove()
  const host = document.createElement("div")
  host.id = "swatch-host"
  // A modal dialog in the app (Radix, Headless UI, a native <dialog>
  // polyfill) sets pointer-events: none on <body>, closes on any press
  // outside itself, blocks wheel scrolling outside itself and pulls focus
  // back in. The panel is outside every modal, so it opts out: its own
  // pointer events, and its events stop here before the modal's document
  // listeners can see them.
  host.style.pointerEvents = "auto"
  for (const type of ["pointerdown", "mousedown", "touchstart", "wheel", "touchmove", "focusin", "focusout", "keydown"])
    host.addEventListener(type, (e) => e.stopPropagation())
  // and a dialog's focus trap pulls focus back whenever it moves to
  // something outside the dialog; dropping focus first (nothing to pull it
  // back to) lets the panel's own fields take it
  host.addEventListener("pointerdown", () => {
    const a = document.activeElement
    if (a instanceof HTMLElement && a !== host) a.blur()
  }, true)

  const root = host.attachShadow({ mode: "open" })
  setShadow(root)
  // Nothing inherits in from the page (`all: initial`), and the few resets
  // the panel's inline styles count on.
  const style = document.createElement("style")
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input { margin: 0; font: inherit; color: inherit; }
    button { appearance: none; }
    code { font-family: ${MONO}; }
    input::placeholder { color: #6f6f78; }
    :focus-visible { outline: 2px solid #8e80f9; outline-offset: 1px; }
    .swatch { font: 12px/1.4 ${FONT}; color: #ececec; height: 100%; }
  `
  const mountAt = document.createElement("div")
  mountAt.className = "swatch"
  root.append(style, mountAt)
  return { host, mountAt }
}
