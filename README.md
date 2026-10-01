# Sypher Solutions: Website

*Decoding complexity. Revealing solutions.*

This is the marketing site for **Sypher Solutions**, a boutique, principal-led consulting firm (Managing Principal: Michael Furth). It is plain static HTML, CSS and JavaScript, with no framework and no build step. It's fast, accessible and set up for SEO, and it runs on any static host.

## Structure

| Page | Purpose |
| --- | --- |
| `index.html` | Home: hero, firm statement, six practices, the Sypher Method, ways to engage, selected work, principal, audiences, FAQ, CTA |
| `services.html` | Detailed practices: Launch, Grow, Run, Modernize, Fund, Lead (anchor-linked) |
| `approach.html` | The Sypher Method (Unravel → Decode → Uncover → Solve), the boutique standard, engagement models |
| `work.html` | Anonymized case studies and the engagements we're built for |
| `about.html` | Principal's note, expertise, the meaning of the name, values |
| `insights/` | Thought-leadership essays (fractional leadership, AI for small business, grant readiness) |
| `contact.html` | Consultation request form |
| `privacy.html`, `404.html` | Supporting pages |

```
assets/css/styles.css   Design system (brand tokens, type scale, components)
assets/js/main.js       Navigation, scroll reveals, services sub-nav, contact form
assets/img/             Brand imagery cropped from the brand boards + icons
partials/               Shared header and footer
scripts/sync-partials.mjs
sitemap.xml, robots.txt, site.webmanifest, favicon.ico
```

## Brand system

| Token | Hex | Use |
| --- | --- | --- |
| Deep Navy | `#0B2D3B` | Primary, dark sections |
| Rich Teal | `#1E7F7A` | Accents, links, italics |
| Stone | `#EAE6DF` | Alternate section backgrounds |
| Champagne | `#D4B483` | Rules, CTAs, numerals |
| Slate | `#3C4852` | Body text |

The type pairs **Cormorant Garamond**, a high-contrast serif that echoes the SYPHER wordmark, with **Jost**, a geometric sans that is widely tracked for the S O L U T I O N S lockup and labels.

## Editing

- **Header or footer:** edit `partials/header.html` or `partials/footer.html`, then run `node scripts/sync-partials.mjs`. The script writes the partial into every page between the `<!-- header:start -->`/`<!-- header:end -->` markers and highlights the current nav item.
- **Page content:** edit the HTML directly.
- **New page:** copy an existing page, update the `<title>`, description, canonical URL and JSON-LD, then run the sync script and add the page to `sitemap.xml`.

## Contact form

By default the form opens the visitor's email app with a pre-filled message to `michael@sypher.solutions`, so no setup is needed. To receive submissions directly instead, create a form endpoint (for example Formspree) and set it on the form in `contact.html`:

```html
<form class="form" id="contact-form" novalidate data-endpoint="https://formspree.io/f/XXXXXXX">
```

## SEO checklist (implemented)

- A unique title, meta description and canonical URL on every page
- Open Graph and Twitter card tags with a 1200×630 share image
- JSON-LD structured data: `ProfessionalService`, `Person`, `WebSite`, `FAQPage`, `BreadcrumbList`, `Service`, `HowTo`, `Article`, `ProfilePage`
- `sitemap.xml` and `robots.txt`
- Semantic headings, descriptive alt text, skip link, keyboard-accessible navigation, reduced-motion support
- No render-blocking frameworks; images in WebP with explicit dimensions, lazy-loaded below the fold

**After launch:** verify the domain in Google Search Console and submit the sitemap, create or claim a Google Business Profile, and add analytics if you want it (update `privacy.html` to match).

## Deploying

Any static host works (GitHub Pages, Netlify, Cloudflare Pages, Vercel).

- **GitHub Pages:** Settings → Pages → deploy from this branch, root folder. Add a `CNAME` file containing `sypher.solutions` and point DNS at GitHub.
- The canonical URLs, sitemap and structured data assume the domain **https://sypher.solutions/**. If you use a different domain, update them with a find-and-replace.

Preview locally:

```sh
npx http-server . -p 8080
```

## Before going live: please review

1. **Headshot.** The principal portrait currently uses brand ribbon artwork. Add a professional portrait as `assets/img/michael-furth.webp` (4:5 ratio) and update the `<img>` in `index.html` and `about.html`.
2. **High-resolution logo files.** The images were cropped from the brand-board mockups. Replace `assets/img/sypher-mark.webp` (transparent background) and `assets/img/monogram-512.png` with the original exports when you have them.
3. **Case studies.** These are anonymized and based on real engagements. Confirm you're comfortable with the level of detail.
4. **Location line.** It reads "Based in the Southwest. Engaged nationwide." Adjust it if you'd like to name a city.
