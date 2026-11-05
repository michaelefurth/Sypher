# Sypher Client Portal: setup and operation

The path from first contact to finished work, in one system:

```
Contact page diagnostic ──► Claude's pre-call brief (private to you) ──► you reply and talk
        │
        ▼
Private proposal page (/for/?p=<name>.<key>) ──► client chooses an option and signs
        │
        ▼
Open the engagement ──► the client's room: milestones, decisions, next meeting, questions, updates
```

Inside an engagement, the portal at `/portal/` is where clients answer your questions, and you review, analyse and publish:

```
Invite client ──► Assign questionnaire ──► Client answers (autosave, files, "don't know yet")
                                                     │ submits (answers lock)
                                                     ▼
                     Claude drafts a report update (private to you) ──► email to Michael
                                                     │ you review, edit, approve
                                                     ▼
                         Update published to the client's portal ──► email to client
```

Nothing written by the AI reaches a client until you publish it.

---

## What's in the repo

| Path | What it is |
| --- | --- |
| `portal/*.html`, `assets/js/portal/`, `assets/css/portal.css` | The portal front end (static, served with the site) |
| `assets/js/portal/config.js` | Supabase URL + anon key for the **Sypher Client Portal** project (`pswzqwmluigojvizvfdc`, us-west-1) |
| `supabase/migrations/20261001000000_client_portal.sql` | Database schema, row level security, storage bucket |
| `supabase/migrations/20261002000000_bespoke_flow.sql` | Inquiries, proposals, milestones, decision log, meeting fields |
| `supabase/migrations/20261103000000_client_room.sql` | Messages, deliverables, client to-dos, the signed agreement in the room, and the timeline |
| `supabase/migrations/20261104000000_team_access.sql` | Team access for outside advisers: members, team thread, team files, task assignees |
| `supabase/migrations/20261105000000_security_hardening.sql` | Two-step sign-in required for admin access, allowed file types, function privileges |
| `supabase/migrations/20261106000000_action_center.sql` | Requests between anyone on an engagement, notifications (the bell), and the schedule of values (pricing sheets with an owner-only budget) |
| `supabase/migrations/20261107000000_project_model.sql` | The project model: cost lines, assumptions with owners and a change log, comments, saved versions, and model access for advisers (never the contractor) |
| `assets/js/portal/model-calc.js`, `assets/js/portal/model.js`, `portal/project.html` | The model's arithmetic (tested by `scripts/test-model.mjs`), its screen, and the full-width page for admin |
| `supabase/migrations/20261109000000_owner_personal.sql` | The owner model's personal section: marital agreements, dependents, accounts, debts, insurance, retirement, estate documents |
| `supabase/migrations/20261108000000_owner_model.sql` | The owner model: entities and their books by period, adjustments, properties and cost segregation components, the findings register, assumptions with owners and a change log, comments, saved versions. Same audience as the project model |
| `assets/js/portal/owner-calc.js`, `assets/js/portal/owner.js`, `portal/owner.html` | The owner model's arithmetic (depreciation, taxes, normalization, global coverage; tested by `scripts/test-owner.mjs`), its screen, and the full-width page for admin |
| `assets/js/portal/sov.js`, `assets/js/portal/bell.js`, `portal/pricing.html` | The pricing grid (autosave, offline queue, live updates), the alerts bell, and the full-width sheet page for admin |
| `supabase/config.toml` | Which functions need a signed-in caller, read by `supabase functions deploy` |
| `scripts/check-csp.mjs` | Checks the site's Content Security Policy (in `.htaccess`) against every page |
| `scripts/deploy-site.sh` | Copies the public website into `public_html`; used by `.cpanel.yml` and the cron auto-deploy |
| `scripts/cpanel-autodeploy.sh` | Cron job on cPanel: deploys new commits on the production branch every few minutes |
| `.github/workflows/deploy-supabase.yml` | On merge: access tests, then new database migrations, then the edge functions |
| `.github/workflows/checks.yml` | Runs the access tests, script checks, the policy check, the build check and a type-check of the functions on every push |
| `contact.html`, `assets/js/diagnostic.js` | The four-step diagnostic that replaces the contact form |
| `for/index.html`, `assets/js/proposal.js`, `assets/css/proposal.css` | The private proposal page clients read and sign |
| `supabase/functions/submit-inquiry` | Public: stores a diagnostic, drafts your pre-call brief with Claude, emails you and the prospect |
| `supabase/functions/proposal-response` | Public: emails you when a proposal is accepted or declined, and confirms to the signer |
| `supabase/functions/invite-client` | Admin-only: invites a client by email and opens their engagement |
| `supabase/functions/process-submission` | On submit: asks Claude for a draft update, emails you |
| `supabase/functions/publish-update` | Admin-only: publishes your approved update, emails the client |
| `supabase/functions/room-notify` | Signed-in users: emails the right people about a new message, document, request, answer, review, pricing submission or team file |
| `supabase/functions/invite-member` | The client or admin: adds an attorney, CPA or other adviser to an engagement's team |
| `supabase/tests/rls-test.mjs` | 244 automated security tests for the access rules |
| `private/` | Git-ignored. Client question sets live here, never in the repo |

---

## Going live (about 30–45 minutes)

### 1. Create the Supabase project
The portal has its own project, **Sypher Client Portal** (ref `pswzqwmluigojvizvfdc`, us-west-1), in the Sypher organization. Keep it separate from the other "Sypher" project: the portal needs sign-ups turned off and defines its own `is_admin()`, which would break an app sharing the database.

1. If you ever need to recreate it: create a project at [supabase.com](https://supabase.com) (the free tier is enough to start), in a US region.
2. **SQL Editor →** paste the whole of `supabase/migrations/20261001000000_client_portal.sql` → **Run**. Then do the same with `20261002000000_bespoke_flow.sql`, then `20261103000000_client_room.sql`, then `20261104000000_team_access.sql`, then `20261105000000_security_hardening.sql`.

### 2. Lock sign-in down to invited clients
1. **Authentication → Sign In / Providers → Email:** enabled. Turn **off** "Allow new users to sign up". Clients join only by your invitation.
2. **Authentication → URL Configuration:** set **Site URL** to `https://sypher.solutions`. Add `https://sypher.solutions/portal/**` to **Redirect URLs**.
3. **Authentication → Emails → SMTP Settings:** turn on custom SMTP. Without it, Supabase's built-in sender only delivers to members of your Supabase team, so clients never receive their sign-in links. With Resend (step 4):
   - **Host** `smtp.resend.com`, **Port** `465`, **Username** `resend`, **Password** your Resend API key
   - **Sender email** `portal@sypher.solutions`, **Sender name** `Sypher Solutions`
4. The sign-in emails themselves (magic link, invitation and the rest) are branded and kept in `supabase/templates/auth-emails.mjs`. The deploy workflow sends them to Supabase, so don't edit them in the dashboard: a later deploy would replace your edits. See **Deploying**.
5. **When a sign-in email doesn't arrive.** The sign-in page answers in one of three ways. For an address with no portal account it says only that a link is on its way if the address has an invitation, so addresses can't be probed. Within a minute of the last email to an address it says one was just sent (Supabase allows one per address per minute, and the dashboard's "Send magic link" counts). When the account exists but the email could not be sent, it says so and points to you. That last case is almost always the mail service: in **Authentication → Logs**, an error such as `550 The sypher.solutions domain is not verified` means the sending domain is not verified in Resend, and no portal email (sign-in, invitation or notification) goes out until it is. Notification emails report the same way: when Resend refuses one (a message, a request, a shared document, an answer or a review), the portal says the email couldn't be sent and that the item is waiting in the portal, instead of saying the person has been emailed. Invitations and published updates do the same.

### 3. Create your admin account
1. **Authentication → Users → Add user → Send invitation** to `michael@sypher.solutions`, then accept it from your inbox.
2. In the **SQL Editor**, run:
   ```sql
   update public.profiles set role = 'admin' where email = 'michael@sypher.solutions';
   ```
3. **Two-step sign-in is required for admin access.** The first time you open `/portal/admin.html`, the portal shows a QR code: scan it with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and enter the 6-digit code. After that it asks for a code once per session. The database and the functions both refuse admin requests from a session without a verified code, so a stolen email link alone opens nothing. Supabase enables authenticator-app (TOTP) sign-in by default; if setup fails, check **Authentication → Sign In / Providers → Multi-Factor**. Lost your phone? Remove the factor under **Authentication → Users → your account**, then sign in again to set up a new one.

### 4. Email (Resend)
1. Create an account at [resend.com](https://resend.com), verify `sypher.solutions` (it gives you DNS records to add), and create an API key.
2. Use that key for both Supabase SMTP (step 2.3) and the functions (step 5).

### 5. Deploy the functions
Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo root:

```sh
supabase login
supabase link --project-ref <your-project-ref>

supabase secrets set \
  ANTHROPIC_API_KEY=<from console.anthropic.com> \
  RESEND_API_KEY=<from resend.com> \
  ADMIN_EMAIL=michael@sypher.solutions \
  SITE_URL=https://sypher.solutions \
  EMAIL_FROM="Sypher Solutions <portal@sypher.solutions>"

supabase functions deploy invite-client
supabase functions deploy process-submission
supabase functions deploy publish-update
supabase functions deploy room-notify
supabase functions deploy invite-member

# These two are called by people who aren't signed in (prospects and proposal readers).
# supabase/config.toml already marks these two as public, so the flag is optional.
supabase functions deploy submit-inquiry --no-verify-jwt
supabase functions deploy proposal-response --no-verify-jwt
```

### 6. Connect the site
`assets/js/portal/config.js` holds the **Project URL** and the **anon key** (Project Settings → API). It's already set for the Sypher Client Portal project; change it only if you move to a new project. The anon key is designed to be public; the database rules protect the data. Never put the service-role key there. Commit and deploy the site.

### 7. First engagement
1. Sign in at `/portal/` → **Questionnaires → Import** → choose the client's question set from `private/` (a JSON file in the format below).
2. **Clients & engagements → Invite a client** (email, name, company, engagement title).
3. Open the engagement and paste the report's key assumptions and conclusions into **Report context for the AI**. This is what Claude compares answers against.
4. **Assign** the questionnaire with a due date and a short note. The client is emailed and sees it on sign-in.

---

## Deploying

Everything deploys from the repository's default branch (the production branch), so a merged pull request goes live on its own. The checks in `.github/workflows/checks.yml` run on every pull request; protect the branch so nothing merges without them (GitHub → Settings → Branches → add a rule for the default branch → require a pull request and the **Checks** status).

**The website (cPanel cron).** `scripts/cpanel-autodeploy.sh` runs every 5 minutes. When GitHub has a commit the server hasn't deployed, it checks it out in cPanel's copy of the repository and copies the site into `public_html` with `scripts/deploy-site.sh`, the same script **Deploy HEAD Commit** runs. A failed copy is retried on the next run, and every deploy is logged in `~/logs/sypher-autodeploy.log`. One-time setup:

1. **cPanel → Git Version Control:** note the repository path (for example `/home/syphsevs/repositories/Sypher`) and make sure its checked-out branch is the production branch.
2. **cPanel → Terminal** (or SSH): run `/bin/bash <repository path>/scripts/cpanel-autodeploy.sh` once, then `tail ~/logs/sypher-autodeploy.log`. You should see "deployed: …". If it says it could not fetch, the server can't reach GitHub with its stored credentials; fix that under Git Version Control first.
3. **cPanel → Advanced → Cron Jobs:** add, every 5 minutes (`*/5 * * * *`):
   ```sh
   /bin/bash /home/syphsevs/repositories/Sypher/scripts/cpanel-autodeploy.sh >/dev/null 2>&1
   ```
   (use your repository path). The script writes its own log, so cron emails are switched off.

To stop auto-deploying, delete the cron job. Manual **Deploy HEAD Commit** keeps working either way.

**Supabase (GitHub Actions).** `.github/workflows/deploy-supabase.yml` runs when a merge changes anything under `supabase/`: it re-runs the access tests, applies new migrations (`supabase db push`, which records each one so it runs once), then deploys every edge function with the sign-in rules in `supabase/config.toml`. The first four migrations were applied by hand before automation; the workflow records them as applied so they are never re-run. One-time setup, in GitHub → Settings → Secrets and variables → Actions → **New repository secret**:

- `SUPABASE_ACCESS_TOKEN`: create one at supabase.com/dashboard/account/tokens.

That is the only secret it needs. The Supabase CLI is pinned to 3.0.0 and reaches the database with the token. A `SUPABASE_DB_PASSWORD` secret left over from earlier setup is unused, and you can delete it.

The job runs in a GitHub environment called `production`. To approve each database change before it applies, add yourself as a required reviewer under GitHub → Settings → Environments → production. You can also run it by hand from the Actions tab (**Deploy Supabase → Run workflow**).

**Sign-in emails.** The workflow's last step sends the branded templates in `supabase/templates/auth-emails.mjs` to Supabase's Management API. It sends only the six email subjects and bodies and the link lifetime (one hour, which the emails promise); no other auth setting is touched. Every email, the portal's notifications included, uses the same brand shell in `supabase/functions/_shared/brand-email.js`. To change wording, edit `auth-emails.mjs` and merge. To look at them first, run `node supabase/templates/auth-emails.mjs preview /tmp/emails` and open the files. Each sign-in email carries a link and a 6-digit code, and the sign-in page accepts the code: some company mail filters open links to scan them, which uses the link up before the client clicks it.

Write new migrations so they can't be half-applied by accident: one change per file, named `YYYYMMDDHHMMSS_what_it_does.sql`, and run the access tests before merging.

## Diagnostic, proposals and client rooms

**The diagnostic** (contact page). A guided conversation, one question per screen: who they are (operating business, starting something, nonprofit, developing a product, something else), then up to three problems worded for that kind of organization (mapped to practices behind the scenes), a short tap-to-choose follow-up and an open question for each, the organization, timing and budget, what they've tried and what good looks like, and finally contact details. Tappable example answers help people start writing, and a "Notes for Michael" panel builds up beside the questions (a collapsible summary on phones). The wording lives in the `PROBLEMS` table at the top of `assets/js/diagnostic.js`. Answers are kept in the visitor's tab until sent, so a refresh loses nothing. On submit, `submit-inquiry` stores it, emails the prospect a short confirmation, asks Claude for a pre-call brief (a summary, their most telling sentence, likely practices, questions to ask, fit concerns, a first step and a proposal outline) and emails you. A hidden field, a minimum fill time and a per-address limit keep bots out.

**Inquiries** (admin). Read the brief and answers, reply with a pre-written email, keep private notes and a status, and **Start a proposal**: it's prefilled from the brief.

**Proposals** (admin). Write the letter, the situation in their words, objectives, phases, milestones, two or three options with fees, terms and next steps. The terms start from a sensible default; match them to your engagement letter. **Mark as sent** makes the link live; **Email the link** opens a message from your own address. You can see when it was opened and how often. Withdrawing a proposal disables its link.

**The proposal page** (`/for/?p=<name>.<key>`). No sign-in: the 40-character key in the link is the lock, and the page asks search engines not to index it. The client chooses an option, types their name as a signature and accepts, or declines with a note. You're emailed either way, and the signer gets a confirmation. A proposal past its "valid until" date can't be accepted. It prints cleanly to PDF.

**Opening the engagement.** On an accepted proposal, **Open the engagement** invites the signer to the portal, creates the engagement, copies the milestones from the proposal and sets the start date.

**The client room** (the client's dashboard). The header carries a **bell** with unread alerts; tabs:

- **Home:** front and center.
  - **Needs your attention:** requests to answer or review, questionnaires, pricing to review, unread messages, each with one button.
  - **Waiting on others:** grouped by person, with what each owes and when.
  - **New since your last visit:** unread alerts for this engagement.
  - Then your latest update, recent activity (with the full timeline one click away), the next conversation, where the plan stands, a pricing summary, the latest message and the team.
- **Requests:** everything anyone on the engagement has asked of anyone else, split into For you, Waiting on others and Done.
- **Pricing:** shown once a pricing sheet exists. See *Pricing* below.
- **Plan:** the milestone track, with the documents each milestone produced, and the decision log.
- **Documents:** the signed agreement (opens the accepted proposal read-only at `/for/?e=<engagement>`), deliverables from you filed by milestone, and files they've shared.
- **Messages:** a private thread with you. Each side is emailed when the other writes, at most once every 10 minutes per thread, so a burst of short messages becomes one alert. Your alert includes the text; the client's says only that you've written, like update emails.
- **Team:** outside advisers (below).

Old links still work: `#overview` and `#timeline` open Home, and `#tasks` opens Requests.

**Requests.** A request has a kind and a status:

- **Kinds:** a document, an answer, an approval, a plain to-do, or pricing (see below).
- **Status:** open, then answered (awaiting review), then accepted, or sent back with "changes requested".
- **Who can ask whom:** the client can ask you or anyone on their team, and gives themselves to-dos. A team member can ask the client, you or another member, but can't create to-dos or pricing requests. You can ask anyone.
- **Answering:** whoever is asked answers in the portal with a note and files. A to-do is done as soon as it's ticked.
- **Reviewing:** whoever asked accepts the answer, or sends it back with a note saying what to change. The client can also review anything asked of their team. In admin you can answer on someone's behalf (for an answer you got by email or on a call).
- **Files on a request:** stored under `<engagement>/requests/<request>/`. Only the people on that request can open them.
- **Emails:** each step emails the next person.

**Alerts (the bell).** The database writes one alert per person per event, and only about things that person can see: messages, documents, team files, requests and their answers, questionnaires, decisions, milestones and pricing. New alerts arrive live, over Supabase Realtime. Opening a tab marks its alerts read, and **Mark all read** clears the rest. In admin the bell covers every engagement, and choosing an alert opens that engagement.

**Pricing (schedule of values).** A contractor prices a sheet line by line, and the owner side sees each price beside its budget:

- **Creating a sheet:** in admin, open the engagement's **Pricing** card and choose **New pricing sheet**.
  - Give it a title, a contractor and what you need from them.
  - Start from the CSI 01–33 template or a blank sheet.
  - Add the contractor to the team first. They're asked and emailed when the sheet is created.
- **The sheet page** (`portal/pricing.html?s=<sheet>`, admin only):
  - edit descriptions and codes, and add or remove lines and sections;
  - key in prices yourself;
  - set the **budget** per line (low, base, high);
  - review the pricing, or reopen it.
- **The contractor** gets a **Pricing** tab and works in the grid:
  - every cell saves about half a second after typing stops, or at once on leaving it. Only the changed fields are sent, so two people never overwrite each other;
  - **Enter** moves down, the arrow keys move between cells, **Esc** undoes the cell, and a column pasted from Excel fills the rows below;
  - typing `48k` or `1.2m` works;
  - if the connection drops, edits wait in the browser and land when it's back, even after a reload;
  - quantity times unit cost fills the amount, and the subtotal, OH&P, total and cost per SF update as they type;
  - below the grid they give the price's terms: area, location, validity date, OH&P and what it covers, schedule, and basis and exclusions.
- **Submitting:** before submitting, every line needs a price, or a note if it's Excluded or TBD, and the validity date must be set. Submitting locks the sheet, keeps a copy as a numbered version, and tells the client and you.
- **The owner side** (the client and you) watches the sheet fill in live:
  - each line shows its budget, its range, and the variance;
  - the totals bar compares priced lines with their own budget, so a half-finished sheet isn't judged against the whole budget;
  - you can ask a question on any line, which the contractor sees;
  - when it's submitted, you accept the pricing, or send it back with a note;
  - after a resubmission, each changed line shows the earlier version's figure.
- **Exports:** CSV (with budget columns on the owner side only), and **Print / PDF** in the site's brand.
- **The budget stays owner-side.** It lives in its own table, and the database returns nothing from it to the contractor, so it is never in their browser.

**The project model.** One place for the whole project, linked together:

- **Total project budget:** land, hard costs, contingency and escalation, soft and opening costs, and financing costs.
  - Each line has low, base and high figures, what's committed, what's paid, a confidence, when it's paid, and its own comments.
  - **Hard costs come live from the pricing sheet:** each line forecasts at the contractor's price once given, and at its budget until then. The contractor's overhead and profit replaces the budgeted percent once they set it.
  - Contingency and escalation are percents of hard cost.
- **The forecast scenario** uses the best figure for each line: paid, else committed, else the contractor's price, else the budget. Low, Base and High use the budgets.
- **Sources and uses:** the loan (a loan-to-cost share, or a fixed amount), and equity, which is spent first. It shows the funding gap once equity available is confirmed.
- **Cash flow:** each cost goes out at closing, over design and permits, over construction (on an S-curve), at opening, or over custom months.
  - The loan funds the rest month by month. Interest during construction and the loan fee are worked out from those draws and the loan size, then recalculated until the total settles.
  - After opening: the revenue ramp, EBITDA, debt service, and coverage for three years. Coverage is shown for the project and globally, with the existing businesses' normalized cash flow less owner draws, against all debt service.
- **Assumptions:** each has a value, a status (confirmed, estimate or unknown) and the person who should confirm it.
  - On `portal/project.html?m=<model>` you assign someone and press **Ask**: they get a request and an email, and set the value in the model's Project tab. That answers their request for you to review, and every change is logged with who, when and their note.
  - Typing a figure into an unknown item makes it an estimate until someone confirms it.
- **Who sees it:**
  - you;
  - the client;
  - advisers given **Project model** access in Team (the client's tab or the engagement page). An accountant or a lender, for example, sees the model, the pricing sheet and its budget. They can set only the items assigned to them, and can comment on anything.
- **The contractor never sees it:** the database refuses to give a sheet's contractor model access, and refuses to make someone with access a contractor.
- **Creating one:** in admin, on the engagement's **Project model** card. It starts from a construction-and-loan template (the usual soft costs, contingency, escalation, loan fees, interest during construction, and the standard assumptions).
- **Versions and exports:** save a dated version (for example, the lender package), download CSV (totals, the month-by-month schedule and the assumptions), or **Print / PDF**.

**The owner model (Books and tax).** Everything a person owns, read the way a forensic accountant, a tax CPA and a lender's underwriter read it. One per engagement, beside the project model, and reusable for any owner-operator:

- **The books, by entity and period:** each trade or LLC, each year (and a year to date), as reported: revenue, cost of goods, operating and other expenses, net income, depreciation, interest, rent paid to the owner, owner pay expensed, and the filed return's gross receipts and net profit beside them. The model shows gross margin, EBITDA, **cash flow available for debt service** (net income plus depreciation, interest, rent to the owner and owner pay, plus evidenced add-backs, less evidenced deductions and non-recurring items), annualizes part years, and shows the **book-to-tax gap** (return less books), how much of it evidenced items explain, and what is still unexplained.
- **Adjustments:** add-backs, deductions, non-recurring items, related-party eliminations and book-to-tax items, each with an evidence status. Only **evidenced** or **approved** items count; proposed ones are shown beside the figures so a hypothesis is never silently a number.
- **Properties and cost segregation:** each property's use, who uses it, where the rent comes from (the owner's own business, a third party, family, none), cost basis, land share, dates, prior depreciation, value, debt and rent. Components carve the depreciable basis into 5-, 7- and 15-year property, qualified improvement property, single-purpose agricultural structures and farm buildings, with typical splits for restaurants, commercial, warehouse, residential, equine and mixed use one click away. The arithmetic follows MACRS (half-year convention; mid-month straight line for the building) and bonus depreciation by the date each component was acquired and placed in service (100% for property acquired after January 19, 2025; 60% in 2024; 80% in 2023; 100% from late 2017 through 2022). For a property already in service it works out the **catch-up** (what a study would have allowed, less what was taken, taken in the study year on Form 3115), the study year's extra deduction, the tax saved at the owner's marginal rate (plus self-employment tax where the owner uses the property in her own trade, less the lost qualified business income deduction), what is suspended under the passive activity rules, and the present value of the timing benefit. Deductions beyond the year's income are shown as a net operating loss carried forward.
- **The owner's taxes:** an estimate of the latest filed year and of the study year with and without the study: self-employment tax, adjusted gross income, the standard or itemized deduction, the qualified business income deduction (with the wage and property limits above the threshold), taxable income, income tax, net investment income tax, the marginal bracket and the effective rate. Parameters for 2024, 2025 and 2026 are in `owner-calc.js`; check them against the IRS figures each year.
- **Global cash flow and coverage:** the entities' recurring cash flow (the latest full year, or an override per entity), third-party rents net of costs, less taxes and the owner's living draws, against existing debt service; and, when a project model is linked, coverage with the new loan using that model's year-2 figures. Self-rent between the owner and her businesses is eliminated. **Send these figures to the project model** writes the existing cash flow, existing debt service and owner draws into the project model as estimates.
- **Personal and marital:** the owner as a person, beside the businesses: marital status and marital agreements (what a partition agreement covers and what it leaves out), dependents, residence, vehicles, accounts, personal debts, insurance, retirement, estate documents and the filing-status question. Each item has a value, what is owed against it, a date, a status (current, in progress, needed, resolved) and who acts. A lender reads these with the global cash flow; a marital agreement decides what the owner actually owns.
- **Findings:** a register of what was observed, why it matters, the test, the evidence needed, who resolves it and its status. A new model starts with fifteen standard forensic findings. You assign a finding and press **Ask**: they get a request and an email. Anyone who can see the model can comment on any finding, figure or property.
- **Assumptions, versions, exports, access:** as in the project model (statuses, owners, Ask, the change log, saved versions, CSV, print; the version, CSV and print buttons sit in the header). The same people see it: you, the client, and advisers given model access, never a pricing sheet's contractor. The client and advisers see the figures read-only and set only the assumptions assigned to them.
- **Two views, and a bar to move between sections.** The **summary** (the client's and an adviser's default) shows what is still open, the coverage, the taxes, each property on one line and the findings that matter (the critical ones and those assigned to the viewer), with the rest of each finding behind a disclosure. The **working** view (your default) shows every section, each closed to a one-line summary (recurring cash flow by entity, items evidenced and unexplained, the usable deduction and tax saved, the coverage, how many assumptions are confirmed, how many findings are open) until it is opened; property cards open the same way, and findings show the critical ones first with **Show all** for the rest. A bar under the figures stays at the top of the window and jumps to any section. The view and what is open are remembered in the browser, per model.
- **Creating one:** in admin, on the engagement's **Owner model** card: a title, the owner's name, the project model to link (optional) and the entities, one per line. Then add the books by year, the properties and the adjustments on `portal/owner.html?m=<model>`. The client's room shows it as the **Books and tax** tab.

**Team access (outside advisers).** The client's **Team** tab, or the **Team** card on your engagement page, adds an attorney, CPA, lender or anyone else by email:

- **Access is time-limited:** 30 days, 90 days (the default) or until the engagement ends. It stops by itself at the end date, when it's removed, or when the engagement is no longer active, and the database enforces each of these. Anyone with access can be extended 30 days, have messaging or files switched off, or be removed at any time; removed or expired people can be restored.
- **What members see:**
  - their own **Home**;
  - **Requests** they asked or were asked;
  - a separate **team thread**;
  - **team files**: anyone may upload, and you choose which deliverables the team also sees with "Share with team";
  - **Pricing**, only for a contractor assigned a sheet.
- **What members never see:** your private thread with the client, questionnaires, updates, decisions, milestones, the agreement, the timeline or AI drafts.
- **Invitations:** new people get the Supabase "Invite user" email (restyle it under Authentication → Emails → Templates); people who already have a portal login get a short note. When a client adds someone, you're emailed straight away.
- **Requests:** members see the requests they asked or were asked, and the team's to-dos.

In admin, each engagement page is six tabs (`#engagement=<id>/<tab>`), with the next conversation and the milestone list beside every one of them:

- **Today:** the private thread with a reply box, **Requests** (ask the client or any team member for a document, answer, approval or to-do; review answers) and recent activity. Its badge counts unread client messages and answers to review.
- **Models:** the project model, the owner model and the pricing sheets (progress and budget variance), each with its "new" form behind a link.
- **Documents:** deliverables (upload a file up to 50 MB, give it a title, note and milestone, optionally email the client; share with the team), team files, published updates and the AI drafts.
- **Plan:** milestones, the decision log, the report context for the AI and the full activity list.
- **People:** the client, the **Team** card (people, invitations, model access) and the team thread.
- **Settings:** questionnaires, deleting a model or a sheet, and closing out.

Every form is behind a link until you need it. Unread client messages show on the Overview and next to **Clients & engagements**. To show a direct line or a response promise on the contact card, fill in `phone` and `response_promise` in `assets/js/portal/config.js`.

---

## The AI step

When a client submits, `process-submission` sends Claude:

- every question, its "what the answer changes" note and its priority flag
- the client's answers, notes, "don't know yet" markers and attachment names
- your private **report context** for that engagement

Claude returns a structured draft:

- a summary for you
- extracted data points with verbatim quotes
- proposed section updates (revise / confirms / contradiction / new risk) written in your report's voice
- whether the model needs rerunning, and which inputs changed
- flags, follow-up questions, and still-open items
- a plain-language message for the client

You review it at **Admin → AI drafts**. You can copy proposed wording into the report, download the draft as Markdown, turn the follow-up questions into a new questionnaire with one click, edit the client message, and **Approve & publish**.

**Model and settings.** Claude Opus 5.5 (`claude-opus-5-5`) with structured JSON output. Server-side fallbacks are on (`fallbacks: "default"`), so a rare safety-classifier decline is retried automatically on Anthropic's recommended model. Effort defaults to `high`; set the `CLAUDE_EFFORT` secret to `medium` for faster, cheaper drafts. Client answers are treated as material to analyse, never as instructions.

**Cost.** A 59-question submission is roughly 15–25k input and 4–8k output tokens, about **$0.20–$0.50 per draft** at Opus 5.5 pricing ($4 / $20 per million tokens), including the model's reasoning tokens. Regenerating a draft costs the same again.

**Limits.** Drafts run as a background task after the function responds. If very long questionnaires time out on the free Supabase plan, lower `CLAUDE_EFFORT` or upgrade the plan. A failed draft emails you and can be regenerated from the engagement page.

### Toward fully automatic report updates
The draft already outputs **model input changes** (input, previous value, new value, source question). The next phase is:
1. Map each question to the model input it feeds (a `model_inputs` table, or named cells in a Google Sheet).
2. When you approve a draft, write the approved input changes to the model and recalculate.
3. Regenerate the affected report charts, tables and sections from the recalculated model, then route the new PDF to you for sign-off before it's published to the client.

Your approval step stays in the loop: it's what makes the report trustworthy.

---

## Questionnaire file format

```json
{
  "title": "Follow-up questions for the principal",
  "description": "Shown in your library",
  "intro": "Shown at the top of the questionnaire",
  "questions": [
    {
      "number": "1",
      "section_code": "A",
      "section_title": "Where things stand today",
      "prompt": "Has the business delivered any product since launch?",
      "why": "Replaces the first months of the ramp with actuals",
      "priority": "rerun",
      "answer_type": "long_text"
    }
  ]
}
```

- `priority`: `"rerun"` (shown as *High impact · updates the model*), `"critical"` (*Critical next step*), or omit it.
- `answer_type`: `long_text` (default), `short_text`, `number`, `currency`, `date`, `yes_no`.

Admin → Questionnaires → **Download template** gives you a starter file.

---

## Security model

- **Prospects can't read anything.** Diagnostics are written by the `submit-inquiry` function with the service role; the table is admin-only.
- **A proposal is readable only with its link**, through two database functions that return the client-facing fields and accept or decline. Drafts and withdrawn proposals return nothing; your own previews aren't counted as views.
- **Clients see only their own engagements, questions, answers, files, milestones, decisions and published updates.** Another client's data is invisible to them, and the private report context and all AI drafts are admin-only.
- Answers lock on submission; only you can reopen them.
- Files go to a private storage bucket in per-engagement folders, served through short-lived signed links (5 minutes). The upload limit is 50 MB, and only documents, spreadsheets, slides, CSV, text and images are accepted (PDF, Word, Excel, PowerPoint, RTF, CSV, TXT, PNG, JPG, GIF, WebP, HEIC). The bucket enforces the list; the portal checks it first so people get a clear message.
- **Admin access needs two-step sign-in** (an authenticator-app code on top of the email link). `public.is_admin()` checks the session's assurance level, and the functions check it too.
- **Outside team members** see only the team thread, team files, shared deliverables, the requests they asked or were asked (and their files), and a pricing sheet they're assigned. They lose access at their end date, when removed, or when the engagement is marked complete.
- **Pricing budgets, the project model and the owner model** are readable only by you, the client and advisers given model access (never a sheet's contractor). Contractors edit through database functions that check the sheet is theirs and still open, and can change only prices, quantities, units, status and notes.
- **Model assumptions** can be changed only by you, or by the person asked to confirm each one, through a function that logs every change.
- **Alerts** are written by the database for each recipient, so nobody can read someone else's alerts or create alerts directly.
- **The website sends strict security headers** (`.htaccess`): HTTPS only (HSTS), and a Content Security Policy that lets pages run only the site's own scripts and talk only to the Supabase project. If you add an inline script or an outside service (analytics, a map, a booking widget), the policy must allow it: run `node scripts/check-csp.mjs` and update `.htaccess`.
- **Closing out.** On an engagement page in admin, **Mark complete** ends outside team access and leaves the client read access. **Export everything** downloads all of the engagement's records as JSON (files are listed by path; download any you need first). **Delete engagement and files** asks you to type the title, then removes the stored files and every record.
- Clients can't change their own role. Sign-in is by one-time email link, for invited addresses only.
- The service-role key and the Anthropic and Resend keys live only in Supabase function secrets, never in the browser.
- Re-run the access tests after any schema change (GitHub runs them, the script checks, the policy check and the build check on every push):
  ```sh
  cd supabase/tests && npm i @electric-sql/pglite && node rls-test.mjs
  ```
