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

function readLastRun(name) {
  const path = resolve(__dir, `data/${name}_last_run.json`);
  return readJson(path);
}

function buildSearchProgress() {
  const sp = readJson(resolve(__dir, 'data/search_progress.json'));
  if (!sp) return null;

  // Build unique track list from completed + keyword_progress, prefer platform-specific key
  const seen = new Set();
  const tracks = [];

  const allKeys = [
    ...(sp.completed || []),
    ...Object.keys(sp.keyword_progress || {}),
    ...Object.keys(sp.keywords || {}),
  ];

  for (const key of allKeys) {
    const [platform, ...trackParts] = key.split(':');
    const trackName = trackParts.join(':');
    if (seen.has(trackName)) continue;
    seen.add(trackName);

    const keywords = sp.keywords?.[key] || [];
    const lastDone = sp.keyword_progress?.[key] ?? -1;
    const complete = (sp.completed || []).includes(key);

    tracks.push({
      platform, track: trackName,
      total: keywords.length,
      done: complete ? keywords.length : Math.max(0, lastDone + 1),
      complete,
    });
  }
  return tracks;
}

function buildStatus() {
  const queue = readJson(resolve(__dir, 'data/jobs_queue.json')) || [];
  const log   = readJson(resolve(__dir, 'data/applications_log.json')) || [];

  // Queue breakdown
  const byStatus = {};
  const byPlatform = {};
  const atsCounts = {};

  const byApplyType = {};
  for (const job of queue) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    byPlatform[job.platform] = (byPlatform[job.platform] || 0) + 1;
    if (job.status === 'new' && job.apply_type) {
      byApplyType[job.apply_type] = (byApplyType[job.apply_type] || 0) + 1;
    }
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

  const searcherLastRun = readLastRun('searcher');
  const applierLastRun  = readLastRun('applier');
  const searchProgress  = buildSearchProgress();

  return {
    searcher: {
      running: isRunning('searcher'),
      last_run: searcherLastRun,
      keyword_progress: searchProgress,
    },
    applier: {
      running: isRunning('applier'),
      last_run: applierLastRun,
    },
    queue: {
      total: queue.length,
      new: byStatus['new'] || 0,
      filtered: byStatus['filtered'] || 0,
      applied: byStatus['applied'] || 0,
      failed: byStatus['failed'] || 0,
      needs_answer: byStatus['needs_answer'] || 0,
      skipped_external: byStatus['skipped_external_unsupported'] || 0,
      skipped_recruiter: byStatus['skipped_recruiter_only'] || 0,
      skipped_no_apply: (byStatus['skipped_easy_apply_unsupported'] || 0) + (byStatus['skipped_no_apply'] || 0),
      skipped_other: (byStatus['skipped_honeypot'] || 0) + (byStatus['stuck'] || 0) + (byStatus['incomplete'] || 0),
      already_applied: byStatus['already_applied'] || 0,
      by_platform: byPlatform,
    },
    ats_breakdown: atsCounts,
    apply_type_breakdown: byApplyType,
    last_applied: lastApplied ? {
      title: lastApplied.title,
      company: lastApplied.company,
      platform: lastApplied.platform,
      at: lastApplied.applied_at,
    } : null,
    log_total: log.length,
  };
}

function timeAgo(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatReport(s) {
  const q = s.queue;

  // Searcher section
  const sr = s.searcher;
  const searcherLine = sr.running
    ? `🔄 Running now — ${q.total} jobs found so far`
    : sr.last_run?.finished === false
      ? `⚠️  Last run interrupted ${timeAgo(sr.last_run?.started_at)} (partial results saved)`
      : `⏸️  Last ran ${timeAgo(sr.last_run?.finished_at)}`;
  const lastRunDetail = sr.last_run && !sr.running
    ? `  Found ${sr.last_run.added} new jobs (${sr.last_run.seen} seen, ${sr.last_run.skipped_dupes || 0} dupes)`
    : null;

  // Applier section
  const ar = s.applier;
  const applierLine = ar.running
    ? `🔄 Running now`
    : `⏸️  Last ran ${timeAgo(ar.last_run?.finished_at)}`;
  const lastApplierDetail = ar.last_run && !ar.running
    ? `  Applied ${ar.last_run.submitted} jobs in that run`
    : null;

  const lines = [
    `📊 *claw-apply Status*`,
    ``,
    `🔍 *Searcher:* ${searcherLine}`,
  ];
  if (lastRunDetail) lines.push(lastRunDetail);

  // Keyword progress grouped by platform
  const kp = s.searcher.keyword_progress;
  if (kp && kp.length > 0) {
    const byPlatform = {};
    for (const t of kp) {
      if (!byPlatform[t.platform]) byPlatform[t.platform] = [];
      byPlatform[t.platform].push(t);
    }
    for (const [platform, tracks] of Object.entries(byPlatform)) {
      lines.push(`  ${platform.charAt(0).toUpperCase() + platform.slice(1)}:`);
      for (const t of tracks) {
        const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
        const bar = t.complete ? '✅ done' : `${t.done}/${t.total} keywords (${pct}%)`;
        lines.push(`    • ${t.track}: ${bar}`);
      }
    }
  }

  lines.push(`🚀 *Applier:* ${applierLine}`);
  if (lastApplierDetail) lines.push(lastApplierDetail);

  lines.push(
    ``,
    `📋 *Queue — ${q.total} total jobs*`,
    `  🆕 Ready to apply:      ${q.new}`,
  );

  if (s.apply_type_breakdown && Object.keys(s.apply_type_breakdown).length > 0) {
    const sorted = Object.entries(s.apply_type_breakdown).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      lines.push(`      • ${type}: ${count}`);
    }
  }

  lines.push(
    `  🚫 AI filtered:         ${q.filtered || 0}`,
    `  ✅ Applied:             ${q.applied}`,
    `  🔁 Already applied:     ${q.already_applied || 0}`,
    `  💬 Needs your answer:   ${q.needs_answer}`,
    `  ❌ Failed:              ${q.failed}`,
    `  🚫 Recruiter-only:      ${q.skipped_recruiter}`,
    `  ⏭️  No apply button:     ${q.skipped_no_apply}`,
    `  ⚠️  Other skips:         ${q.skipped_other || 0}`,
    `  🌐 External ATS:        ${q.skipped_external}`,
  );

  if (Object.keys(s.ats_breakdown).length > 0) {
    const sorted = Object.entries(s.ats_breakdown).sort((a, b) => b[1] - a[1]);
    lines.push(``, `🌐 *External ATS — ${q.skipped_external} jobs (saved for later):*`);
    for (const [platform, count] of sorted) {
      lines.push(`  • ${platform}: ${count}`);
    }
  }

  if (s.last_applied) {
    const la = s.last_applied;
    const when = la.at ? timeAgo(la.at) : 'unknown';
    lines.push(``, `📬 *Last applied:* ${la.title} @ ${la.company} — ${when}`);
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
