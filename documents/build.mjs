#!/usr/bin/env node
// Builds a Sypher Solutions document to PDF.
//
//   node documents/build.mjs <document.mjs> <out.pdf> [--html <out.html>]
//
// <document.mjs> default-exports the HTML string from kit/components.mjs doc({...}).
// Client documents live in the git-ignored private/ folder; only the kit and the public
// sample live here. The page is laid out by Paged.js (running headers, page numbers, the
// contents page) and printed by Chromium. The temporary copy is deleted afterwards.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [src, out, ...rest] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: node documents/build.mjs <document.mjs> <out.pdf> [--html <out.html>]");
  process.exit(2);
}
const htmlOut = rest[0] === "--html" ? rest[1] : null;

const kitDir = fileURLToPath(new URL("./kit/", import.meta.url));
const html = (await import(pathToFileURL(resolve(src)).href)).default;
if (typeof html !== "string") throw new Error(`${src} must default-export the document HTML`);

const FACES = [
  '500 20px "Cormorant Garamond"', '600 20px "Cormorant Garamond"', '700 20px "Cormorant Garamond"', 'italic 500 20px "Cormorant Garamond"',
  '400 12px "Source Serif 4"', '650 12px "Source Serif 4"', 'italic 400 12px "Source Serif 4"',
  '400 12px "Source Sans 3"', '700 12px "Source Sans 3"', 'italic 400 12px "Source Sans 3"',
];

// Paged.js fetches linked stylesheets, which Chromium refuses for local files, so the
// kit's stylesheet is inlined.
// Paged.js re-inserts the CSS itself, so asset URLs in it are made absolute.
const css = readFileSync(join(kitDir, "document.css"), "utf8").replace(/url\((fonts|img)\//g, `url(${pathToFileURL(kitDir).href}$1/`);
const page = html
  .replace('<link rel="stylesheet" href="document.css">', () => `<style>\n${css}\n</style>`)
  .replace("<head>", `<head>\n<base href="${pathToFileURL(kitDir).href}">\n<script>window.PagedConfig = { auto: false };</script>\n<script src="vendor/paged.polyfill.min.js"></script>`);

const dir = mkdtempSync(join(tmpdir(), "sypher-doc-"));
try {
  const file = join(dir, "document.html");
  writeFileSync(file, page);
  if (htmlOut) writeFileSync(htmlOut, page);

  const browser = await chromium.launch();
  const tab = await browser.newPage();
  const problems = [];
  tab.on("pageerror", (e) => problems.push(e.message));
  tab.on("requestfailed", (r) => problems.push(`missing: ${r.url()}`));
  await tab.goto(pathToFileURL(file).href, { waitUntil: "load" });
  const pages = await tab.evaluate(async (faces) => {
    await Promise.all(faces.map((f) => document.fonts.load(f)));
    await document.fonts.ready;
    const flow = await window.PagedPolyfill.preview();
    return flow.total;
  }, FACES);
  await tab.pdf({ path: resolve(out), preferCSSPageSize: true, printBackground: true });
  await browser.close();
  if (problems.length) console.warn(problems.join("\n"));
  console.log(`${out}: ${pages} pages`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
