---
name: claw-apply
description: Automated job search and application for LinkedIn and Wellfound. Searches for matching roles hourly, applies automatically every 6 hours using Playwright + Kernel stealth browsers. Handles LinkedIn Easy Apply multi-step modals and Wellfound applications. Self-learning — asks you via Telegram when it hits an unknown question, saves your answer, and never asks again. Retries failed applications automatically. Preview mode lets you review the queue before applying.
---

# claw-apply

Automated job search and application. Finds matching roles on LinkedIn and Wellfound, applies automatically, and learns from every unknown question.

## Requirements

- Node.js 18+
- [Kernel](https://kernel.sh) account — stealth browsers + bot detection bypass (required; local Playwright will be blocked)
- Kernel CLI: `npm install -g @onkernel/cli`
- Telegram bot for notifications ([BotFather](https://t.me/BotFather))
- Anthropic API key (optional — enables AI-enhanced keyword generation)
- OpenClaw (optional — enables auto-scheduling via `setup.mjs`)

## Setup

### 1. Install

```bash
git clone https://github.com/MattJackson/claw-apply.git
cd claw-apply
npm install
```

### 2. Kernel: proxy + auth sessions

```bash
# Log in to Kernel
kernel login

# Create a residential proxy (US recommended for LinkedIn/Wellfound)
kernel proxies create --type residential --country US --name "claw-apply-proxy"
# Note the proxy ID from output

# Create managed auth connections (one per platform)
kernel auth connections create --profile-name "LinkedIn-YourName" --domain linkedin.com
# Note the connection ID from output

kernel auth connections create --profile-name "WellFound-YourName" --domain wellfound.com
# Note the connection ID from output

# Trigger initial login flows (opens a browser URL to complete auth)
kernel auth connections login <linkedin-connection-id>
kernel auth connections login <wellfound-connection-id>
```

### 3. Configure

```bash
cp config/settings.example.json config/settings.json
cp config/profile.example.json config/profile.json
cp config/search_config.example.json config/search_config.json
```

**`settings.json`** — fill in:
- `notifications.telegram_user_id` — your Telegram user ID
- `notifications.bot_token` — Telegram bot token from BotFather
- `kernel.proxy_id` — proxy ID from step 2
- `kernel.profiles.linkedin` — profile name e.g. `LinkedIn-YourName`
- `kernel.profiles.wellfound` — profile name e.g. `WellFound-YourName`
- `kernel.connection_ids.linkedin` — connection ID from step 2
- `kernel.connection_ids.wellfound` — connection ID from step 2

**`profile.json`** — your name, email, phone, resume path, work authorization, salary targets

**`search_config.json`** — keywords, platforms, location filters, salary filters, exclusions

### 4. Verify

```bash
export KERNEL_API_KEY=your_kernel_api_key
export ANTHROPIC_API_KEY=your_anthropic_api_key   # optional, for AI keywords

node setup.mjs
```

Setup will:
- Validate all config files
- Send a Telegram test message
- Test LinkedIn + Wellfound logins
- Auto-register cron jobs (if `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` are set)

### 5. Run manually

```bash
node job_searcher.mjs            # search now
node job_applier.mjs --preview   # preview queue without applying
node job_applier.mjs             # apply now
node status.mjs                  # show queue + run status
```

### 6. Schedule

**Via OpenClaw** — set env vars before running `setup.mjs`:
```bash
export OPENCLAW_GATEWAY_URL=http://localhost:3000
export OPENCLAW_GATEWAY_TOKEN=your_gateway_token
node setup.mjs   # registers crons automatically
```

Crons registered:
- **Searcher**: `0 * * * *` (hourly), no timeout, enabled by default
- **Applier**: `0 */6 * * *` (every 6h), no timeout, **disabled by default** — enable when ready

**Via system cron** — add to crontab:
```
0 * * * * cd /path/to/claw-apply && KERNEL_API_KEY=xxx node job_searcher.mjs >> /tmp/searcher.log 2>&1
0 */6 * * * cd /path/to/claw-apply && KERNEL_API_KEY=xxx node job_applier.mjs >> /tmp/applier.log 2>&1
```

## How it works

**Search** — runs your keyword searches on LinkedIn and Wellfound, paginates through results, inline-classifies each job (Easy Apply vs external ATS), filters exclusions, deduplicates, and queues new jobs. First run searches 90 days back; subsequent runs search 2 days.

**Apply** — picks up queued jobs sorted by priority (Easy Apply first), opens stealth browser sessions, fills forms using your profile + learned answers, and submits. Auto-refreshes Kernel auth sessions if login expires. Retries failed jobs (default 2 retries).

**Learn** — on unknown questions, messages you on Telegram. You reply, the answer is saved to `answers.json` with regex pattern matching, and the job is retried next run.

**Lockfile** — prevents parallel runs. If searcher is running, a second invocation exits immediately.

## File structure

```
claw-apply/
├── job_searcher.mjs           Search agent
├── job_applier.mjs            Apply agent
├── setup.mjs                  Setup wizard + cron registration
├── status.mjs                 Queue + run status report
├── lib/
│   ├── browser.mjs            Kernel stealth browser factory
│   ├── session.mjs            Auth session refresh via Kernel API
│   ├── linkedin.mjs           LinkedIn search + Easy Apply
│   ├── wellfound.mjs          Wellfound search + apply
│   ├── form_filler.mjs        Form filling with pattern matching
│   ├── queue.mjs              Job queue + config management
│   ├── keywords.mjs           AI-enhanced keyword generation
│   ├── lock.mjs               PID lockfile + graceful shutdown
│   ├── notify.mjs             Telegram notifications
│   ├── search_progress.mjs    Per-platform search resume tracking
│   ├── constants.mjs          Shared constants + ATS patterns
│   └── apply/
│       ├── index.mjs          Handler registry
│       ├── easy_apply.mjs     LinkedIn Easy Apply (full)
│       ├── wellfound.mjs      Wellfound apply (full)
│       ├── greenhouse.mjs     Greenhouse (stub)
│       ├── lever.mjs          Lever (stub)
│       ├── workday.mjs        Workday (stub)
│       ├── ashby.mjs          Ashby (stub)
│       └── jobvite.mjs        Jobvite (stub)
├── config/
│   ├── *.example.json         Templates (committed)
│   └── *.json                 Your config (gitignored)
└── data/                      Runtime data (gitignored, auto-managed)
```

## answers.json — self-learning Q&A

When the applier can't answer a question, it messages you on Telegram. Your reply is saved and reused forever:

```json
[
  { "pattern": "quota attainment", "answer": "1.12" },
  { "pattern": "years.*enterprise", "answer": "5" },
  { "pattern": "1.*10.*scale", "answer": "9" }
]
```

Patterns are matched case-insensitively and support regex. First match wins.

## ATS support

| Platform | Status |
|---|---|
| LinkedIn Easy Apply | ✅ Full |
| Wellfound | ✅ Full |
| Greenhouse | 🚧 Stub |
| Lever | 🚧 Stub |
| Workday | 🚧 Stub |
| Ashby | 🚧 Stub |
| Jobvite | 🚧 Stub |

External ATS jobs are queued and classified — stubs will be promoted to full implementations based on usage data.
