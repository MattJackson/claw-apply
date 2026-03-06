# claw-apply — Technical Spec

Automated job search and application engine. Searches LinkedIn and Wellfound for matching roles, AI-filters and scores them, applies automatically using Playwright + Kernel stealth browsers, and self-learns from unknown questions via Telegram.

---

## Architecture

### Four agents, shared queue

**JobSearcher** (`job_searcher.mjs`)
- Runs on schedule (default: every 12 hours)
- Searches configured platforms with configured keywords
- LinkedIn: paginates through up to 40 pages of results
- Wellfound: infinite-scrolls up to 10 times to load all results
- Classifies each job: Easy Apply, external ATS (with platform detection), recruiter-only
- Filters out excluded roles/companies
- Deduplicates by job ID and URL against existing queue
- Cross-track duplicate IDs get composite IDs (`{id}_{track}`)
- Writes new jobs to `jobs_queue.json` with status `new`
- Sends Telegram summary

**JobFilter** (`job_filter.mjs`)
- Runs on schedule (default: every hour at :30)
- Two-phase: submit batch → collect results (designed for cron)
- Submits unscored jobs to Claude AI via Anthropic Batch API (50% cost savings)
- One batch per search track for prompt caching efficiency
- Scores each job 1-10 based on match to profile and search track
- Jobs below threshold (default 5) marked `filtered`
- Cross-track deduplication: groups by URL, keeps highest score
- State persisted in `data/filter_state.json` between phases

**JobApplier** (`job_applier.mjs`)
- Runs on schedule (disabled by default until ready)
- Processes Telegram replies at start (safety net for answer learning)
- Reloads `answers.json` before each job (picks up mid-run Telegram replies)
- Reads queue for status `new` + `needs_answer`, sorted by priority
- Respects `max_applications_per_run` cap and `enabled_apply_types` filter
- Groups jobs by platform to share browser sessions
- LinkedIn Easy Apply: multi-step modal with shadow DOM handling
- Wellfound: form fill and submit
- On unknown required fields: generates AI answer, messages user via Telegram, marks `needs_answer`
- Browser crash recovery: detects dead page, creates fresh browser session
- Per-job timeout: 10 minutes. Overall run timeout: 45 minutes
- On error: retries up to `max_retries` (default 2) before marking `failed`
- Sends summary with granular skip reasons

**TelegramPoller** (`telegram_poller.mjs`)
- Runs every minute via OpenClaw cron
- Polls Telegram `getUpdates` for replies to question messages
- Matches replies via `reply_to_message_id` stored on jobs
- "ACCEPT" → use AI-suggested answer. Anything else → use reply text
- Saves answer to `answers.json` (reused for ALL future jobs)
- Flips job back to `new` for retry
- Sends confirmation reply on Telegram
- Lightweight: single HTTP call, exits immediately if no updates

**Preview mode** (`--preview`): shows queued jobs without applying.

### Shared modules

| Module | Responsibility |
|--------|---------------|
| `lib/constants.mjs` | All timeouts, selectors, defaults — no magic numbers in code |
| `lib/browser.mjs` | Browser factory — Kernel stealth (default) with local Playwright fallback |
| `lib/session.mjs` | Kernel Managed Auth session refresh |
| `lib/env.mjs` | .env loader (no dotenv dependency) |
| `lib/form_filler.mjs` | Form filling — custom answers, built-in profile matching, fuzzy select matching |
| `lib/ai_answer.mjs` | AI answer generation via Claude (profile + resume context) |
| `lib/filter.mjs` | AI job scoring via Anthropic Batch API |
| `lib/keywords.mjs` | AI-generated search keywords via Claude |
| `lib/queue.mjs` | Queue CRUD with in-memory caching, atomic writes, config validation |
| `lib/notify.mjs` | Telegram Bot API — send, getUpdates, reply (with rate limiting) |
| `lib/telegram_answers.mjs` | Telegram reply processing — matches to jobs, saves answers |
| `lib/search_progress.mjs` | Per-platform search resume tracking |
| `lib/lock.mjs` | PID-based lockfile with graceful shutdown |
| `lib/apply/index.mjs` | Apply handler registry with status normalization |
| `lib/apply/easy_apply.mjs` | LinkedIn Easy Apply — shadow DOM, multi-step modal, post-submit detection |

---

## LinkedIn Easy Apply — Technical Details

LinkedIn renders the Easy Apply modal inside **shadow DOM**. This means:
- `document.querySelector()` inside `page.evaluate()` **cannot** find modal elements
- `page.$()` and ElementHandle methods **pierce** shadow DOM and work correctly
- All modal operations use ElementHandle-based operations, never `evaluate` with `document.querySelector`

### Button detection

`findModalButton()` uses three strategies in order:
1. CSS selector via `page.$()` — aria-label exact match (pierces shadow DOM)
2. CSS selector via `page.$()` — aria-label substring match
3. `modal.$$('button')` + `btn.evaluate()` — text content matching

Check order per step: **Next → Review → Submit** (submit only when no forward nav exists).

### Modal flow

```
Easy Apply click → [fill fields → Next] × N → Review → Submit application
```

- Progress tracked via `<progress>` element (not `[role="progressbar"]`)
- Stuck detection: re-reads progress value after clicking Next, triggers after 3 unchanged clicks
- Submit verification: `waitForSelector(state: 'detached', timeout: 8s)` — event-driven, not fixed sleep
- Post-submit: checks for success text, absent Submit button, or validation errors
- Multiple `[role="dialog"]` elements: `findApplyModal()` identifies the apply modal and tags it with `data-claw-apply-modal`

### Form filling

- Labels found by walking up ancestor DOM (LinkedIn doesn't use `label[for="id"]`)
- Label deduplication for doubled text (e.g. "Phone country codePhone country code")
- Resume selection: selects first radio if none checked, falls back to file upload
- Select matching: `selectOptionFuzzy()` — exact → case-insensitive → substring → value
- Phone always overwritten (LinkedIn pre-fills wrong numbers)
- EEO/voluntary fields auto-select "Prefer not to disclose"
- Honeypot detection: questions containing "digit code", "secret word", etc.

### Dismiss flow

Always discards — never leaves drafts:
1. Click Dismiss/Close button or press Escape
2. Wait for Discard confirmation dialog
3. Click Discard (by `data-test-dialog-primary-btn` or text scan scoped to dialogs)

---

## Config files

All user config is gitignored. Example templates are committed.

### `profile.json`

```json
{
  "name": { "first": "Jane", "last": "Smith" },
  "email": "jane@example.com",
  "phone": "555-123-4567",
  "location": {
    "city": "San Francisco",
    "state": "California",
    "zip": "94102",
    "country": "United States"
  },
  "linkedin_url": "https://linkedin.com/in/janesmith",
  "resume_path": "/home/user/resume.pdf",
  "years_experience": 7,
  "work_authorization": {
    "authorized": true,
    "requires_sponsorship": false
  },
  "willing_to_relocate": false,
  "desired_salary": 150000,
  "cover_letter": "Your cover letter text here."
}
```

### `search_config.json`

```json
{
  "first_run_days": 90,
  "searches": [
    {
      "name": "Founding GTM",
      "track": "gtm",
      "keywords": ["founding account executive", "first sales hire"],
      "platforms": ["linkedin", "wellfound"],
      "filters": {
        "remote": true,
        "posted_within_days": 2,
        "easy_apply_only": false
      },
      "exclude_keywords": ["BDR", "SDR", "staffing", "insurance"]
    }
  ]
}
```

### `settings.json`

```json
{
  "max_applications_per_run": 50,
  "max_retries": 2,
  "enabled_apply_types": ["easy_apply"],
  "notifications": {
    "telegram_user_id": "YOUR_TELEGRAM_USER_ID",
    "bot_token": "YOUR_TELEGRAM_BOT_TOKEN"
  },
  "kernel": {
    "proxy_id": "YOUR_KERNEL_PROXY_ID",
    "profiles": {
      "linkedin": "LinkedIn-YourName",
      "wellfound": "WellFound-YourName"
    },
    "connection_ids": {
      "linkedin": "YOUR_LINKEDIN_CONNECTION_ID",
      "wellfound": "YOUR_WELLFOUND_CONNECTION_ID"
    }
  },
  "browser": {
    "provider": "kernel",
    "playwright_path": null
  }
}
```

### `answers.json`

Flat array of pattern-answer pairs. Patterns are matched case-insensitively and support regex. First match wins.

```json
[
  { "pattern": "quota attainment", "answer": "1.12" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "1.*10.*scale", "answer": "9" }
]
```

---

## Data files (auto-managed)

### `jobs_queue.json`

```json
[
  {
    "id": "li_4381658809",
    "platform": "linkedin",
    "track": "ae",
    "apply_type": "easy_apply",
    "title": "Senior Account Executive",
    "company": "Acme Corp",
    "url": "https://linkedin.com/jobs/view/4381658809/",
    "found_at": "2026-03-05T22:00:00Z",
    "status": "new",
    "status_updated_at": "2026-03-05T22:00:00Z",
    "retry_count": 0,
    "pending_question": null,
    "ai_suggested_answer": null,
    "telegram_message_id": null,
    "applied_at": null,
    "notes": null
  }
]
```

### Job statuses

| Status | Meaning | Next action |
|--------|---------|-------------|
| `new` | Found, waiting to apply | Applier picks it up |
| `applied` | Successfully submitted | Done |
| `needs_answer` | Blocked on unknown question | Telegram poller saves reply, flips to `new` |
| `failed` | Failed after max retries | Manual review |
| `already_applied` | Duplicate detected | Permanent skip |
| `filtered` | Below AI score threshold | Permanent skip |
| `duplicate` | Cross-track duplicate (lower score) | Permanent skip |
| `skipped_honeypot` | Honeypot question detected | Permanent skip |
| `skipped_recruiter_only` | LinkedIn recruiter-only | Permanent skip |
| `skipped_external_unsupported` | External ATS | Saved for future ATS support |
| `skipped_easy_apply_unsupported` | No Easy Apply button | Permanent skip |
| `skipped_no_apply` | No apply button found | Permanent skip |
| `no_modal` | Button found but modal didn't open | Retried |
| `stuck` | Modal progress stalled | Retried |
| `incomplete` | Modal didn't reach submit | Retried |

### `applications_log.json`

Append-only history of every application attempt with outcome, timestamps, and metadata.

### `telegram_offset.json`

Stores the Telegram `getUpdates` offset to avoid reprocessing old messages.

### `filter_state.json`

Persists batch IDs between filter submit and collect phases.

---

## Self-learning answer flow

1. Applier encounters a required field with no matching answer
2. Claude generates a suggested answer using profile + resume context
3. Telegram message sent: question text, options (if select), AI suggestion
4. Job marked `needs_answer` with `telegram_message_id` stored
5. User replies on Telegram: their answer, or "ACCEPT" for the AI suggestion
6. Telegram poller (every minute) picks up the reply:
   - Matches via `reply_to_message_id` → job
   - Saves answer to `answers.json` as pattern match
   - Flips job status back to `new`
   - Sends confirmation reply
7. Next applier run: reloads answers, retries the job, fills the field automatically
8. All future jobs with the same question pattern are answered automatically

Safety net: applier also calls `processTelegramReplies()` at start of each run.

---

## Retry logic

When an application fails due to a transient error (timeout, network issue, page didn't load):

1. `retry_count` is incremented on the job
2. Job status is reset to `new` so the next run picks it up
3. After `max_retries` (default 2) failures, job is marked `failed` permanently
4. Failed jobs are logged to `applications_log.json` with error details

Browser crash recovery: after an error, the applier checks if the page is still alive via `page.evaluate(() => true)`. If dead, it creates a fresh browser session and continues with the remaining jobs.

---

## File structure

```
claw-apply/
├── README.md                  Documentation
├── SKILL.md                   OpenClaw skill manifest
├── SPEC.md                    This file
├── claw.json                  OpenClaw skill metadata
├── package.json               npm manifest
├── job_searcher.mjs           Search agent
├── job_filter.mjs             AI filter + scoring agent
├── job_applier.mjs            Apply agent
├── telegram_poller.mjs        Telegram answer reply processor
├── setup.mjs                  Setup wizard
├── status.mjs                 Queue + run status report
├── lib/
│   ├── constants.mjs          Shared constants and defaults
│   ├── browser.mjs            Kernel/Playwright browser factory
│   ├── session.mjs            Kernel Managed Auth session refresh
│   ├── env.mjs                .env loader
│   ├── form_filler.mjs        Form filling with fuzzy select matching
│   ├── ai_answer.mjs          AI answer generation via Claude
│   ├── filter.mjs             AI job scoring via Anthropic Batch API
│   ├── keywords.mjs           AI-generated search keywords
│   ├── linkedin.mjs           LinkedIn search + job classification
│   ├── wellfound.mjs          Wellfound search + apply
│   ├── queue.mjs              Queue management with atomic writes
│   ├── lock.mjs               PID lockfile + graceful shutdown
│   ├── notify.mjs             Telegram Bot API (send, getUpdates, reply)
│   ├── telegram_answers.mjs   Telegram reply → answers.json processing
│   ├── search_progress.mjs    Per-platform search resume tracking
│   └── apply/
│       ├── index.mjs          Handler registry + status normalization
│       ├── easy_apply.mjs     LinkedIn Easy Apply (shadow DOM, multi-step)
│       ├── wellfound.mjs      Wellfound apply
│       ├── greenhouse.mjs     Greenhouse ATS (stub)
│       ├── lever.mjs          Lever ATS (stub)
│       ├── workday.mjs        Workday ATS (stub)
│       ├── ashby.mjs          Ashby ATS (stub)
│       └── jobvite.mjs        Jobvite ATS (stub)
├── config/
│   ├── *.example.json         Templates (committed)
│   └── *.json                 User config (gitignored)
└── data/                      Runtime data (gitignored, auto-managed)
```

---

## Roadmap

### v1 (current)
- [x] LinkedIn Easy Apply (multi-step modal, shadow DOM)
- [x] Wellfound apply (infinite scroll)
- [x] Kernel stealth browsers + residential proxy
- [x] AI job filtering via Anthropic Batch API
- [x] Self-learning answer bank with Telegram Q&A loop
- [x] AI-suggested answers via Claude
- [x] Telegram answer polling (instant save + applier safety net)
- [x] Browser crash recovery
- [x] Retry logic with configurable max retries
- [x] Preview mode (`--preview`)
- [x] Configurable application caps and retry limits
- [x] Constants extracted — no magic numbers in code
- [x] Atomic file writes for queue corruption prevention
- [x] Cross-track deduplication after AI scoring

### v2 (planned)
- [ ] External ATS support (Greenhouse, Lever, Workday, Ashby, Jobvite)
- [ ] Per-job cover letter generation via LLM
- [ ] Indeed support
