// Checks the Content Security Policy in .htaccess against the site:
//   - every inline <script> (other than JSON-LD data) is allowed by its sha256 hash
//   - the portal's Supabase project is the only outside host the policy allows to connect
// Run after editing an inline script or the Supabase project:   node scripts/check-csp.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csp = (readFileSync(join(root, ".htaccess"), "utf8").match(/Content-Security-Policy "([^"]+)"/) || [])[1];
if (!csp) { console.error("No Content-Security-Policy header found in .htaccess"); process.exit(1); }

const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "private", "brand-src", "partials", "supabase"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".html")) pages.push(p);
  }
};
walk(root);

const problems = [];
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] || "";
    if (/\bsrc=/.test(attrs) || /application\/ld\+json/.test(attrs)) continue;
    const hash = `'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`;
    if (!csp.includes(hash)) problems.push(`${relative(root, page)}: inline script not allowed; add ${hash} to script-src`);
  }
  if (/\son[a-z]+="/i.test(html)) problems.push(`${relative(root, page)}: inline event handler (onclick= etc.) is blocked by the policy`);
}
const config = readFileSync(join(root, "assets/js/portal/config.js"), "utf8");
const url = (config.match(/SUPABASE_URL = "([^"]+)"/) || [])[1];
if (url && !csp.includes(url)) problems.push(`connect-src does not allow ${url} (assets/js/portal/config.js)`);

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`CSP OK: ${pages.length} pages checked.`);
