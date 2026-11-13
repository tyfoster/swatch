// Puts Swatch on the page under a dev server (the script the plugin injects).
import { createRoot } from "react-dom/client"
import { Playground } from "./panel.tsx"
import { makeHost } from "./shell.ts"

// One panel, however many times this module runs: the last run's root is
// unmounted before mounting again.
const g = globalThis as { __swatch?: ReturnType<typeof createRoot> }
g.__swatch?.unmount()
const { host, mountAt } = makeHost()
document.body.appendChild(host)
g.__swatch = createRoot(mountAt)
g.__swatch.render(<Playground />)
