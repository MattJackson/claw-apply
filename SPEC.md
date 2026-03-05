# claw-apply — Skill Spec v0.1

Automated job search and application skill for OpenClaw.
Searches LinkedIn and Wellfound for matching roles, applies automatically using Playwright + Kernel stealth browsers.

---

## Architecture

### Two agents

**JobSearcher** (`job_searcher.mjs`)
- Runs on a schedule (default: hourly)
- Searches configured platforms with configured queries
- Filters out excluded roles/companies
- Dedupes against existing queue
- Writes new jobs to `jobs_queue.json` with status `new`
- Sends Telegram summary: "Found X new jobs"

**JobApplier** (`job_applier.mjs`)
- Runs on a schedule (default: every 6 hours)
- Reads `jobs_queue.json` for status `new` + `needs_answer`
- Attempts to apply to each job
- On success → status: `applied`
- On unknown question → messages user via Telegram, status: `needs_answer`
- On skip/fail → status: `skipped` or `failed`
- Sends Telegram summary when done

---

## Config Files (user sets up once)

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
  "cover_letter": "Your cover letter text here..."
}
```

### `search_config.json`
```json
{
  "searches": [
    {
      "name": "Founding GTM",
      "track": "gtm",
      "keywords": [
        "founding account executive",
        "first sales hire",
        "first GTM hire",
        "founding AE",
        "head of sales startup remote"
      ],
      "platforms": ["linkedin", "wellfound"],
      "filters": {
        "remote": true,
        "posted_within_days": 2
      },
      "exclude_keywords": ["BDR", "SDR", "staffing", "insurance", "retail", "consumer", "recruiter"],
      "salary_min": 130000
    },
    {
      "name": "Enterprise AE",
      "track": "ae",
      "keywords": [
        "enterprise account executive SaaS remote",
        "senior account executive technical SaaS remote"
      ],
      "platforms": ["linkedin"],
      "filters": {
        "remote": true,
        "posted_within_days": 2,
        "easy_apply_only": true
      },
      "exclude_keywords": ["BDR", "SDR", "SMB", "staffing"],
      "salary_min": 150000
    }
  ]
}
```

### `answers.json`
Flat array of pattern → answer mappings. Pattern is substring match (case-insensitive). First match wins.
```json
[
  { "pattern": "quota attainment", "answer": "1.12", "note": "FY24 $1.2M quota, hit $1.12M" },
  { "pattern": "sponsor", "answer": "No" },
  { "pattern": "authorized", "answer": "Yes" },
  { "pattern": "relocat", "answer": "No" },
  { "pattern": "years.*sales", "answer": "7" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "years.*crm", "answer": "7" },
  { "pattern": "1.*10.*scale", "answer": "9" },
  { "pattern": "salary", "answer": "150000" },
  { "pattern": "start date", "answer": "Immediately" }
]
```

### `settings.json`
```json
{
  "mode": "A",
  "review_window_minutes": 30,
  "schedules": {
    "search": "0 * * * *",
    "apply": "0 */6 * * *"
  },
  "max_applications_per_run": 50,
  "notifications": {
    "telegram_user_id": "YOUR_TELEGRAM_ID"
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
    "fallback": "local"
  }
}
```

---

## Data Files (auto-managed)

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
    "pending_question": null,
    "applied_at": null,
    "notes": null
  }
]
```

**Statuses:** `new` → `applied` / `skipped` / `failed` / `needs_answer`

### `applications_log.json`
Append-only history of every application attempt with outcome.

---

## Unknown Question Flow

1. Applier hits a required field it can't answer
2. Marks job as `needs_answer`, stores the question text in `pending_question`
3. Sends Telegram: *"Applying to Senior AE @ Acme Corp and hit this question: 'What was your last quota attainment in $M?' — what should I answer?"*
4. Moves on to next job
5. User replies → answer saved to `answers.json`
6. Next applier run retries all `needs_answer` jobs

---

## Mode A vs Mode B

**Mode A (fully automatic):**
Search → Queue → Apply. No intervention required.

**Mode B (soft gate):**
Search → Queue → Telegram summary sent to user → 30 min window to reply with any job IDs to skip → Apply runs.

Configured via `settings.json` → `mode: "A"` or `"B"`

---

## File Structure

```
claw-apply/
├── SKILL.md              ← OpenClaw skill entry point
├── SPEC.md               ← this file
├── job_searcher.mjs      ← search agent
├── job_applier.mjs       ← apply agent
├── lib/
│   ├── browser.mjs       ← Kernel/Playwright browser factory
│   ├── form_filler.mjs   ← form filling logic
│   ├── linkedin.mjs      ← LinkedIn search + apply
│   ├── wellfound.mjs     ← Wellfound search + apply
│   └── notify.mjs        ← Telegram notifications
├── config/
│   ├── profile.json      ← user fills this
│   ├── search_config.json← user fills this
│   ├── answers.json      ← auto-grows over time
│   └── settings.json     ← user fills this
└── data/
    ├── jobs_queue.json   ← auto-managed
    └── applications_log.json ← auto-managed
```

---

## Setup (user steps)

1. Install: `openclaw skill install claw-apply`
2. Configure Kernel Managed Auth for LinkedIn + Wellfound (or provide local Chrome)
3. Create a residential proxy in Kernel: `kernel proxies create --type residential --country US`
4. Fill in `config/profile.json`, `config/search_config.json`, `config/settings.json`
5. Run: `openclaw skill run claw-apply setup` — registers crons, verifies login, sends test notification
6. Done. Runs automatically.

---

## v1 Scope

- [x] LinkedIn Easy Apply
- [x] Wellfound apply
- [x] Kernel stealth browser + residential proxy
- [x] Mode A + Mode B
- [x] Unknown question → Telegram → answers.json flow
- [x] Deduplication
- [x] Hourly search / 6hr apply cron
- [ ] Indeed (v2)
- [ ] External ATS / Greenhouse / Lever (v2)
- [ ] Job scoring/ranking (v2)
- [ ] Cover letter generation per-job via LLM (v2)
