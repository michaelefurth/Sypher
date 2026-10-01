# Sypher Solutions: Asset Checklist

Assets to create or gather to take the site from polished to flagship. Each one lists its priority, a spec, and where it plugs into the site.

**Priority:** ★★★ before launch · ★★ first 30 days · ★ when ready

---

## 1. Brand master files

| ★ | Asset | Spec | Replaces / used in |
|---|---|---|---|
| ★★★ | **3D ribbon "S" mark, transparent** | PNG or WebP, 2000 px tall or larger, transparent background, no drop shadow | `assets/img/sypher-mark.webp` (hero, page watermarks, header icon). The current file is cropped from the mockup board and is soft at large sizes. |
| ★★★ | **Vector logo suite** | SVG + PDF: primary, stacked, horizontal, one-colour navy, reversed (white/champagne) | Header and footer wordmark (currently set in live type), email signature, documents |
| ★★★ | **Monogram / favicon** | SVG favicon + 512×512 PNG + 180×180 Apple touch icon, navy rounded square | `favicon.ico`, `assets/img/monogram-512.png`, `apple-touch-icon.png`, `icon-192.png` |
| ★★ | **Brand guidelines PDF** | The two brand boards as a 6–10 page PDF | Hand to designers, printers and partners |
| ★ | **Wordmark lettering file** | Outlined SVG of SYPHER and S O L U T I O N S at exact tracking | Pixel-perfect lockups in print |

## 2. Photography

| ★ | Asset | Spec | Used in |
|---|---|---|---|
| ★★★ | **Principal portrait, editorial** | 4:5 crop, 2400×3000 px, natural light, navy/stone wardrobe, calm expression, plain or architectural background | `index.html` and `about.html` principal frame (currently ribbon art) → save as `assets/img/michael-furth.webp` |
| ★★ | **Environmental portrait** | 3:2 landscape, 3000 px wide: at a desk, a whiteboard or in conversation | About page, LinkedIn, speaker bios |
| ★★ | **Detail / texture set (8–12 images)** | 3000 px, shallow depth of field: pen on ledger, hands on keyboard, blueprint, pipette or lab glassware, prototype parts, gold thread or ribbon on stone | Practice cards, Insights headers, case studies, social posts |
| ★★ | **R&D context images** | Lab bench, formulation work, device prototypes (your own or licensed stock, with model releases) | Invent practice section and future case study |
| ★ | **Regional imagery** | Southwest landscape or architecture at golden hour | Local landing pages, About |

## 3. Motion and video

| ★ | Asset | Spec | Used in |
|---|---|---|---|
| ★★ | **Hero ribbon loop** | 6–10 s seamless loop of the ribbon S slowly rotating; 1920×1080 and 1080×1350; MP4 (H.264) + WebM; under 3 MB; no audio | Optional upgrade for the hero mark (with a static fallback) |
| ★★ | **"The Missing Piece" reel** | 15–30 s vertical (1080×1920) screen recording or animation of the puzzle snap, ending on "Every puzzle has a solution." | LinkedIn, Instagram, email signature GIF |
| ★ | **Brand film / intro** | 60–90 s: you, on camera, on how you work | About page, LinkedIn featured |
| ★ | **Higher-resolution method textures** | Unravel / Decode / Uncover / Solve at 2400×1100 | `assets/img/method-*.webp` (currently ~330 px crops) |

## 4. Proof and credibility (biggest conversion lift)

| ★ | Asset | Notes |
|---|---|---|
| ★★★ | **Approval to reference each case study** | Confirm the three anonymized case studies are cleared, especially the specialty-finance engagement |
| ★★★ | **2–4 client testimonials** | Name, title and company (or "Owner, construction firm, Texas"), with written permission. A testimonial strip can go under Selected Work. |
| ★★ | **Outcome metrics** | Any you can verify: hours saved, revenue influenced, grant dollars awarded, dollars recovered in forensic reviews. These would replace the definitional figures (8 / 48 / 1 / 30). |
| ★★ | **Credentials list** | Degrees, certifications (PMP, Google, HubSpot, grant-writing), publications, patents or research credits from biomedical work, and memberships. These strengthen the Invent and Recover practices most. |
| ★★ | **Two or three new case studies** | One each for Invent (R&D roadmap), Recover (forensic review or entitlements win) and Modernize (AI/automation), anonymized as needed |
| ★ | **Client or partner logos** | Only with permission, as monochrome SVG |

## 5. Sales collateral (matching the brand boards)

| ★ | Asset | Spec |
|---|---|---|
| ★★★ | **Capability statement** | 1-page PDF: core competencies, differentiators, past performance, NAICS codes, UEI/CAGE (once registered), contact. Essential for government and contractor work. |
| ★★ | **Services brochure** | 8–12 page PDF built on the eight practices and the Sypher Method |
| ★★ | **Solutions Index PDF** | Printable version of the 48 problems and solutions, as a leave-behind |
| ★★ | **Proposal and SOW template** | Branded Word/Google Doc with scope, milestones, fees and terms |
| ★★ | **Pitch deck** | 10–12 slides, using the "From Complexity to Opportunity" cover from the brand board |
| ★ | **Print set** | Business cards, letterhead, notebook and folder (already designed on the brand board; need print-ready files) |

## 6. Digital, SEO and operations

| ★ | Asset / setup | Notes |
|---|---|---|
| ★★★ | **Form endpoint** | Formspree (or similar) URL → `data-endpoint` on the form in `contact.html` |
| ★★★ | **Booking link** | Calendly or Cal.com for "Book a 30-minute consultation" (can replace the contact CTA or sit beside it) |
| ★★★ | **Domain and hosting** | `CNAME` file for `sypher.solutions`, HTTPS, compression (gzip/brotli) and long cache headers for `/assets` |
| ★★★ | **Google Search Console + Bing Webmaster** | Verify the domain, submit `sitemap.xml` |
| ★★★ | **Google Business Profile** | Categories: Business management consultant, Marketing consultant, Grant writing service. Add services, photos and the 48-problem list as Q&A. |
| ★★ | **Privacy-friendly analytics** | Plausible or Fathom (cookie-free); update `privacy.html` |
| ★★ | **LinkedIn assets** | Company banner 1128×191, personal banner 1584×396, featured-section images 1200×627 |
| ★★ | **Per-page share images** | 1200×630 for Services, Solutions, About and each Insight (currently one shared image) |
| ★★ | **Email signature** | Monogram + name, title, phone, booking link |
| ★ | **Local landing pages** | e.g. El Paso, Las Cruces, Phoenix and Tucson consulting pages for local SEO, once you confirm service areas |

## 7. Content pipeline (SEO depth)

Suggested next essays, one or two a month:

1. SBIR/STTR for first-time medical device founders
2. 510(k), De Novo or PMA? A plain-English map *(reviewed with regulatory counsel)*
3. The R&D tax credit: who qualifies *(co-authored with a CPA)*
4. Small-business certifications explained: 8(a), HUBZone, WOSB, DBE, SDVOSB
5. Local SEO for contractors and service businesses
6. The five KPIs every owner-led business should see weekly
7. Feasibility study vs. business plan: which do you need first?
8. A 30-day AI pilot for a ten-person company

## 8. Legal and compliance review

| ★ | Item | Notes |
|---|---|---|
| ★★★ | **Attorney review of scope language** | Especially the forensic bookkeeping, entitlements and regulatory-research disclaimers on `services.html` and in the FAQ |
| ★★ | **Terms of use page** | Short, standard |
| ★★ | **Professional liability / E&O insurance** | Worth having before forensic or R&D engagements |
| ★ | **Trademark search** | For "Sypher Solutions" and the ribbon S mark |
