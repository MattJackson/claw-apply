#!/usr/bin/env node
/**
 * status.mjs — claw-apply status report
 * Outputs structured JSON for agent formatting
 * Run: node status.mjs [--json]
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const jsonMode = process.argv.includes('--json');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isRunning(name) {
  const lockPath = resolve(__dir, `data/${name}.lock`);
  if (!existsSync(lockPath)) return false;
  const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function buildStatus() {
  const queue = readJson(resolve(__dir, 'data/jobs_queue.json')) || [];
  const log   = readJson(resolve(__dir, 'data/applications_log.json')) || [];

  // Queue breakdown
  const byStatus = {};
  const byPlatform = {};
  const atsCounts = {};

  for (const job of queue) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    byPlatform[job.platform] = (byPlatform[job.platform] || 0) + 1;
    if (job.status === 'skipped_external_unsupported' && job.ats_platform) {
      atsCounts[job.ats_platform] = (atsCounts[job.ats_platform] || 0) + 1;
    }
  }

  // From log too
  for (const entry of log) {
    if (entry.status === 'skipped_external_unsupported' && entry.ats_platform) {
      atsCounts[entry.ats_platform] = (atsCounts[entry.ats_platform] || 0) + 1;
    }
  }

  // Last applied
  const applied = [...queue, ...log].filter(j => j.status === 'applied')
    .sort((a, b) => (b.applied_at || 0) - (a.applied_at || 0));
  const lastApplied = applied[0] || null;

  return {
    searcher: {
      running: isRunning('searcher'),
    },
    applier: {
      running: isRunning('applier'),
    },
    queue: {
      total: queue.length,
      new: byStatus['new'] || 0,
      applied: byStatus['applied'] || 0,
      failed: byStatus['failed'] || 0,
      needs_answer: byStatus['needs_answer'] || 0,
      skipped_external: byStatus['skipped_external_unsupported'] || 0,
      skipped_recruiter: byStatus['skipped_recruiter_only'] || 0,
      skipped_no_easy_apply: byStatus['skipped_easy_apply_unsupported'] || 0,
      by_platform: byPlatform,
    },
    ats_breakdown: atsCounts,
    last_applied: lastApplied ? {
      title: lastApplied.title,
      company: lastApplied.company,
      platform: lastApplied.platform,
      at: lastApplied.applied_at,
    } : null,
    log_total: log.length,
  };
}

function formatReport(s) {
  const q = s.queue;
  const searcherStatus = s.searcher.running ? '🔄 Running now' : '⏸️  Idle';
  const applierStatus  = s.applier.running  ? '🔄 Running now' : '⏸️  Idle';

  const lines = [
    `📊 *claw-apply Status*`,
    ``,
    `🔍 *Searcher:* ${searcherStatus}`,
    `🚀 *Applier:* ${applierStatus}`,
    ``,
    `📋 *Queue — ${q.total} total jobs*`,
    `  🆕 New (pending):       ${q.new}`,
    `  ✅ Applied:             ${q.applied}`,
    `  💬 Needs your answer:   ${q.needs_answer}`,
    `  ❌ Failed:              ${q.failed}`,
    `  🚫 Recruiter-only:      ${q.skipped_recruiter}`,
    `  ⏭️  No Easy Apply:       ${q.skipped_no_easy_apply}`,
    `  🌐 External ATS:        ${q.skipped_external}`,
  ];

  if (Object.keys(s.ats_breakdown).length > 0) {
    const sorted = Object.entries(s.ats_breakdown).sort((a, b) => b[1] - a[1]);
    lines.push(``, `🌐 *ATS Breakdown:*`);
    for (const [platform, count] of sorted) {
      lines.push(`  • ${platform}: ${count}`);
    }
  }

  if (s.last_applied) {
    const la = s.last_applied;
    const when = la.at ? new Date(la.at).toLocaleString() : 'unknown time';
    lines.push(``, `📬 *Last applied:* ${la.title} @ ${la.company} (${la.platform}) — ${when}`);
  } else {
    lines.push(``, `📬 *Last applied:* None yet`);
  }

  return lines.join('\n');
}

const status = buildStatus();

if (jsonMode) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(formatReport(status));
}
