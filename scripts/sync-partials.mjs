// Injects partials/header.html and partials/footer.html into every page.
// Pages stay plain, deployable HTML — run this after editing a partial:
//   node scripts/sync-partials.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const partials = {
  header: readFileSync(join(root, "partials/header.html"), "utf8").trim(),
  footer: readFileSync(join(root, "partials/footer.html"), "utf8").trim(),
};
const skip = new Set(["partials", "node_modules", ".git", "scripts", "assets"]);

function pages(dir) {
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
  let html = readFileSync(file, "utf8");
  let changed = false;
  for (const [name, tpl] of Object.entries(partials)) {
    const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!re.test(html)) continue;
    let out = tpl.replaceAll("{{root}}", prefix);
    // Mark the current page in the primary nav
    out = out.replace(/<a class="nav__link" href="([^"]+)">/g, (m, href) => {
      const target = href.replace(/^(\.\.\/)+/, "");
      const section = target.split("/")[0];
      const current = target === rel || (section === "insights" && rel.startsWith("insights/"));
      return current ? `<a class="nav__link" href="${href}" aria-current="page">` : m;
    });
    html = html.replace(re, `$1\n${out}\n$2`);
    changed = true;
  }
  if (changed) { writeFileSync(file, html); console.log("synced", rel); }
}
