# Design review: Hallmark audit, November 2026

Hallmark 2.0.0 (`.claude/skills/hallmark/`, MIT) ran in **audit** mode over the major pages:

- the home page, About, Approach, Services, Solutions, Work and Contact;
- Insights (the index and one article);
- the private proposal page (`/for/`);
- the portal: sign-in, the client room, and the admin overview.

It used its linter and rendered screenshots at 1280, 1440, 1920 and 375 px. The signed-in portal screens were captured with a mocked back end. Every finding was then checked against the screenshots and the CSS by hand.

The linter's raw count was 427 FAIL, 133 REFLEX and 69 WARN. Most of that is not a defect. Hallmark's house rules ban several things the Sypher brand does on purpose, and those rules fire on every page (see "Brand choices" below).

To re-run it:

```
HALLMARK_PUPPETEER=<folder with puppeteer-core> CHROME_PATH=<chromium> \
  node .claude/skills/hallmark/scripts/sloplint.mjs index.html about.html … --genre editorial --render --before
```

Results land in `.hallmark/`, which git ignores.

## The read

- **What the site is for:** owners and founders deciding whether to hand a hard problem to one senior person. The one action is booking the 30-minute conversation.
- **What works and stays:**
  - The compass mark and the navy, champagne and teal palette.
  - The Cormorant and Jost pairing.
  - The calm cream ground.
  - The phone layouts, which are strong. The dark hero on the home page reads better on a phone than on desktop.
  - The portal. The dark room header and the tabbed room look made, not templated.
- **What reads as generated:** the same hero repeats on every inner page:
  - a breadcrumb;
  - a tracked-capitals label with a rule;
  - a two-line head with an italic teal phrase;
  - a paragraph;
  - the faded S mark on the right.

  Seven pages in a row open identically, and each leaves about 200 px of empty cream below the text at 1440 × 900.
- **What was broken:** a handful of real defects, all fixed in this change (below).

## Fixed in this change

| Where | Problem | Fix |
| --- | --- | --- |
| Portal header, phones | The SYPHER wordmark ran under the nav, and "Sign out" broke onto two lines | Under 520 px the header shows the mark alone (the link keeps an accessible name), and the nav items don't wrap |
| Admin overview stats | Cormorant's old-style figures made **1** read as "I" and **0** as "O" | Lining, tabular figures on `.stat b` |
| Portal sign-in, every portal field, Solutions search | Field outlines were 1.75:1 against the page, below the 3:1 that WCAG 1.4.11 asks for | A new `--field-edge` token at 3.6:1 |
| Portal document icon and initials avatar | Teal on pale teal at 4.38:1 | A new `--teal-deep` token, above 4.5:1 |
| Home compass links | Keyboard focus was nearly invisible (the outline was removed) | A teal focus ring |
| Intake chips, intake cards, Solutions filters | `transition: all` (animates layout and causes jank) | Only the properties that change are listed |
| Insights articles | Lines ran about 94 characters at 1440 | Body text capped at 38rem, about 70 characters |
| Proposal page, short states | The dark footer floated mid-screen with blank cream under it on phones | The footer sits at the bottom of the window |

The checks still pass: the CSP check on 21 pages, and the client room regression run under the real CSP.

## Brand choices Hallmark flags (recommend keeping)

These make up most of the FAIL count. They are deliberate parts of the identity, not mistakes. Changing them would be a restyle, and only you should decide that.

- **Labels in tracked capitals** (gate 67, 95 hits): nav links, kickers, buttons and portal labels.
- **Kicker lines above headings** (gate 54, 64 hits). For example, "THE FIRM & THE PRINCIPAL" above "The person you meet does the work."
- **An italic teal phrase inside a roman head** (gates 38i and 38iii, about 36 hits). For example, "Bring us the *puzzle.*"
- **The gold gradient on the SYPHER wordmark** (gates 2b and 40). Logotypes are exempt from text-contrast rules.
- **Colour values written outside the token block** (gate 48, 130 hits). This is code hygiene, not something a visitor sees. It is worth folding into the token block if the stylesheet is ever reworked.

One way to keep the brand but cut repetition is to use the kicker only where it adds information the head doesn't already give. Today "Let's talk" sits above "Bring us the puzzle", and "The practice" above "A senior bench". On those pages the head alone is enough.

## Worth doing next, ranked

1. ~~**Give each inner page its own opening.**~~ **Done (follow-up change):**
   - About opens on the portrait, and the principal's note became a two-column letter.
   - Approach is a dark opening naming the four steps.
   - Services sets head and lede side by side, with the practice strip on the first screen.
   - Solutions is shorter, with the search on the first screen.
   - Work is one wide headline.
   - Contact puts the intake on the first screen.
   - Hallmark's `--kept` check: every link (37/37) and script hook (59/59) is intact.
   - The "Let's talk" label above the Contact head was dropped as redundant.
   - Insights keeps the old opening for now.

   Original note: About could lead with Michael's photograph and the principal's note. Services could lead with the eight-practice strip. Solutions could lead with the search box. Work could lead with a case. That fixes the sameness and the empty band below each hero in one move. It is a layout change, so it needs your go-ahead.
2. **Shorten the home page.** It has 15 sections; Hallmark's guide is 6 to 9. Merging the overlapping practice and solution sections would tighten it. The About page runs about 640 words. Only you should cut words.
3. **Section heads are small next to the heroes.** On Approach and in Insights, h2s render at 30 to 37 px under a 76 px hero head, so the page loses its rhythm after the first screen. Raising section heads to about 48 to 52 px at desktop would fix it.
4. **Progress bars animate `width`.** This affects the intake progress, the portal progress and the puzzle progress. Switching to `transform: scaleX()` is smoother. It needs a two-line change in the scripts that set the width.
5. **The Services list leaves one item alone on its last row** at 1440. Change the column count or the item count.
6. **The portal tabs on phones** scroll sideways and cut "Messages" off with no hint there's more. A soft fade at the right edge would show it.
7. **On 320 px screens** (the smallest phones), "Email me a sign-in link" wraps to two lines. Tighter letter-spacing at that width would fix it.

## Linter findings dismissed after checking

- **"Reveals are hidden without JavaScript":** a `.no-js` rule already shows them.
- **"Nav hidden at rest":** that is the closed phone menu, which is correct.
- **`overflow: hidden` on `body.nav-open`:** a deliberate scroll lock while the phone menu is open.
- **"Two sticky bars":** the site header and the proposal or portal bar are never on the same page.
- **"Sign-in page ends on an email sign-up":** that form is the page's purpose.
- **The wordmark contrast warning:** a logotype.

## Not covered yet

- The questionnaire screen. It needs a live assignment link, so the mock redirected it.
- The admin engagement detail page.
- The 404 and Privacy pages.

These can join the next pass.
