# claw-apply

Automated job search and application engine for LinkedIn and Wellfound. Searches for matching roles, applies automatically, and learns from every unknown question it encounters.

Built for [OpenClaw](https://openclaw.dev) but runs standalone with Node.js.

## What it does

- **Searches** LinkedIn and Wellfound on a schedule with your configured keywords and filters
- **Applies** to matching jobs automatically via LinkedIn Easy Apply and Wellfound's native flow
- **Learns** — when it hits a question it can't answer, it messages you on Telegram, saves your reply, and never asks again
- **Deduplicates** across runs so you never apply to the same job twice
- **Retries** failed applications up to a configurable number of times before giving up

## Quick start

```bash
git clone https://github.com/MattJackson/claw-apply.git
cd claw-apply
npm install
```

### 1. Configure

Copy the example configs and fill in your values:

```bash
cp config/settings.example.json config/settings.json
cp config/profile.example.json config/profile.json
cp config/search_config.example.json config/search_config.json
```

| File | What to fill in |
|------|----------------|
| `profile.json` | Name, email, phone, resume path, work authorization, salary |
| `search_config.json` | Job titles, keywords, platforms, filters, exclusions |
| `settings.json` | Telegram bot token + user ID, Kernel profiles, proxy ID |

### 2. Set up Kernel (stealth browsers)

claw-apply uses [Kernel](https://kernel.sh) for stealth browser sessions that bypass bot detection.

```bash
npm install -g @onkernel/cli

# Create a residential proxy
kernel proxies create --type residential --country US --name "claw-apply-proxy"

# Create authenticated browser profiles (follow prompts to log in)
kernel auth create --name "LinkedIn-YourName"
kernel auth create --name "WellFound-YourName"
```

Add the profile names and proxy ID to `config/settings.json`.

### 3. Set up Telegram notifications

1. Message [@BotFather](https://t.me/BotFather) on Telegram to create a bot
2. Copy the bot token to `settings.json` -> `notifications.bot_token`
3. Message [@userinfobot](https://t.me/userinfobot) to get your user ID
4. Add it to `settings.json` -> `notifications.telegram_user_id`

### 4. Verify setup

```bash
KERNEL_API_KEY=your_key node setup.mjs
```

This validates your config, tests LinkedIn and Wellfound logins, and sends a test Telegram message.

### 5. Run

```bash
# Search for jobs
KERNEL_API_KEY=your_key node job_searcher.mjs

# Preview what's in the queue before applying
KERNEL_API_KEY=your_key node job_applier.mjs --preview

# Apply to queued jobs
KERNEL_API_KEY=your_key node job_applier.mjs
```

For automated runs, set up cron or use OpenClaw's scheduler:

```
Search: 0 * * * *       (hourly)
Apply:  0 */6 * * *     (every 6 hours)
```

## How it works

### Search flow

1. Runs your configured keyword searches on LinkedIn and Wellfound
2. Paginates through results (LinkedIn) and infinite-scrolls (Wellfound)
3. Filters out excluded keywords and companies
4. Deduplicates against the existing queue by job ID and URL
5. Saves new jobs to `data/jobs_queue.json` with status `new`
6. Sends a Telegram summary

### Apply flow

1. Picks up all `new` and `needs_answer` jobs from the queue (up to `max_applications_per_run`)
2. Opens a stealth browser session per platform
3. For each job:
   - **LinkedIn Easy Apply**: navigates to job, clicks Easy Apply, fills the multi-step modal, submits
   - **Wellfound**: navigates to job, clicks Apply, fills the form, submits
   - Detects and skips recruiter-only listings, external ATS jobs, and honeypot questions
4. On unknown required fields, messages you on Telegram and moves on
5. Failed jobs are retried on the next run (up to `max_retries`, default 2)
6. Sends a summary with counts: applied, failed, needs answer, skipped

### Self-learning answers

When the applier encounters a form question it doesn't know how to answer:

1. Marks the job as `needs_answer` with the question text
2. Sends you a Telegram message with the question
3. You reply with the answer
4. The answer is saved to `config/answers.json` as a pattern match
5. Next run, it retries the job and fills in the answer automatically

Patterns support regex:

```json
[
  { "pattern": "quota attainment", "answer": "1.12" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "1.*10.*scale", "answer": "9" }
]
```

## Configuration

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `max_applications_per_run` | no limit | Cap applications per run (optional, set to avoid rate limits) |
| `max_retries` | `2` | Times to retry a failed application before marking it permanently failed |
| `browser.provider` | `"kernel"` | `"kernel"` for stealth browsers, `"local"` for local Playwright |

### Search filters

| Filter | Type | Description |
|--------|------|-------------|
| `remote` | boolean | Remote jobs only |
| `posted_within_days` | number | Only jobs posted within N days |
| `easy_apply_only` | boolean | LinkedIn Easy Apply only |
| `exclude_keywords` | string[] | Skip jobs with these words in title or company |
| `first_run_days` | number | On first run, look back N days (default 90) |

## Project structure

```
claw-apply/
├── job_searcher.mjs           Search agent
├── job_applier.mjs            Apply agent
├── setup.mjs                  Setup wizard
├── status.mjs                 Queue status report
├── lib/
│   ├── constants.mjs          Shared constants and defaults
│   ├── browser.mjs            Kernel/Playwright browser factory
│   ├── session.mjs            Kernel Managed Auth session refresh
│   ├── form_filler.mjs        Generic form filling with pattern matching
│   ├── keywords.mjs           AI-generated search keywords via Claude
│   ├── linkedin.mjs           LinkedIn search + job classification
│   ├── wellfound.mjs          Wellfound search
│   ├── queue.mjs              Job queue and config management
│   ├── notify.mjs             Telegram notifications with rate limiting
│   └── apply/
│       ├── index.mjs          Apply handler registry
│       ├── easy_apply.mjs     LinkedIn Easy Apply
│       ├── wellfound.mjs      Wellfound apply
│       ├── greenhouse.mjs     Greenhouse ATS (stub)
│       ├── lever.mjs          Lever ATS (stub)
│       ├── workday.mjs        Workday ATS (stub)
│       ├── ashby.mjs          Ashby ATS (stub)
│       └── jobvite.mjs        Jobvite ATS (stub)
├── config/
│   ├── *.example.json         Templates (committed)
│   ├── profile.json           Your info (gitignored)
│   ├── search_config.json     Your searches (gitignored)
│   ├── answers.json           Learned answers (gitignored)
│   └── settings.json          Your settings (gitignored)
└── data/
    ├── jobs_queue.json         Job queue (auto-managed)
    └── applications_log.json   Application history (auto-managed)
```

## Job statuses

| Status | Meaning |
|--------|---------|
| `new` | Found, waiting to apply |
| `applied` | Successfully submitted |
| `needs_answer` | Blocked on unknown question, waiting for your reply |
| `failed` | Failed after max retries |
| `skipped` | Honeypot detected |
| `skipped_recruiter_only` | LinkedIn recruiter-only listing |
| `skipped_external_unsupported` | External ATS (Greenhouse, Lever — not yet supported) |
| `skipped_easy_apply_unsupported` | No Easy Apply button available |

## Roadmap

- [x] LinkedIn Easy Apply
- [x] Wellfound apply
- [x] Kernel stealth browsers + residential proxy
- [x] Self-learning answer bank
- [x] Retry logic for transient failures
- [x] Preview mode (`--preview`)
- [x] Configurable application caps and retry limits
- [ ] Indeed support
- [ ] External ATS support (Greenhouse, Lever, Workday, Ashby, Jobvite — stubs ready)
- [ ] Job scoring and ranking
- [ ] Per-job cover letter generation via LLM

## License

[AGPL-3.0-or-later](LICENSE)
