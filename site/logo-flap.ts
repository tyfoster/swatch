// The wordmark as a split-flap sign, the kind a railway station's
// departure board is made of. Twelve flaps: six spell SWATCH, one stays
// blank, and five show colours (the chart tokens: swatches). When the page
// loads each flap runs through its reel, a card at a time, and stops on
// its own; the letters settle left to right.
//
// A flap is four half-cards. Two lie flat: the top of the card coming, and
// the bottom of the card showing. Two turn: the top of the card showing
// falls forward, then the bottom of the card coming drops into place.

type Face = { text?: string; colour?: number } // a letter, one of the five colours, or blank
const LETTERS: Face[] = [{}, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => (typeof c === "string" ? { text: c } : c))
const COLOURS: Face[] = [1, 2, 3, 4, 5].map((colour) => ({ colour }))
const WORD = "SWATCH"
const FLIP = 110 // ms a card takes to turn

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches
/** When an animation is over, or should have been: a tab in the background
 *  does not advance its animations, and the sign must not stop half-way. */
const ended = (a: Animation, ms: number) => Promise.race([
  a.finished.then(() => {}, () => {}),
  new Promise<void>((r) => setTimeout(r, ms + 200)),
])

function half(className: string) {
  const el = document.createElement("div")
  el.className = `half ${className}`
  el.appendChild(document.createElement("span"))
  return el
}
function show(el: HTMLElement, face: Face) {
  el.firstElementChild!.textContent = face.text ?? ""
  if (face.colour) el.dataset.colour = String(face.colour)
  else delete el.dataset.colour
}

class Flap {
  readonly el = document.createElement("div")
  private readonly top = half("top")
  private readonly bottom = half("bottom")
  private readonly falling = half("top leaf falling")
  private readonly landing = half("bottom leaf landing")
  private at = 0
  private run = 0
  constructor(private readonly reel: Face[], private readonly target: number, extra = false) {
    this.el.className = extra ? "flap extra" : "flap"
    this.el.append(this.top, this.bottom, this.falling, this.landing)
    this.set(0)
  }
  /** Shows a card with no turn. */
  private set(i: number) {
    this.at = i
    for (const part of [this.top, this.bottom, this.falling, this.landing]) show(part, this.reel[i])
  }
  private async flip() {
    const next = (this.at + 1) % this.reel.length
    show(this.top, this.reel[next])
    show(this.landing, this.reel[next])
    await ended(this.falling.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { duration: FLIP / 2, easing: "ease-in", fill: "forwards" }), FLIP / 2)
    await ended(this.landing.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { duration: FLIP / 2, easing: "ease-out", fill: "forwards" }), FLIP / 2)
    this.set(next)
    for (const leaf of [this.falling, this.landing]) for (const a of leaf.getAnimations()) a.cancel()
  }
  /** Runs `turns` cards through and stops on its own, after `wait` ms. */
  async play(turns: number, wait: number) {
    const run = ++this.run
    const n = this.reel.length
    if (still()) return this.set(this.target)
    this.set(((this.target - turns) % n + n) % n)
    await new Promise((r) => setTimeout(r, wait))
    while (this.at !== this.target && run === this.run) await this.flip()
  }
}

export function mountSign(sign: HTMLElement) {
  const flaps: [Flap, number][] = [
    // each letter runs a little longer than the one before, so they settle left to right
    ...[...WORD].map((c, i): [Flap, number] => [new Flap(LETTERS, LETTERS.findIndex((f) => f.text === c)), 9 + i * 2]),
    [new Flap(LETTERS, 0, true), 0],
    ...COLOURS.map((_, i): [Flap, number] => [new Flap(COLOURS, i, true), 12 + i]),
  ]
  sign.replaceChildren(...flaps.map(([f]) => f.el))
  const play = () => flaps.forEach(([f, turns], i) => f.play(turns, 150 + i * 45))
  play()
  // press the sign to run it again
  sign.addEventListener("click", play)
}
