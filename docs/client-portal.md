# Sypher Client Portal: setup and operation

A private workspace at `/portal/` where clients answer your questions, and you review, analyse and publish.

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
| `supabase/functions/invite-client` | Admin-only: invites a client by email and opens their engagement |
| `supabase/functions/process-submission` | On submit: asks Claude for a draft update, emails you |
| `supabase/functions/publish-update` | Admin-only: publishes your approved update, emails the client |
| `supabase/tests/rls-test.mjs` | 31 automated security tests for the access rules |
| `private/` | Git-ignored. Client question sets (e.g. the PCG file) live here, never in the repo |

---

## Going live (about 30–45 minutes)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a project (the free tier is enough to start). Choose a US region.
2. **SQL Editor →** paste the whole of `supabase/migrations/20261001000000_client_portal.sql` → **Run**.

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
```

### 6. Connect the site
In `assets/js/portal/config.js`, paste **Project URL** and the **anon / publishable key** (Project Settings → API). The anon key is designed to be public; the database rules protect the data. Commit and deploy the site. The demo banner disappears and sign-in switches to email links.

### 7. First engagement
1. Sign in at `/portal/` → **Questionnaires → Import** → choose `private/pcg-follow-up-questions.json` (59 questions, sections A–J, with the rerun and Gate 1 flags).
2. **Clients & engagements → Invite a client** (email, name, company, engagement title).
3. Open the engagement and paste the report's key assumptions and conclusions into **Report context for the AI**. This is what Claude compares answers against.
4. **Assign** the questionnaire with a due date and a short note. The client is emailed and sees it on sign-in.

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

- **Clients see only their own engagements, questions, answers, files and published updates.** Another client's data is invisible to them, and the private report context and all AI drafts are admin-only.
- Answers lock on submission; only you can reopen them.
- Files go to a private storage bucket in per-engagement folders, served through short-lived signed links (5 minutes). The upload limit is 50 MB.
- Clients can't change their own role. Sign-in is by one-time email link, for invited addresses only.
- The service-role key and the Anthropic and Resend keys live only in Supabase function secrets, never in the browser.
- Re-run the access tests after any schema change:
  ```sh
  cd supabase/tests && npm i @electric-sql/pglite && node rls-test.mjs
  ```
