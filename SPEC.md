# claw-apply — Technical Spec

Automated job search and application engine. Searches LinkedIn and Wellfound for matching roles, applies automatically using Playwright + Kernel stealth browsers, and self-learns from unknown questions.

---

## Architecture

### Two agents, shared queue

**JobSearcher** (`job_searcher.mjs`)
- Runs on schedule (default: hourly)
- Searches configured platforms with configured keywords
- LinkedIn: paginates through up to 40 pages of results
- Wellfound: infinite-scrolls up to 10 times to load all results
- Filters out excluded roles/companies
- Deduplicates by job ID and URL against existing queue
- Writes new jobs to `jobs_queue.json` with status `new`
- Sends Telegram summary

**JobApplier** (`job_applier.mjs`)
- Runs on schedule (default: every 6 hours)
- Reads queue for status `new` + `needs_answer`
- Respects `max_applications_per_run` cap
- LinkedIn: navigates directly to job URL, detects apply type (Easy Apply / external / recruiter-only), fills multi-step modal
- Wellfound: navigates to job, fills form, submits
- Detects honeypot questions and skips
- On unknown required fields: messages user via Telegram, marks `needs_answer`
- On error: retries up to `max_retries` (default 2) before marking `failed`
- Sends summary with granular skip reasons

**Preview mode** (`--preview`): shows queued jobs without applying.

### Shared modules

| Module | Responsibility |
|--------|---------------|
| `lib/constants.mjs` | All timeouts, selectors, defaults — no magic numbers in code |
| `lib/browser.mjs` | Browser factory — Kernel stealth (default) with local Playwright fallback |
| `lib/form_filler.mjs` | Generic form filling — custom answers first, then built-in profile matching |
| `lib/queue.mjs` | Queue CRUD with in-memory caching, config file validation |
| `lib/notify.mjs` | Telegram Bot API with rate limiting (1.5s between sends) |
| `lib/linkedin.mjs` | LinkedIn search (paginated) + Easy Apply (multi-step modal) |
| `lib/wellfound.mjs` | Wellfound search (infinite scroll) + apply |

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
  "notifications": {
    "telegram_user_id": "YOUR_TELEGRAM_USER_ID",
    "bot_token": "YOUR_TELEGRAM_BOT_TOKEN"
  },
  "kernel": {
    "proxy_id": "YOUR_KERNEL_PROXY_ID",
    "profiles": {
      "linkedin": "LinkedIn-YourName",
      "wellfound": "WellFound-YourName"
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
    "title": "Senior Account Executive",
    "company": "Acme Corp",
    "url": "https://linkedin.com/jobs/view/4381658809/",
    "found_at": "2026-03-05T22:00:00Z",
    "status": "new",
    "status_updated_at": "2026-03-05T22:00:00Z",
    "retry_count": 0,
    "pending_question": null,
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
| `needs_answer` | Blocked on unknown question | Applier retries after user answers |
| `failed` | Failed after max retries | Manual review |
| `skipped` | Honeypot detected | Permanent skip |
| `skipped_recruiter_only` | LinkedIn recruiter-only | Permanent skip |
| `skipped_external_unsupported` | External ATS | Saved for future ATS support |
| `skipped_easy_apply_unsupported` | No Easy Apply button | Permanent skip |

### `applications_log.json`

Append-only history of every application attempt with outcome, timestamps, and metadata.

---

## Unknown question flow

1. Applier encounters a required field with no matching answer
2. Marks job as `needs_answer`, stores question in `pending_question`
3. Sends Telegram: "Applying to Senior AE @ Acme Corp — question: 'What was your quota attainment?' — what should I answer?"
4. Moves on to next job
5. User replies with answer
6. Answer saved to `answers.json` as pattern match
7. Next applier run retries all `needs_answer` jobs

---

## Retry logic

When an application fails due to a transient error (timeout, network issue, page didn't load):

1. `retry_count` is incremented on the job
2. Job status is reset to `new` so the next run picks it up
3. After `max_retries` (default 2) failures, job is marked `failed` permanently
4. Failed jobs are logged to `applications_log.json` with error details

---

## File structure

```
claw-apply/
├── README.md                  Documentation
├── SKILL.md                   OpenClaw skill manifest
├── SPEC.md                    This file
├── job_searcher.mjs           Search agent
├── job_applier.mjs            Apply agent
├── setup.mjs                  Setup wizard
├── lib/
│   ├── constants.mjs          Shared constants and defaults
│   ├── browser.mjs            Kernel/Playwright browser factory
│   ├── form_filler.mjs        Form filling with pattern matching
│   ├── linkedin.mjs           LinkedIn search + Easy Apply
│   ├── wellfound.mjs          Wellfound search + apply
│   ├── queue.mjs              Queue management + config validation
│   └── notify.mjs             Telegram notifications + rate limiting
├── config/
│   ├── *.example.json         Templates (committed)
│   └── *.json                 User config (gitignored)
└── data/
    ├── jobs_queue.json         Job queue (auto-managed)
    └── applications_log.json   Application history (auto-managed)
```

---

## Roadmap

### v1 (current)
- [x] LinkedIn Easy Apply (multi-step modal, pagination)
- [x] Wellfound apply (infinite scroll)
- [x] Kernel stealth browsers + residential proxy
- [x] Self-learning answer bank with regex patterns
- [x] Retry logic with configurable max retries
- [x] Preview mode (`--preview`)
- [x] Configurable application caps
- [x] Telegram notifications with rate limiting
- [x] Config validation with clear error messages
- [x] In-memory queue caching for performance
- [x] Constants extracted — no magic numbers in code

### v2 (planned)
- [ ] Indeed support
- [ ] External ATS support (Greenhouse, Lever)
- [ ] Job scoring and ranking
- [ ] Per-job cover letter generation via LLM
