// The wordmark as a split-flap sign, the kind a railway station's
// departure board is made of. Twelve flaps: six spell SWATCH, one stays
// blank, and five show colours (the chart tokens: swatches). When the page
// loads each flap runs through its reel, a card at a time, and stops on
// its own; the letters settle in a different order every time. On a small screen only the
// six letters show, each on a colour of its own: the five chart tokens,
// then black.
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
  /** `shuffled`: the cards come up in a new random order every run (the
   *  colours), still ending on the target; otherwise in the reel's order
   *  (the letters, A to Z). */
  /** the cards a shuffled flap draws from (its reel is rebuilt each run) */
  private readonly cards: Face[]
  constructor(private reel: Face[], private target: number, extra = false, private readonly shuffled = false) {
    this.cards = reel
    this.el.className = extra ? "flap extra" : "flap"
    this.el.append(this.top, this.bottom, this.falling, this.landing)
    this.set(0)
  }
  /** Shows a card with no turn. */
  private set(i: number) {
    this.at = i
    for (const part of [this.top, this.bottom, this.falling, this.landing]) show(part, this.reel[i])
  }
  /** Turns one card. `run` is the run it belongs to: if the sign has been
   *  started again meanwhile, the turn stops where it is and leaves the
   *  flap to the new run. */
  private async flip(run: number) {
    const next = (this.at + 1) % this.reel.length
    show(this.top, this.reel[next])
    show(this.landing, this.reel[next])
    await ended(this.falling.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { duration: FLIP / 2, easing: "ease-in", fill: "forwards" }), FLIP / 2)
    if (run !== this.run) return
    await ended(this.landing.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { duration: FLIP / 2, easing: "ease-out", fill: "forwards" }), FLIP / 2)
    if (run !== this.run) return
    this.set(next)
    for (const leaf of [this.falling, this.landing]) for (const a of leaf.getAnimations()) a.cancel()
  }
  /** Runs `turns` cards through and stops on its own, after `wait` ms. */
  async play(turns: number, wait: number) {
    const run = ++this.run
    const n = this.reel.length
    // a run still turning a card is told to stop (it checks `run`), and its leaves are put down
    for (const leaf of [this.falling, this.landing]) for (const a of leaf.getAnimations()) a.cancel()
    if (still()) return this.set(this.target)
    if (this.shuffled) {
      // a fresh path through the cards for this run: random, never the same
      // card twice running, and ending on the target
      const path: Face[] = [this.reel[this.target]]
      for (let k = 0; k < turns; k++) {
        const others = this.cards.filter((c) => c !== path[0])
        path.unshift(others[Math.floor(Math.random() * others.length)])
      }
      this.reel = path
      this.target = turns
      return this.go(run, turns, wait, 0)
    }
    return this.go(run, turns, wait, ((this.target - turns) % n + n) % n)
  }
  private async go(run: number, turns: number, wait: number, from: number) {
    this.set(from)
    await new Promise((r) => setTimeout(r, wait))
    if (run !== this.run) return
    // every card dealt is turned, even round the reel more than once (five
    // colours, eighteen turns): it starts that many cards before its own
    for (let k = 0; k < turns && run === this.run; k++) await this.flip(run)
  }
}

/** How many cards a letter turns, by the place it was dealt: the first to
 *  stop turns 9, each after it two more. */
const letterTurns = (place: number) => 9 + place * 2
const LONGEST = letterTurns(WORD.length - 1)

export function mountSign(sign: HTMLElement) {
  const flaps: [Flap, number][] = [
    ...[...WORD].map((c, i): [Flap, number] => {
      const flap = new Flap(LETTERS, LETTERS.findIndex((f) => f.text === c))
      // numbered, so a small screen (which shows only the letters) can give each its own colour
      flap.el.dataset.letter = String(i + 1)
      return [flap, -1] // how long a letter runs is drawn afresh each time (below)
    }),
    [new Flap(LETTERS, 0, true), 0],
    // the colours settle in order, blue to crimson, the last of them one
    // card before the last letter: they turn as long as the letters do
    ...COLOURS.map((_, i): [Flap, number] => [new Flap(COLOURS, i, true, true), LONGEST - COLOURS.length + i]),
  ]
  sign.replaceChildren(...flaps.map(([f]) => f.el))
  // The six letters start together and stop one after another, in an order
  // shuffled each time the sign runs: each is dealt a different number of
  // cards to turn. The colours start with them, flip through the five in a
  // random order, and settle in theirs.
  const play = () => {
    const order = [...WORD].map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    let letter = 0
    flaps.forEach(([f, turns]) => f.play(turns < 0 ? letterTurns(order[letter++]) : turns, 150))
  }
  play()
  // press the sign to run it again
  sign.addEventListener("click", play)
}
