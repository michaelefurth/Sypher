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
| `assets/js/portal/config.js` | Supabase URL + anon key. **Empty = demo mode** with fictional data in the browser |
| `supabase/migrations/20261001000000_client_portal.sql` | Database schema, row level security, storage bucket |
| `supabase/migrations/20261002000000_bespoke_flow.sql` | Inquiries, proposals, milestones, decision log, meeting fields |
| `contact.html`, `assets/js/diagnostic.js` | The four-step diagnostic that replaces the contact form |
| `for/index.html`, `assets/js/proposal.js`, `assets/css/proposal.css` | The private proposal page clients read and sign |
| `supabase/functions/submit-inquiry` | Public: stores a diagnostic, drafts your pre-call brief with Claude, emails you and the prospect |
| `supabase/functions/proposal-response` | Public: emails you when a proposal is accepted or declined, and confirms to the signer |
| `supabase/functions/invite-client` | Admin-only: invites a client by email and opens their engagement |
| `supabase/functions/process-submission` | On submit: asks Claude for a draft update, emails you |
| `supabase/functions/publish-update` | Admin-only: publishes your approved update, emails the client |
| `supabase/tests/rls-test.mjs` | 59 automated security tests for the access rules |
| `private/` | Git-ignored. Client question sets (e.g. the PCG file) live here, never in the repo |

---

## Going live (about 30–45 minutes)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a project (the free tier is enough to start). Choose a US region.
2. **SQL Editor →** paste the whole of `supabase/migrations/20261001000000_client_portal.sql` → **Run**. Then do the same with `20261002000000_bespoke_flow.sql`.

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
3. Recommended: turn on multi-factor authentication for your account.

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

# These two are called by people who aren't signed in (prospects and proposal readers).
supabase functions deploy submit-inquiry --no-verify-jwt
supabase functions deploy proposal-response --no-verify-jwt
```

### 6. Connect the site
In `assets/js/portal/config.js`, paste **Project URL** and the **anon / publishable key** (Project Settings → API). The anon key is designed to be public; the database rules protect the data. Commit and deploy the site. The demo banner disappears and sign-in switches to email links.

### 7. First engagement
1. Sign in at `/portal/` → **Questionnaires → Import** → choose `private/pcg-follow-up-questions.json` (59 questions, sections A–J, with the rerun and Gate 1 flags).
2. **Clients & engagements → Invite a client** (email, name, company, engagement title).
3. Open the engagement and paste the report's key assumptions and conclusions into **Report context for the AI**. This is what Claude compares answers against.
4. **Assign** the questionnaire with a due date and a short note. The client is emailed and sees it on sign-in.

---

## Diagnostic, proposals and client rooms

**The diagnostic** (contact page). Four steps: the situation (up to three practices), two questions per practice, the shape of it (stage, team, timeline, budget), and contact details. Answers are kept in the visitor's tab until sent, so a refresh loses nothing. On submit, `submit-inquiry` stores it, emails the prospect a short confirmation, asks Claude for a pre-call brief (a summary, their most telling sentence, likely practices, questions to ask, fit concerns, a first step and a proposal outline) and emails you. A hidden field, a minimum fill time and a per-address limit keep bots out. Without Supabase configured, the page still works and offers to email the notes instead.

**Inquiries** (admin). Read the brief and answers, reply with a pre-written email, keep private notes and a status, and **Start a proposal**: it's prefilled from the brief.

**Proposals** (admin). Write the letter, the situation in their words, objectives, phases, milestones, two or three options with fees, terms and next steps. The terms start from a sensible default; match them to your engagement letter. **Mark as sent** makes the link live; **Email the link** opens a message from your own address. You can see when it was opened and how often. Withdrawing a proposal disables its link.

**The proposal page** (`/for/?p=<name>.<key>`). No sign-in: the 40-character key in the link is the lock, and the page asks search engines not to index it. The client chooses an option, types their name as a signature and accepts, or declines with a note. You're emailed either way, and the signer gets a confirmation. A proposal past its "valid until" date can't be accepted. It prints cleanly to PDF.

**Opening the engagement.** On an accepted proposal, **Open the engagement** invites the signer to the portal, creates the engagement, copies the milestones from the proposal and sets the start date.

**The client room** (the client's dashboard). The engagement on a cover, a milestone track, what they need to complete, your updates, a decision log with reasons, the next conversation (with an add-to-calendar file) and your contact card. You manage milestones, decisions and the next meeting from the engagement page in admin. To show a direct line or a response promise on the contact card, fill in `phone` and `response_promise` in `assets/js/portal/config.js`.

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
- Files go to a private storage bucket in per-engagement folders, served through short-lived signed links (5 minutes). The upload limit is 50 MB.
- Clients can't change their own role. Sign-in is by one-time email link, for invited addresses only.
- The service-role key and the Anthropic and Resend keys live only in Supabase function secrets, never in the browser.
- Re-run the access tests after any schema change:
  ```sh
  cd supabase/tests && npm i @electric-sql/pglite && node rls-test.mjs
  ```
