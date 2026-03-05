---
name: claw-apply
description: Automated job search and application for LinkedIn and Wellfound. Searches for matching roles hourly, applies automatically every 6 hours using Playwright + Kernel stealth browsers. Handles LinkedIn Easy Apply and Wellfound applications. Asks you via Telegram when it hits a question it can't answer, saves your answer, and never asks again. Use when you want to automate your job search and application process.
---

# claw-apply

Automated job search and application. Finds matching roles on LinkedIn and Wellfound, applies automatically, and learns from every unknown question.

## Requirements

- [Kernel.sh](https://kernel.sh) account (for stealth browsers + bot detection bypass)
- Kernel CLI: `npm install -g @onkernel/cli`
- Kernel Managed Auth sessions for LinkedIn and Wellfound
- Kernel residential proxy (US recommended)
- Telegram bot for notifications

## Setup

### 1. Install dependencies
```bash
cd claw-apply
npm install
```

### 2. Create Kernel Managed Auth sessions
```bash
# Create residential proxy
kernel proxies create --type residential --country US --name "claw-apply-proxy"

# Create authenticated browser profiles
kernel auth create --name "LinkedIn-YourName"     # Follow prompts to log in
kernel auth create --name "WellFound-YourName"    # Follow prompts to log in
```

### 3. Configure
Edit these files in `config/`:

- **`profile.json`** — your personal info, resume path, cover letter
- **`search_config.json`** — what jobs to search for (titles, keywords, filters)
- **`settings.json`** — Telegram bot token, Kernel profile names, proxy ID, mode A/B

### 4. Run setup
```bash
KERNEL_API_KEY=your_key node setup.mjs
```

Verifies config, tests logins, sends a test Telegram message.

### 5. Register cron jobs (via OpenClaw)
```
Search: 0 * * * *       (hourly)
Apply:  0 */6 * * *     (every 6 hours)
```

## Running manually
```bash
KERNEL_API_KEY=your_key node job_searcher.mjs   # search now
KERNEL_API_KEY=your_key node job_applier.mjs    # apply now
```

## How it works

**JobSearcher** (hourly):
1. Searches LinkedIn + Wellfound with your configured keywords
2. Filters out excluded roles/companies
3. Adds new jobs to `data/jobs_queue.json`
4. Sends Telegram: "Found X new jobs"

**JobApplier** (every 6 hours):
1. Reads queue for `new` + `needs_answer` jobs
2. LinkedIn: navigates two-panel search view, clicks Easy Apply, fills form, submits
3. Wellfound: navigates to job, fills profile, submits
4. On unknown question → Telegrams you → saves answer → retries next run
5. Sends summary when done

## Mode A vs Mode B
Set in `config/settings.json` → `"mode": "A"` or `"B"`

- **A**: Fully automatic. No intervention needed.
- **B**: Applier sends you the queue 30 min before running. You can flag jobs to skip before it fires.

## File structure
```
claw-apply/
├── job_searcher.mjs        search agent
├── job_applier.mjs         apply agent
├── setup.mjs               setup wizard
├── lib/
│   ├── browser.mjs         Kernel/Playwright factory
│   ├── form_filler.mjs     generic form filling
│   ├── linkedin.mjs        LinkedIn search + apply
│   ├── wellfound.mjs       Wellfound search + apply
│   ├── queue.mjs           queue management
│   └── notify.mjs          Telegram notifications
├── config/
│   ├── profile.json        ← fill this in
│   ├── search_config.json  ← fill this in
│   ├── answers.json        ← auto-grows over time
│   └── settings.json       ← fill this in
└── data/
    ├── jobs_queue.json     auto-managed
    └── applications_log.json  auto-managed
```

## answers.json — self-learning Q&A bank
When the applier hits a question it can't answer, it messages you on Telegram.
You reply. The answer is saved to `config/answers.json` and used forever after.

Pattern matching is regex-friendly:
```json
[
  { "pattern": "quota attainment", "answer": "1.12" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "1.*10.*scale", "answer": "9" }
]
```
