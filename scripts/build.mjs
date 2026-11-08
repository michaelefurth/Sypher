// Sypher Solutions — static build helper.
// Pages are plain, deployable HTML. This script refreshes the shared regions in place:
//   <!-- header:start --> … <!-- header:end -->                         from partials/header.html
//   <!-- footer:start --> … <!-- footer:end -->                         from partials/footer.html
//   <!-- problems-all:start --> … <!-- problems-all:end -->             full Problem Index (data/problems.json)
//   <!-- problems-featured:start --> … <!-- problems-featured:end -->   featured rows only
// It also stamps every stylesheet and script link with ?v=<content hash>, so a
// deploy reaches visitors at once instead of waiting out their browser cache.
// For pages that load a module script, it also lists every module that script imports (and the
// Supabase client, on portal pages) as preload hints in <!-- preload:start --> … <!-- preload:end -->,
// so the browser fetches them all at once instead of discovering them one import at a time.
// Run after editing a partial or the problem data:   node scripts/build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const partials = { header: read("partials/header.html").trim(), footer: read("partials/footer.html").trim() };
const problems = JSON.parse(read("data/problems.json"));

const PRACTICES = {
  launch: "Launch", grow: "Grow", run: "Run", modernize: "Modernize",
  fund: "Fund", lead: "Lead", invent: "Invent", recover: "Recover",
};

const TAGLINES = {
  launch: "From idea to operating company.", grow: "Be found. Be chosen.",
  run: "Operations that don’t depend on you being in every room.", modernize: "Technology that earns its keep.",
  fund: "Capital and programs, pursued with rigor.", lead: "Senior leadership, at the scale you need.",
  invent: "Biomedical & formulation R&D, from first principles.", recover: "Find what the numbers are hiding.",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pad = (n) => String(n).padStart(2, "0");

function rows(list, prefix, grouped = false) {
  return list.map((p, i) => (grouped && (i === 0 || list[i - 1].practice !== p.practice)
    ? `      <li class="pgroup" data-group="${p.practice}"><h2>${PRACTICES[p.practice]}</h2><p>${esc(TAGLINES[p.practice])}</p></li>\n`
    : "") + `      <li class="prow" data-practice="${p.practice}">
        <details>
          <summary><span class="prow__num">${pad(i + 1)}</span><span class="prow__problem">${esc(p.problem)}</span><span class="prow__tag">${PRACTICES[p.practice]}</span><span class="prow__icon" aria-hidden="true"></span></summary>
          <div class="prow__solution"><p><span class="prow__label">The solution</span>${esc(p.solution)}</p><a class="link-arrow" href="${prefix}services.html#${p.practice}">The ${PRACTICES[p.practice]} practice</a></div>
        </details>
      </li>`).join("\n");
}

function problemIndex(prefix) {
  const count = (k) => problems.filter((p) => p.practice === k).length;
  const filters = [`<button type="button" class="pfilter is-active" data-filter="all" aria-pressed="true">All<span class="pfilter__n">${problems.length}</span></button>`]
    .concat(Object.entries(PRACTICES).map(([k, v]) => `<button type="button" class="pfilter" data-filter="${k}" aria-pressed="false">${v}<span class="pfilter__n">${count(k)}</span></button>`));
  return `<div class="pindex" data-pindex>
    <div class="pindex__controls">
      <label class="pindex__search"><span class="visually-hidden">Search the problem index</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6.5"/><path d="M13.5 13.5 19 19"/></svg>
        <input type="search" placeholder="Describe your problem…" autocomplete="off" data-pindex-search>
      </label>
      <div class="pindex__filters" role="group" aria-label="Filter by practice">
        ${filters.join("\n        ")}
      </div>
    </div>
    <p class="pindex__count" aria-live="polite">Showing <span data-pindex-count>${problems.length}</span> of ${problems.length} problems we solve most often</p>
    <ol class="pindex__list">
${rows(problems, prefix, true)}
    </ol>
    <p class="pindex__empty" hidden>No exact match, but no problem is too big. <a href="${prefix}contact.html">Tell us about yours.</a></p>
  </div>`;
}

function featured(prefix) {
  return `<ol class="pindex__list pindex__list--featured">
${rows(problems.filter((p) => p.featured), prefix)}
    </ol>`;
}

function pages(dir) {
  const skip = new Set(["partials", "node_modules", ".git", "scripts", "assets", "data", "docs", "email", "brand-src", "private", "supabase"]);
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skip.has(name) ? [] : pages(p);
    return name.endsWith(".html") ? [p] : [];
  });
}

const hashes = new Map();
function version(path) {
  if (!hashes.has(path)) hashes.set(path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex").slice(0, 10));
  return hashes.get(path);
}
/** Every module a script imports, directly or not (static `import … from "./x.js"` only), as repo paths. */
function moduleGraph(entry, seen = new Set()) {
  const src = readFileSync(join(root, entry), "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|(?:^|\n)\s*import\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const dep = join(dirname(entry), m[1] || m[2]).split(sep).join("/");
    if (!seen.has(dep)) { seen.add(dep); moduleGraph(dep, seen); }
  }
  return seen;
}
const PRELOAD = /\n?[ \t]*<!-- preload:start -->[\s\S]*?<!-- preload:end -->/;
const ASSET_LINK = /((?:href|src)=")((?:\.\.\/|\/)*assets\/(?:css|js)\/[\w\/.-]+\.(?:css|js))(?:\?v=[a-f0-9]+)?"/g;

for (const file of pages(root)) {
  const rel = relative(root, file).split(sep).join("/");
  const depth = rel.split("/").length - 1;
  // 404.html can be served from any path, so it uses root-absolute links.
  const prefix = rel === "404.html" ? "/" : depth ? "../".repeat(depth) : "";
  const blocks = {
    header: partials.header, footer: partials.footer,
    "problems-all": problemIndex(prefix), "problems-featured": featured(prefix),
  };
  const original = readFileSync(file, "utf8");
  let html = original;
  for (const [name, tpl] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!re.test(html)) continue;
    let out = tpl.replaceAll("{{root}}", prefix);
    // Mark the current page in the primary nav
    out = out.replace(/<a class="nav__link" href="([^"]+)">/g, (m, href) => {
      const target = href.replace(/^(\.\.\/|\/)+/, "");
      const current = target === rel || (target.startsWith("insights/") && rel.startsWith("insights/"));
      return current ? `<a class="nav__link" href="${href}" aria-current="page">` : m;
    });
    html = html.replace(re, () => `<!-- ${name}:start -->\n${out}\n<!-- ${name}:end -->`);
  }
  // Preload hints use the same unversioned URLs the imports resolve to, so take the old block
  // out before stamping versions and put the new one back after.
  html = html.replace(PRELOAD, "");
  html = html.replace(ASSET_LINK, (m, attr, path) => `${attr}${path}?v=${version(path.replace(/^(\.\.\/|\/)+/, ""))}"`);
  const entry = html.match(/<script type="module" src="((?:\.\.\/|\/)*)(assets\/js\/[\w\/.-]+\.js)\?v=[a-f0-9]+"><\/script>/);
  if (entry) {
    const deps = [...moduleGraph(entry[2])].sort();
    const links = deps.map((d) => `  <link rel="modulepreload" href="${entry[1]}${d}">`);
    // The Supabase client (218 KB) only where it is needed as the page opens: the portal and proposal pages.
    if ((rel.startsWith("portal/") || rel.startsWith("for/")) && deps.includes("assets/js/portal/store.js")) links.push(`  <link rel="preload" as="script" href="${entry[1]}assets/vendor/supabase.min.js">`);
    if (links.length) html = html.replace(entry[0], `<!-- preload:start -->\n${links.join("\n")}\n  <!-- preload:end -->\n  ${entry[0]}`);
  }
  if (html !== original) { writeFileSync(file, html); console.log("built", rel); }
}
