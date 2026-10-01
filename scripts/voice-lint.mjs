// Voice check for Sypher copy. Flags the stock phrasing that makes writing
// read as generic (and that AI-detection tools and careful readers key on),
// so the copy stays specific, plain and in the principal's own voice.
//
//   node scripts/voice-lint.mjs              # all pages + data
//   node scripts/voice-lint.mjs about.html   # specific files
//
// Exit code 1 if anything is flagged. See docs/brand-voice.md for the why.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Words and phrases that signal filler. Keep the list honest: each one has a
// plainer, more specific alternative in docs/brand-voice.md.
const BANNED = [
  "seamless", "seamlessly", "elevate", "elevated", "unlock", "unlocking", "empower", "empowering",
  "leverage", "leveraging", "synergy", "synergies", "robust", "cutting-edge", "game-changer", "game changer",
  "world-class", "best-in-class", "state-of-the-art", "next-level", "holistic", "streamline", "streamlined",
  "journey", "delve", "tapestry", "landscape of", "navigate the complexities", "ever-evolving", "ever-changing",
  "in today's", "fast-paced", "at the end of the day", "it's important to note", "it is important to note",
  "harness", "transformative", "revolutionize", "supercharge", "skyrocket", "unparalleled", "meticulous",
  "meticulously", "bespoke solutions", "tailored solutions", "one-stop", "passionate about", "cutting edge",
  "look no further", "dive into", "deep dive", "rest assured", "peace of mind", "take it to the next level",
  "whether you're", "whether you are", "we understand that", "in conclusion", "furthermore", "moreover",
];

const PATTERNS = [
  [/\bnot (?:just|only|merely) [^.;:]{1,60}?,? but\b/gi, "“not just X but Y” construction"],
  [/\bisn[’']t (?:just|only|merely|about)\b/gi, "“isn’t just/about…” construction"],
  [/\bit[’']s not (?:about|just)\b/gi, "“it’s not about…” construction"],
  [/—/g, "em dash (use a full stop, colon or comma)"],
  [/!/g, "exclamation mark"],
  [/\b(?:truly|really|very|incredibly|extremely|highly)\s+\w+/gi, "intensifier"],
];

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:title)[^>]*>([\s\S]*?)<\/title>/gi, " $1 ")
    .replace(/<meta[^>]+content="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&middot;/g, "·")
    .replace(/\s+/g, " ");
}

function files(args) {
  if (args.length) return args.map((a) => join(root, a));
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (["node_modules", ".git", "assets", "scripts", "supabase", "partials", "private", "docs", "portal"].includes(name)) continue;
        walk(p);
      } else if (name.endsWith(".html")) out.push(p);
    }
  };
  walk(root);
  out.push(join(root, "data/problems.json"));
  return out;
}

let total = 0;
for (const file of files(process.argv.slice(2))) {
  const raw = readFileSync(file, "utf8");
  const text = file.endsWith(".json") ? JSON.parse(raw).map((x) => `${x.problem} ${x.solution}`).join(" ") : visibleText(raw);
  const hits = [];
  for (const word of BANNED) {
    const re = new RegExp(`\\b${word.replace(/[-’']/g, "[-’']?").replace(/ /g, "\\s+")}\\b`, "gi");
    for (const m of text.matchAll(re)) hits.push(`“${m[0]}”`);
  }
  for (const [re, label] of PATTERNS) {
    const n = (text.match(re) || []).length;
    if (n) hits.push(`${label} ×${n}`);
  }
  // Structural tell: lists of exactly three ("a, b and c") in high density.
  const words = text.split(/\s+/).length;
  const triads = (text.match(/\b[\w’'-]+(?: [\w’'-]+){0,3}, [\w’'-]+(?: [\w’'-]+){0,3},? (?:and|or) [\w’'-]+/g) || []).length;
  const density = words ? (triads / words) * 1000 : 0;
  const note = density > 6 ? `  (note: ${triads} lists of three, ${density.toFixed(1)} per 1,000 words; aim for under 6)` : "";
  if (hits.length) {
    total += hits.length;
    console.log(`\n${relative(root, file)}\n  ${hits.join("\n  ")}${note ? "\n" + note : ""}`);
  } else if (note) {
    console.log(`\n${relative(root, file)}\n${note}`);
  }
}
console.log(total ? `\n${total} item(s) to look at.` : "Voice check: clean.");
process.exit(total ? 1 : 0);
