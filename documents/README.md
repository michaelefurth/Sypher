# Sypher Solutions documents

One design for every client document: feasibility reports, diligence packages, memos and financial reviews. It uses the website's brand:
- Cormorant Garamond headings with Jost text, labels and tables;
- the site's navy, teal, champagne and bronze;
- the copper-and-navy S emblem, with the wordmark set in type as in the site header;
- a faded-emblem cover like the site's page openings, a navy stats band, italic chapter numbers with the site's eyebrow labels, stat cards, verdict badges and the stacked logo on the closing page.

```
documents/
  build.mjs              builds a document module to PDF
  kit/
    document.css         the design system (paged media)
    components.mjs       building blocks: doc, chapter, stats, table, badge, callout, bars...
    fonts/ img/          brand fonts (OFL) and logo artwork
    vendor/              Paged.js (MIT), which lays out the pages
  samples/
    juniper-vine.mjs     the public sample (fictional business)
```

## Build a document

```sh
node documents/build.mjs documents/samples/juniper-vine.mjs assets/docs/sample-feasibility-report.pdf
```

The build needs Playwright with Chromium, which is already set up in Claude Code sessions. Paged.js handles the layout:
- the running header and footer;
- page numbers;
- the contents page's page numbers.

Chromium then prints the PDF. The build deletes its temporary copy afterwards.

## Client documents stay private

A client's document module and its assets go in the git-ignored `private/<client>/documents/` folder. A module there, such as `private/<client>/documents/report.mjs`, imports the kit with:

```js
import { doc, chapter, two, stats, table } from "../../../documents/kit/components.mjs";
```

Only the kit and the fictional sample live in the repository. Never commit a client's PDF or source here.

## Writing a document

A module default-exports `doc({...})`:
- **Cover:** title, kicker, subtitle, a one-sentence verdict as the lede, and three figures for the navy band.
- **Contents:** `toc` (id, number, title, description).
- **Body:** the chapters.
- **Closing page:** the disclaimer.

Inside chapters:

| Component | Use |
| --- | --- |
| `chapter({ id, num, kicker, title, lede, body })` | Starts on a new page with the gold number, the teal kicker and the S divider |
| `stats([{ value, label, tone }])` | Two to four stat cards. Tones: `navy`, `rust`, `teal`, `bronze`, `gold` |
| `table({ head, rows, align, widths, rowClass, note })` | Data tables. Align `r` for figures, `lead` for a bold first column. Row classes: `total`, `sub`, `flag` |
| `badge(label, kind, note)` | Verdicts. Kinds: `yes` (teal), `no` (rust), `if` (bronze), `open`, `muted` |
| `callout(title, body, tone)` | A shaded note. Tones: teal (default), `gold`, `rust`, `navy` |
| `points([...])` | I, II, III points with a bold lead-in |
| `bars({ rows, max, waterfall })` | Horizontal bar and waterfall charts |
| `exhibit(src, caption)` | A full-page drawing, turned to landscape. Put it last in a chapter |
| `kicker`, `h2`, `p`, `list`, `questions`, `note`, `figure` | Text |

House rules:
- Lead with the verdict.
- Every figure on the cover appears again in the body.
- A table that must not break goes inside `<div class="keep">`.
- After building, check that every figure in the source made it into the PDF:

  ```sh
  pdftotext out.pdf - | grep '\$1,180,000'
  ```
