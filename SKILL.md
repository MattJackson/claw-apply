---
name: claw-apply
description: Automated job search and application for LinkedIn and Wellfound. Searches for matching roles hourly, applies automatically every 6 hours using Playwright + Kernel stealth browsers. Handles LinkedIn Easy Apply multi-step modals and Wellfound applications. Self-learning — asks you via Telegram when it hits an unknown question, saves your answer, and never asks again. Retries failed applications automatically. Preview mode lets you review the queue before applying.
---

# claw-apply

Automated job search and application. Finds matching roles on LinkedIn and Wellfound, applies automatically, and learns from every unknown question.

## Requirements

- Node.js 18+
- [Kernel](https://kernel.sh) account (stealth browsers + bot detection bypass) — or local Playwright
- Kernel CLI: `npm install -g @onkernel/cli`
- Kernel Managed Auth sessions for LinkedIn and Wellfound
- Kernel residential proxy (US recommended)
- Telegram bot for notifications

## Setup

### 1. Install

```bash
git clone https://github.com/MattJackson/claw-apply.git
cd claw-apply
npm install
```

### 2. Create Kernel browser sessions

```bash
# Create residential proxy
kernel proxies create --type residential --country US --name "claw-apply-proxy"

# Create authenticated browser profiles
kernel auth create --name "LinkedIn-YourName"
kernel auth create --name "WellFound-YourName"
```

### 3. Configure

Copy example configs and fill in your values:

```bash
cp config/settings.example.json config/settings.json
cp config/profile.example.json config/profile.json
cp config/search_config.example.json config/search_config.json
```

- **`profile.json`** — name, email, phone, resume path, work authorization, salary
- **`search_config.json`** — keywords, platforms, filters, exclusions
- **`settings.json`** — Telegram bot token, Kernel profile names, proxy ID, run caps

### 4. Verify

```bash
KERNEL_API_KEY=your_key node setup.mjs
```

### 5. Run

```bash
KERNEL_API_KEY=your_key node job_searcher.mjs            # search now
KERNEL_API_KEY=your_key node job_applier.mjs --preview   # preview queue
KERNEL_API_KEY=your_key node job_applier.mjs             # apply now
```

### 6. Schedule (via OpenClaw or cron)

```
Search: 0 * * * *       (hourly)
Apply:  0 */6 * * *     (every 6 hours)
```

## How it works

**Search** — runs your keyword searches on LinkedIn and Wellfound, paginates/scrolls through results, filters exclusions, deduplicates, and queues new jobs.

**Apply** — picks up queued jobs, opens stealth browser sessions, fills forms using your profile + learned answers, and submits. Detects and skips honeypots, recruiter-only listings, and external ATS. Retries failed jobs automatically (default 2 retries).

**Learn** — on unknown questions, messages you on Telegram. You reply, the answer is saved to `answers.json` with regex pattern matching, and the job is retried next run.

## File structure

```
claw-apply/
├── job_searcher.mjs           Search agent
├── job_applier.mjs            Apply agent
├── setup.mjs                  Setup wizard
├── lib/
│   ├── constants.mjs          Shared constants
│   ├── browser.mjs            Kernel/Playwright browser factory
│   ├── form_filler.mjs        Form filling with pattern matching
│   ├── linkedin.mjs           LinkedIn search + Easy Apply
│   ├── wellfound.mjs          Wellfound search + apply
│   ├── queue.mjs              Job queue + config management
│   └── notify.mjs             Telegram notifications
├── config/
│   ├── *.example.json         Templates (committed)
│   └── *.json                 Your config (gitignored)
└── data/
    ├── jobs_queue.json         Job queue (auto-managed)
    └── applications_log.json   History (auto-managed)
```

## answers.json — self-learning Q&A

When the applier can't answer a question, it messages you. Your reply is saved and reused:

```json
[
  { "pattern": "quota attainment", "answer": "1.12" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "1.*10.*scale", "answer": "9" }
]
```

Patterns are matched case-insensitively and support regex.
