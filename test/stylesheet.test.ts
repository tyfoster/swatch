/**
 * The stylesheet reader and writer, which rewrite a project's own CSS when
 * a colour token is saved. Held to the example's stylesheet (it must come
 * back byte for byte, and one edit must change one line) and to each shape
 * of CSS the writer has to leave alone or handle: at-rules, comments,
 * missing semicolons, !important, duplicate declarations, Tailwind's
 * @theme, several stylesheets, and values that would break a file.
 *
 * Node runs this file directly: `node --test test/`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Project } from "../src/server/project.ts"
import { readSheet, write } from "../src/server/files.ts"
import { parse } from "../src/server/stylesheet.ts"

const EXAMPLE = join(import.meta.dirname, "../example")
const CSS = join(EXAMPLE, "src/style.css")
// each check is worked out as the file loads, and reported as a test of its own
const ok = (cond: boolean, msg: string) => test(msg, () => assert.ok(cond))
const dir = mkdtempSync(join(tmpdir(), "swatch-"))

// 1. the example's stylesheet comes back byte for byte, and one edit changes one line
const text = readFileSync(CSS, "utf8")
ok(parse(text, CSS).root.toString() === text, "the example stylesheet round-trips byte for byte")
const copy = join(dir, "style.css")
copyFileSync(CSS, copy)
write(copy, [{ theme: "light", name: "--card", value: "#eeeeee" }])
const a = text.split("\n"), b = readFileSync(copy, "utf8").split("\n")
const changed = a.map((l, i) => l === b[i] ? null : i + 1).filter(Boolean)
ok(a.length === b.length && changed.length === 1, "one edit changes one line")
ok(b[changed[0]! - 1] === "  --card: #eeeeee; /* a raised surface */", "…keeping its indent and trailing comment")

// 2. the project finds the stylesheet by itself, and counts uses across the project
const found = new Project(EXAMPLE).read()
ok(found.files.length === 1 && found.files[0] === join("src", "style.css"), "the stylesheet is found without being named")
const byName = new Map(found.tokens.map((t) => [t.name, t]))
ok(byName.get("--card")?.light === "#f4f4f6" && byName.get("--card")?.dark === "#1d1d22", "light and dark values are read")
ok(byName.get("--card-foreground")?.dark === undefined, "a token with no dark value has none")
ok(found.dark?.selector === ".dark", "the dark selector is reported")
ok((byName.get("--card")?.uses.reduce((k, u) => k + u.n, 0) ?? 0) >= 1, "uses are counted")

// 4. the shapes a stylesheet can take
const run = (css: string, edits: Parameters<typeof write>[1]) => { const f = join(dir, "case.css"); writeFileSync(f, css); write(f, edits); return readFileSync(f, "utf8") }
// read() counts uses under a source folder; an empty one for the cases that are only about the stylesheet
const empty = join(dir, "empty"); mkdirSync(empty)
const getT = (css: string) => { const f = join(dir, "read.css"); writeFileSync(f, css); return readSheet(f).tokens }

ok(run(":root { --a: red; --b: blue; }\n", [{ theme: "light", name: "--a", value: "" }]) === ":root { --b: blue; }\n", "two on one line: deleting --a keeps --b")
ok(getT(":root { --a: red; --b: blue; }").get("--b")?.light === "blue", "two on one line: --b is listed")
ok(run(':root {\n  --a: url("a;b");\n}\n', [{ theme: "light", name: "--a", value: "red" }]) === ":root {\n  --a: red;\n}\n", "url with a semicolon is replaced whole")
ok(run(":root {\n  --a: red !important;\n}\n", [{ theme: "light", name: "--a", value: "blue" }]) === ":root {\n  --a: blue;\n}\n", "an edit without !important drops it (the value says so)")
ok(getT(":root {\n  --a: red !important;\n}").get("--a")?.light === "red !important", "!important is read as part of the value, so editing keeps it unless removed")
ok(run(":root {\n  --a: red !important;\n}\n", [{ theme: "light", name: "--a", value: "blue !important" }]) === ":root {\n  --a: blue !important;\n}\n", "…and written back")
ok(run(":root {\n  --a: red\n}\n", [{ theme: "light", name: "--b", value: "blue" }]) === ":root {\n  --a: red;\n  --b: blue;\n}\n", "insert after a last line with no semicolon keeps both")
ok(getT(":root {\n  --a: red\n}").get("--a")?.light === "red", "a last declaration with no semicolon is listed")
ok(!getT(":root {\n  /* --ghost: red; */\n  --a: red;\n}").has("--ghost"), "a declaration inside a comment is not read")
ok(getT(":root {\n  /* { braces } */\n  --a: red;\n}").get("--a")?.light === "red", "braces in a comment don't hide the block")
ok(getT(":root { --a: red; }\n@media (prefers-color-scheme: dark) { :root { --a: white; } }").get("--a")?.dark === "white", "@media (prefers-color-scheme: dark) :root is the dark theme")
ok(run(":root { --a: red; }\n@media (prefers-color-scheme: dark) { :root { --a: white; } }\n", [{ theme: "dark", name: "--a", value: "black" }]).includes(":root { --a: black; }"), "…and dark edits land there")
ok(getT('[data-theme="dark"] { --a: white; }').get("--a")?.dark === "white", '[data-theme="dark"] is the dark theme')
ok(getT("@layer base { :root { --a: red; } }").get("--a")?.light === "red", ":root inside @layer is the light theme")
ok(getT(":root { --a: red; --a: blue; }").get("--a")?.light === "blue", "duplicate declarations: the last one is read (as the cascade does)")
ok(run(":root { --a: red; --a: blue; }\n", [{ theme: "light", name: "--a", value: "green" }]) === ":root { --a: red; --a: green; }\n", "…and the last one is written")
let threw = false
try { run(":root { --a: red; }\n", [{ theme: "x" as "light", name: "--a", value: "blue" }]) } catch { threw = true }
ok(threw, 'theme "x" is refused')
const before = ":root { --a: red; }\n"
try { run(before, [{ theme: "light", name: "--a", value: "blue" }, { theme: "light", name: "bad", value: "x" }]) } catch { /* expected */ }
ok(readFileSync(join(dir, "case.css"), "utf8") === before, "a batch with one bad edit writes nothing")
ok(run(":root { --a: red; }\n", [{ theme: "dark", name: "--a", value: "white" }]).endsWith(".dark { --a: white; }\n"), "no dark rule yet: one is added")

// writes that must be refused, and what a removal or an edit leaves behind
const refused = (v: string) => { try { run(":root {\n  --a: red;\n  --b: 2;\n}\n", [{ theme: "light", name: "--a", value: v }]); return false } catch { return readFileSync(join(dir, "case.css"), "utf8") === ":root {\n  --a: red;\n  --b: 2;\n}\n" } }
for (const v of ["red /* oops", '"oops', "url(", "red\\", "a\nb", "red /* c */"]) ok(refused(v), "refused, file untouched: " + JSON.stringify(v))
let coerced = false; try { run(":root { --a: red; }\n", [{ theme: "light", name: ["--a"] as unknown as string, value: "blue" }]) } catch { coerced = true }
ok(coerced, "a non-string name is refused")
ok(run(":root {\n  --z: 0; /* keep z */\n  --a: red; /* about a */\n  --b: 2;\n}\n", [{ theme: "light", name: "--a", value: "" }]) === ":root {\n  --z: 0; /* keep z */\n  --b: 2;\n}\n", "removing a declaration takes its same-line comment, not its neighbour's")
ok(run(":root {\n  --a: 1;\n  --b: 2\n}\n", [{ theme: "light", name: "--b", value: "" }]) === ":root {\n  --a: 1;\n}\n", "removing a last declaration with no semicolon keeps the brace on its line")
ok(run(":root {\n  --a: 1 /* keep */;\n}\n", [{ theme: "light", name: "--a", value: "9" }]) === ":root {\n  --a: 9 /* keep */;\n}\n", "a comment inside a value survives an edit")
const both = ":root { --a: 1; }\n.dark { --a: 2; }\n@media (prefers-color-scheme: dark) { :root { --a: 3; } }\n"
ok(run(both, [{ theme: "dark", name: "--a", value: "9" }]) === ":root { --a: 1; }\n.dark { --a: 9; }\n@media (prefers-color-scheme: dark) { :root { --a: 9; } }\n", "dark under a class and a media query: an edit reaches both")
ok(run(both, [{ theme: "dark", name: "--n", value: "5" }]) === ":root { --a: 1; }\n.dark { --a: 2; --n: 5; }\n@media (prefers-color-scheme: dark) { :root { --a: 3; --n: 5; } }\n", "…and a new token goes into both")
ok(getT("@media not (prefers-color-scheme: dark) { :root { --a: 1; } }").get("--a") === undefined, "@media not (…dark) is not the dark theme")
ok(getT("@media (prefers-color-scheme: dark) and (min-width: 600px) { :root { --a: 1; } }").get("--a") === undefined, "a combined media query is not the dark theme")
const usesOf = (text: string, css = ":root { --radius: 1px; --card: red; --shadow: red; }") => {
  const d2 = join(dir, "u" + Math.random().toString(36).slice(2))
  mkdirSync(d2)
  writeFileSync(join(d2, "x.tsx"), text)
  writeFileSync(join(d2, "u.css"), css)
  return new Map(new Project(d2).read().tokens.map((t) => [t.name, t.uses.reduce((k, u) => k + u.n, 0)]))
}
ok(usesOf('const s = "border-radius: 4px; text-shadow: none"').get("--radius") === 0, "border-radius: is a CSS property, not a use of --radius")
ok(usesOf('const s = "border-radius: 4px; text-shadow: none"').get("--shadow") === 0, "text-shadow: is not a use of --shadow")
ok(usesOf('<a className="bg-(--card) hover:text-[--card] bg-card" />').get("--card") === 3, "bg-(--card) and text-[--card] count")

// Tailwind's @theme block declares tokens; `@theme inline` only maps names
ok(getT("@theme { --color-brand: #5b4bdb; }").get("--color-brand")?.light === "#5b4bdb", "@theme declares light tokens")
ok(getT("@theme inline { --color-card: var(--card); }").get("--color-card") === undefined, "@theme inline is a mapping, not a declaration")
ok(run("@theme {\n  --color-brand: #5b4bdb;\n}\n", [{ theme: "light", name: "--color-brand", value: "#000" }]) === "@theme {\n  --color-brand: #000;\n}\n", "…and an edit lands in the @theme block")
ok(usesOf('<a className="bg-brand text-brand/60" />', "@theme { --color-brand: #5b4bdb; }").get("--color-brand") === 2, "bg-brand is a use of --color-brand")

// several stylesheets: each edit goes to the file that holds the token
{
  const d3 = join(dir, "multi"); mkdirSync(d3)
  writeFileSync(join(d3, "a.css"), ":root { --a: red; --b: blue; --c: green; }\n.dark { --a: white; }\n")
  writeFileSync(join(d3, "b.css"), ":root { --z: black; }\n")
  const project = new Project(d3)
  project.write([{ theme: "light", name: "--z", value: "grey" }, { theme: "dark", name: "--b", value: "navy" }, { theme: "light", name: "--new", value: "pink" }])
  ok(readFileSync(join(d3, "b.css"), "utf8") === ":root { --z: grey; }\n", "an edit goes to the file that holds the token")
  ok(readFileSync(join(d3, "a.css"), "utf8") === ":root { --a: red; --b: blue; --c: green; --new: pink; }\n.dark { --a: white; --b: navy; }\n", "a dark value for a light-only token, and a new token, go to the right file")
  let refused = false
  try { project.write([{ theme: "light", name: "--z", value: "white" }, { theme: "light", name: "--a", value: "url(" }]) } catch { refused = true }
  ok(refused && readFileSync(join(d3, "b.css"), "utf8") === ":root { --z: grey; }\n", "one bad edit in a batch leaves every file untouched")
}

// stylesheets that select dark differently: the project's is the one most
// dark values sit under, and a token under another says so
{
  const d4 = join(dir, "mixed"); mkdirSync(d4)
  writeFileSync(join(d4, "a.css"), "@media (prefers-color-scheme: dark) { :root { --warn: orange; } }\n:root { --warn: brown; }\n")
  writeFileSync(join(d4, "b.css"), ':root { --bg: white; --fg: black; }\n[data-theme="dark"] { --bg: black; --fg: white; }\n')
  const sheet = new Project(d4).read()
  const tok = new Map(sheet.tokens.map((t) => [t.name, t]))
  ok(sheet.dark?.selector === '[data-theme="dark"]' && sheet.dark.media === null, "the project's dark selector is the one most dark values use")
  ok(tok.get("--warn")?.darkAt?.media === "(prefers-color-scheme: dark)", "a token whose stylesheet selects dark another way carries that")
  ok(tok.get("--bg")?.darkAt === undefined, "…and the rest carry nothing")
}

