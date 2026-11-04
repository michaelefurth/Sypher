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
| `supabase/functions/room-notify` | Signed-in users: emails the right people about a new message, document, task or team file |
| `supabase/functions/invite-member` | The client or admin: adds an attorney, CPA or other adviser to an engagement's team |
| `supabase/tests/rls-test.mjs` | 160 automated security tests for the access rules |
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
3. **Authentication → Emails → SMTP:** connect a sender (Resend works well; see step 4), so sign-in emails come from your domain and aren't rate-limited.
4. Optional: in **Authentication → Emails → Templates**, restyle the "Magic link" and "Invite user" emails in your brand.

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

Write new migrations so they can't be half-applied by accident: one change per file, named `YYYYMMDDHHMMSS_what_it_does.sql`, and run the access tests before merging.

## Diagnostic, proposals and client rooms

**The diagnostic** (contact page). A guided conversation, one question per screen: who they are (operating business, starting something, nonprofit, developing a product, something else), then up to three problems worded for that kind of organization (mapped to practices behind the scenes), a short tap-to-choose follow-up and an open question for each, the organization, timing and budget, what they've tried and what good looks like, and finally contact details. Tappable example answers help people start writing, and a "Notes for Michael" panel builds up beside the questions (a collapsible summary on phones). The wording lives in the `PROBLEMS` table at the top of `assets/js/diagnostic.js`. Answers are kept in the visitor's tab until sent, so a refresh loses nothing. On submit, `submit-inquiry` stores it, emails the prospect a short confirmation, asks Claude for a pre-call brief (a summary, their most telling sentence, likely practices, questions to ask, fit concerns, a first step and a proposal outline) and emails you. A hidden field, a minimum fill time and a per-address limit keep bots out.

**Inquiries** (admin). Read the brief and answers, reply with a pre-written email, keep private notes and a status, and **Start a proposal**: it's prefilled from the brief.

**Proposals** (admin). Write the letter, the situation in their words, objectives, phases, milestones, two or three options with fees, terms and next steps. The terms start from a sensible default; match them to your engagement letter. **Mark as sent** makes the link live; **Email the link** opens a message from your own address. You can see when it was opened and how often. Withdrawing a proposal disables its link.

**The proposal page** (`/for/?p=<name>.<key>`). No sign-in: the 40-character key in the link is the lock, and the page asks search engines not to index it. The client chooses an option, types their name as a signature and accepts, or declines with a note. You're emailed either way, and the signer gets a confirmation. A proposal past its "valid until" date can't be accepted. It prints cleanly to PDF.

**Opening the engagement.** On an accepted proposal, **Open the engagement** invites the signer to the portal, creates the engagement, copies the milestones from the proposal and sets the start date.

**The client room** (the client's dashboard), in five tabs:

- **Overview:** what needs them (to-dos they tick off, questionnaires), your latest update, the next conversation, where the plan stands, and the latest message.
- **Plan:** the milestone track, with the documents each milestone produced, and the decision log.
- **Documents:** the signed agreement (opens the accepted proposal read-only at `/for/?e=<engagement>`), deliverables from you filed by milestone, and files they've shared.
- **Messages:** a private thread with you. Each side is emailed when the other writes, at most once every 10 minutes per thread, so a burst of short messages becomes one alert. Your alert includes the text; the client's says only that you've written, like update emails.
- **Timeline:** everything that has happened, newest first. Messages, documents, to-dos, decisions and milestone changes are logged by the database automatically; AI drafts never appear.

**Team access (outside advisers).** The client's **Team** tab, or the **Team** card on your engagement page, adds an attorney, CPA, lender or anyone else by email:

- **Access is time-limited:** 30 days, 90 days (the default) or until the engagement ends. It stops by itself at the end date, when it's removed, or when the engagement is no longer active, and the database enforces each of these. Anyone with access can be extended 30 days, have messaging or files switched off, or be removed at any time; removed or expired people can be restored.
- **What members see:** a separate **team thread**, **team files** (anyone may upload; you choose which deliverables the team can also see with "Share with team"), and **tasks** assigned to them, which they tick off. They also see the rest of the team's tasks for context.
- **What members never see:** your private thread with the client, questionnaires, updates, decisions, milestones, the agreement, the timeline or AI drafts.
- **Invitations:** new people get the Supabase "Invite user" email (restyle it under Authentication → Emails → Templates); people who already have a portal login get a short note. When a client adds someone, you're emailed straight away.
- **Tasks:** the client can now add tasks for themselves or anyone on the team, and you can assign tasks to anyone. Assignees are emailed.

In admin, each engagement page has the private thread with a reply box, the **Team** card (people, invitations, the team thread and team files), **Tasks** (for the client or any team member, optionally emailing them), and **Deliverables** (upload a file up to 50 MB, give it a title, note and milestone, optionally email the client). Unread client messages show on the Overview and next to **Clients & engagements**.

You also manage milestones, decisions and the next meeting from the engagement page. To show a direct line or a response promise on the contact card, fill in `phone` and `response_promise` in `assets/js/portal/config.js`.

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
- **Outside team members** see only the team thread, team files, shared deliverables and their own tasks, and lose access at their end date, when removed, or when the engagement is marked complete.
- **The website sends strict security headers** (`.htaccess`): HTTPS only (HSTS), and a Content Security Policy that lets pages run only the site's own scripts and talk only to the Supabase project. If you add an inline script or an outside service (analytics, a map, a booking widget), the policy must allow it: run `node scripts/check-csp.mjs` and update `.htaccess`.
- **Closing out.** On an engagement page in admin, **Mark complete** ends outside team access and leaves the client read access. **Export everything** downloads all of the engagement's records as JSON (files are listed by path; download any you need first). **Delete engagement and files** asks you to type the title, then removes the stored files and every record.
- Clients can't change their own role. Sign-in is by one-time email link, for invited addresses only.
- The service-role key and the Anthropic and Resend keys live only in Supabase function secrets, never in the browser.
- Re-run the access tests after any schema change (GitHub runs them, the script checks, the policy check and the build check on every push):
  ```sh
  cd supabase/tests && npm i @electric-sql/pglite && node rls-test.mjs
  ```
