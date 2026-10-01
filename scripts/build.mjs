// Sypher Solutions — static build helper.
// Pages are plain, deployable HTML. This script refreshes the shared regions in place:
//   <!-- header:start --> … <!-- header:end -->                         from partials/header.html
//   <!-- footer:start --> … <!-- footer:end -->                         from partials/footer.html
//   <!-- problems-all:start --> … <!-- problems-all:end -->             full Problem Index (data/problems.json)
//   <!-- problems-featured:start --> … <!-- problems-featured:end -->   featured rows only
// Run after editing a partial or the problem data:   node scripts/build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
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

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pad = (n) => String(n).padStart(2, "0");

function rows(list, prefix) {
  return list.map((p, i) => `      <li class="prow" data-practice="${p.practice}">
        <details>
          <summary><span class="prow__num">${pad(i + 1)}</span><span class="prow__problem">${esc(p.problem)}</span><span class="prow__tag">${PRACTICES[p.practice]}</span><span class="prow__icon" aria-hidden="true"></span></summary>
          <div class="prow__solution"><p><span class="prow__label">The solution</span>${esc(p.solution)}</p><a class="link-arrow" href="${prefix}services.html#${p.practice}">The ${PRACTICES[p.practice]} practice</a></div>
        </details>
      </li>`).join("\n");
}

function problemIndex(prefix) {
  const count = (k) => problems.filter((p) => p.practice === k).length;
  const filters = [`<button type="button" class="pfilter is-active" data-filter="all" aria-pressed="true">All <sup>${problems.length}</sup></button>`]
    .concat(Object.entries(PRACTICES).map(([k, v]) => `<button type="button" class="pfilter" data-filter="${k}" aria-pressed="false">${v} <sup>${count(k)}</sup></button>`));
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
    <p class="pindex__count" aria-live="polite"><span data-pindex-count>${problems.length}</span> problems, every one solvable</p>
    <ol class="pindex__list">
${rows(problems, prefix)}
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
  const skip = new Set(["partials", "node_modules", ".git", "scripts", "assets", "data", "docs"]);
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skip.has(name) ? [] : pages(p);
    return name.endsWith(".html") ? [p] : [];
  });
}

for (const file of pages(root)) {
  const rel = relative(root, file).split(sep).join("/");
  const depth = rel.split("/").length - 1;
  // 404.html can be served from any path, so it uses root-absolute links.
  const prefix = rel === "404.html" ? "/" : depth ? "../".repeat(depth) : "";
  const blocks = {
    header: partials.header, footer: partials.footer,
    "problems-all": problemIndex(prefix), "problems-featured": featured(prefix),
  };
  let html = readFileSync(file, "utf8");
  let changed = false;
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
    changed = true;
  }
  if (changed) { writeFileSync(file, html); console.log("built", rel); }
}
