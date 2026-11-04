// Building blocks for Sypher Solutions documents. Each returns an HTML string that
// document.css styles. A document module default-exports doc({...}); build.mjs prints it.
//
// Text arguments are HTML: write &amp; for "&", and use <strong>, <em> and <a> freely.
// Plain values (numbers, labels) are inserted as given.

const attr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const cls = (...c) => c.filter(Boolean).join(" ");
/** HTML text to a CSS string body: tags dropped, entities decoded, quotes escaped. */
const cssText = (html) => String(html).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** A two-digit chapter number ("01"). */
export const two = (n) => String(n).padStart(2, "0");

/**
 * The whole document.
 * @param {object} d
 * @param {string} d.title           cover title (HTML; use <br> to break)
 * @param {string} d.short           running footer label, e.g. "Juniper &amp; Vine"
 * @param {string} d.docType         top-right of the cover, e.g. "Business feasibility report"
 * @param {string} d.date            e.g. "September 30, 2026"
 * @param {string} d.kicker          teal line above the title
 * @param {string} [d.subtitle]      italic line under the title
 * @param {string} [d.lede]          the cover's one-paragraph bottom line
 * @param {{value:string,label:string}[]} [d.coverStats]  three or four figures in the navy band
 * @param {string} [d.author]        "Michael Furth"
 * @param {string} [d.tagline]
 * @param {boolean} [d.longTitle]    smaller cover title for long names
 * @param {"xlong"} [d.titleSize]    smaller still, for titles that run to three or four lines
 * @param {boolean} [d.contents]     include the contents page (default true)
 * @param {{id:string,num:string,title:string,desc:string}[]} d.toc
 * @param {string[]} d.body          chapters, in order
 * @param {string} [d.disclaimer]    small print on the closing page
 * @param {string} [d.title_meta]    PDF title
 */
export function doc(d) {
  const author = d.author ?? "Michael Furth";
  const stats = d.coverStats ?? [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${attr(d.titleMeta ?? d.title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())}</title>
<link rel="stylesheet" href="document.css">
<style>
@page { @top-right { content: "Prepared by ${cssText(author)}"; } @bottom-center { content: "${cssText(d.short)} · " counter(page); } @bottom-right { content: "Prepared by ${cssText(author)}"; } }
</style>
</head>
<body>
<section class="cover">
  <img class="cover__ribbon" src="img/cover-ribbon.jpg" alt="">
  <img class="cover__logo" src="img/logo-horizontal.webp" alt="Sypher Solutions">
  <div class="cover__type"><b>${d.docType}</b><span>${d.date}</span></div>
  <div class="${cls("cover__main", d.titleSize === "xlong" && "is-xlong")}">
    <p class="cover__kicker">${d.kicker}</p>
    <h1 class="${cls("cover__title", d.titleSize === "xlong" ? "is-xlong" : d.longTitle && "is-long")}">${d.title}</h1>
    ${d.subtitle ? `<p class="cover__subtitle">${d.subtitle}</p>` : ""}
    <hr class="cover__rule">
    ${d.lede ? `<p class="cover__lede">${d.lede}</p>` : ""}
  </div>
  <div class="cover__band">
    <div class="${cls("cover__stats", stats.length === 4 && "is-4")}">
      ${stats.map((s) => `<div class="cover__stat"><b>${s.value}</b><span>${s.label}</span></div>`).join("")}
    </div>
    <div class="cover__by">
      <span class="who">Prepared by <em>${author}</em><small>, Sypher Solutions</small></span>
      <span class="tag">${d.tagline ?? "Strategy / Insight / Innovation / Transformation"}</span>
    </div>
  </div>
</section>

${d.contents === false ? withRunning(d.body[0], running()) : contents(d, running())}
${(d.contents === false ? d.body.slice(1) : d.body).join("\n")}

<section class="closing">
  <img class="closing__logo" src="img/logo-stacked.jpg" alt="Sypher Solutions">
  <hr class="closing__rule">
  <div class="closing__label">Prepared by</div>
  <div class="closing__name">${author}</div>
  <div class="closing__org">Sypher Solutions · El Paso, Texas</div>
  <div class="closing__mail"><a href="mailto:michael@sypher.solutions">michael@sypher.solutions</a></div>
  <div class="closing__tag">${d.tagline ?? "Strategy / Insight / Innovation / Transformation"}</div>
  ${d.disclaimer ? `<p class="closing__disclaimer">${d.disclaimer}</p>` : ""}
</section>
</body>
</html>`;
}

/** Header and footer content. It must sit inside the first page that has them. */
const running = () => `<div class="running-logo"><img src="img/logo-horizontal.webp" alt=""></div>
<div class="running-wordmark"><img src="img/wordmark.webp" alt=""></div>`;
const withRunning = (section, html) => section.replace(/(<section[^>]*>)/, `$1\n${html}`);

function contents(d, runningHtml) {
  return `<section class="contents">
  ${runningHtml}
  <img class="contents__logo" src="img/logo-horizontal.webp" alt="">
  <p class="kicker">${d.short} · ${d.docType}</p>
  <h1>Contents</h1>
  <table class="toc">
    <thead><tr><th></th><th>Chapter</th><th>Page</th></tr></thead>
    <tbody>
      ${d.toc.map((c) => `<tr><td class="n">${c.num}</td><td><a href="#${c.id}"><div class="t">${c.title}</div>${c.desc ? `<div class="d">${c.desc}</div>` : ""}</a></td><td class="p"><a href="#${c.id}"></a></td></tr>`).join("")}
    </tbody>
  </table>
  <img class="contents__ribbon" src="img/ribbon-corner.jpg" alt="">
</section>`;
}

/** A chapter: gold number, teal kicker, title, divider, then the body. */
export function chapter({ id, num, kicker, title, lede, body = "" }) {
  return `<section class="chapter" id="${id}">
  <header class="chapter-head">
    <div class="chapter-head__line"><span class="chapter-head__num">${num}</span><span class="chapter-head__kicker">${kicker}</span></div>
    <h1>${title}</h1>
    <img class="chapter-head__divider" src="img/divider.webp" alt="">
  </header>
  ${lede ? `<p class="lede">${lede}</p>` : ""}
  ${body}
</section>`;
}

/** Teal tracked label for a sub-section ("NINE QUESTIONS, NINE VERDICTS"). */
export const kicker = (text) => `<p class="kicker">${text}</p>`;
export const h2 = (text) => `<h2>${text}</h2>`;
export const h3 = (text) => `<h3>${text}</h3>`;
export const p = (text, className) => `<p${className ? ` class="${className}"` : ""}>${text}</p>`;
export const note = (text) => `<p class="note">${text}</p>`;
export const lede = (text) => `<p class="lede">${text}</p>`;

/** Bulleted list with teal dots. Items are HTML; "<strong>Lead.</strong> rest" reads well. */
export const list = (items, tight = false) => `<ul class="${cls("list", tight && "tight")}">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

/** Numbered questions with gold numerals. */
export const questions = (items) => `<ol class="questions">${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;

/**
 * Stat cards. tone: navy (default), rust, teal, bronze, gold.
 * @param {{value:string,label:string,tone?:string}[]} items
 */
export const stats = (items) => `<div class="${cls("stats", items.length === 3 && "is-3", items.length === 2 && "is-2")}">${items.map((s) => `<div class="${cls("stat", s.tone)}"><b>${s.value}</b><span>${s.label}</span></div>`).join("")}</div>`;

/**
 * A data table.
 * @param {object} t
 * @param {string[]} t.head
 * @param {(string|{v:string,c?:string})[][]} t.rows   a cell can be {v, c} to add a class (r, c, lead, q)
 * @param {string[]} [t.align]   per column: "l" | "r" | "c" | "lead"
 * @param {string[]} [t.widths]  per column CSS widths
 * @param {Record<number,string>} [t.rowClass]  row index -> "total" | "sub" | "flag"
 * @param {string} [t.title]
 * @param {string} [t.sub]
 * @param {string} [t.note]
 * @param {boolean} [t.compact]
 */
export function table(t) {
  const align = t.align ?? [];
  const cellClass = (i, extra) => cls(align[i] === "r" && "r", align[i] === "c" && "c", align[i] === "lead" && "lead", extra);
  const colgroup = t.widths ? `<colgroup>${t.widths.map((w) => `<col style="width:${w}">`).join("")}</colgroup>` : "";
  const head = t.head ? `<thead><tr>${t.head.map((h, i) => `<th class="${cls(align[i] === "r" && "r", align[i] === "c" && "c")}">${h}</th>`).join("")}</tr></thead>` : "";
  const rows = t.rows.map((r, ri) => `<tr class="${t.rowClass?.[ri] ?? ""}">${r.map((cell, i) => {
    const v = typeof cell === "object" && cell !== null ? cell.v : cell;
    const extra = typeof cell === "object" && cell !== null ? cell.c : "";
    return `<td class="${cellClass(i, extra)}">${v ?? ""}</td>`;
  }).join("")}</tr>`).join("");
  return `${t.title ? `<p class="table-title">${t.title}</p>` : ""}${t.sub ? `<p class="table-sub">${t.sub}</p>` : ""}<table class="${cls("data", t.compact && "compact")}">${colgroup}${head}<tbody>${rows}</tbody></table>${t.note ? `<p class="note">${t.note}</p>` : ""}`;
}

/** A verdict badge: kind is "yes" | "no" | "if" | "open" | "muted". */
export const badge = (label, kind = "yes", noteText = "") => `<span class="${cls("badge", kind !== "yes" && kind)}">${label}</span>${noteText ? `<span class="verdict-note">${noteText}</span>` : ""}`;

/** A shaded note with a coloured left rule. tone: teal (default), gold, rust, navy. */
export const callout = (title, body, tone) => `<div class="${cls("callout", tone)}">${title ? `<span class="callout__title">${title}</span>` : ""}${body.startsWith("<") ? body : `<p>${body}</p>`}</div>`;

/** Roman-numeral points (I, II, III) with a bold lead-in. */
export const points = (items) => {
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  return `<div class="points">${items.map((t, i) => `<div class="point"><span class="point__n">${roman[i]}</span><div><p>${t}</p></div></div>`).join("")}</div>`;
};

/**
 * Horizontal bars. Each row: { label, sub?, value (number), display (text), tone? }.
 * max sets the full width; offset (for waterfalls) starts the bar part-way along.
 */
export function bars({ title, sub, rows, max, note: noteText, legend, waterfall = false }) {
  const top = max ?? Math.max(...rows.map((r) => (r.offset ?? 0) + r.value));
  const pct = (n) => `${Math.max(0, Math.min(100, (n / top) * 100)).toFixed(2)}%`;
  return `<div class="${cls("chart", "bars", waterfall && "waterfall")}">
  ${title ? `<p class="chart__title">${title}</p>` : ""}${sub ? `<p class="chart__sub">${sub}</p>` : ""}
  ${legend ? `<div class="legend">${legend.map((l) => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join("")}</div>` : ""}
  ${rows.map((r) => `<div class="${cls("bar", r.total && "is-total")}"><div class="bar__label">${r.label}${r.sub ? `<small>${r.sub}</small>` : ""}</div><div class="bar__track"><div class="${cls("bar__fill", r.tone)}" style="left:${pct(r.offset ?? 0)};width:${pct(r.value)}"></div></div><div class="bar__value">${r.display}</div></div>`).join("")}
  ${noteText ? `<p class="chart__note">${noteText}</p>` : ""}
</div>`;
}

/** An image with a caption. */
export const figure = (src, caption) => `<figure class="figure"><img src="${src}" alt="">${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;

/** A full-page exhibit, rotated to landscape on a portrait page. Put it last in a chapter body. */
export const exhibit = (src, caption) => `<section class="exhibit"><div class="exhibit__frame"><img src="${src}" alt=""></div>${caption ? `<p class="note">${caption}</p>` : ""}</section>`;

/** "continued" marker for a table that runs onto a second page. */
export const continued = () => `<p class="continued">continued</p>`;
