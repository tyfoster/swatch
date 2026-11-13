// The shadow root Swatch lives in. Kept in a module of its own so the
// panel and the colour maths can reach it without importing the mount.
let root: ShadowRoot | null = null
export const shadow = () => root
export const setShadow = (r: ShadowRoot) => { root = r }
