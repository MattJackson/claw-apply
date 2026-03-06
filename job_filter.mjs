#!/usr/bin/env node
import { loadEnv } from './lib/env.mjs';
loadEnv();

/**
 * job_filter.mjs — claw-apply AI Job Filter (Anthropic Batch API)
 *
 * Runs in two phases on each invocation:
 *
 * Phase 1 — COLLECT: if a batch is in flight, check status + download results
 * Phase 2 — SUBMIT:  if no batch pending, find unscored jobs + submit a new batch
 *
 * Designed to run hourly via cron. Safe to run anytime — idempotent.
 *
 * Usage:
 *   node job_filter.mjs           — normal run (collect if pending, else submit)
 *   node job_filter.mjs --stats   — show filter stats only
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));

import { getJobsByStatus, updateJobStatus, loadConfig, loadQueue } from './lib/queue.mjs';
import { loadProfile, submitBatch, checkBatch, downloadResults } from './lib/filter.mjs';
import { sendTelegram } from './lib/notify.mjs';

const isStats = process.argv.includes('--stats');

const STATE_PATH = resolve(__dir, 'data/filter_state.json');
const DEFAULT_MODEL = 'claude-sonnet-4-6-20251101';

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function clearState() {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function showStats() {
  const queue = loadQueue();
  const byStatus = {};
  for (const j of queue) byStatus[j.status] = (byStatus[j.status] || 0) + 1;

  const filtered = queue.filter(j => j.status === 'filtered');
  const scored = queue.filter(j => j.filter_score != null);

  console.log('📊 Filter Stats\n');
  console.log(`  New (unfiltered):   ${byStatus['new'] || 0}`);
  console.log(`  Filtered (blocked): ${byStatus['filtered'] || 0}`);
  console.log(`  Total scored:       ${scored.length}`);
  console.log(`  Pass rate:          ${scored.length > 0 ? Math.round((scored.filter(j => j.status !== 'filtered').length / scored.length) * 100) : 0}%\n`);

  const state = readState();
  if (state) {
    console.log(`  Pending batch: ${state.batch_id}`);
    console.log(`  Submitted:     ${state.submitted_at}`);
    console.log(`  Job count:     ${state.job_count}\n`);
  }

  if (filtered.length > 0) {
    console.log('Sample filtered:');
    filtered.slice(0, 10).forEach(j =>
      console.log(`  [${j.filter_score}/10] ${j.title} @ ${j.company} — ${j.filter_reason}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Collect results from a pending batch
// ---------------------------------------------------------------------------

async function collect(state, settings) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log(`🔍 Checking batch ${state.batch_id}...`);

  const { status, counts } = await checkBatch(state.batch_id, apiKey);

  if (status === 'in_progress') {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const done = (counts.succeeded || 0) + (counts.errored || 0) + (counts.canceled || 0) + (counts.expired || 0);
    console.log(`  Still processing — ${done}/${total} complete. Check back later.`);
    return;
  }

  console.log(`  Batch ended. Downloading results...`);
  const results = await downloadResults(state.batch_id, apiKey, state.id_map || {});

  const searchConfig = loadConfig(resolve(__dir, 'config/search_config.json'));
  const globalMin = searchConfig.filter_min_score ?? 5;

  let passed = 0, filtered = 0, errors = 0;

  // Build a lookup map from results for O(1) access
  const resultMap = {};
  for (const r of results) resultMap[r.jobId] = r;

  // Load queue once, apply all updates in memory, save once
  const queue = loadQueue();
  const now = new Date().toISOString();

  for (const job of queue) {
    const r = resultMap[job.id];
    if (!r) continue;

    if (r.error || r.score === null) {
      errors++;
      job.filter_score = null;
      job.filter_reason = r.reason || 'filter_error';
      job.status_updated_at = now;
      continue;
    }

    const track = job.track || 'ae';
    const searchEntry = (searchConfig.searches || []).find(s => s.track === track);
    const minScore = searchEntry?.filter_min_score ?? globalMin;

    job.filter_score = r.score;
    job.filter_reason = r.reason;
    job.status_updated_at = now;

    if (r.score >= minScore) {
      passed++;
      // keep status as 'new'
    } else {
      filtered++;
      job.status = 'filtered';
    }
  }

  // Single write for all 4,652 updates
  const { saveQueue } = await import('./lib/queue.mjs');
  saveQueue(queue);

  clearState();

  // Append to filter run history
  const runsPath = resolve(__dir, 'data/filter_runs.json');
  const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, 'utf8')) : [];
  runs.push({
    batch_id: state.batch_id,
    submitted_at: state.submitted_at,
    collected_at: new Date().toISOString(),
    job_count: state.job_count,
    model: state.model,
    passed,
    filtered,
    errors,
  });
  writeFileSync(runsPath, JSON.stringify(runs, null, 2));

  const summary = `✅ Filter complete — ${passed} passed, ${filtered} filtered, ${errors} errors`;
  console.log(`\n${summary}`);

  // Notify via Telegram
  await sendTelegram(settings,
    `🔍 *AI Filter complete*\n✅ Passed: ${passed}\n🚫 Filtered: ${filtered}\n⚠️ Errors: ${errors}`
  ).catch(() => {}); // non-fatal
}

// ---------------------------------------------------------------------------
// Phase 2 — Submit a new batch
// ---------------------------------------------------------------------------

async function submit(settings, searchConfig, candidateProfile) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Get all new jobs that haven't been scored yet
  const jobs = getJobsByStatus('new').filter(j => j.filter_score == null);

  if (jobs.length === 0) {
    console.log('✅ Nothing to filter — all new jobs already scored.');
    return;
  }

  // Build job profiles map by track
  const profilePaths = settings.filter?.job_profiles || {};
  const jobProfilesByTrack = {};
  for (const [track, path] of Object.entries(profilePaths)) {
    const profile = loadProfile(path);
    if (profile) jobProfilesByTrack[track] = profile;
    else console.warn(`⚠️  Could not load job profile for track "${track}" at ${path}`);
  }

  // Filter out jobs with no profile (will pass through unscored)
  const filterable = jobs.filter(j => jobProfilesByTrack[j.track || 'ae']);
  const noProfile = jobs.length - filterable.length;

  if (noProfile > 0) console.warn(`⚠️  ${noProfile} jobs skipped — no profile for their track`);

  if (filterable.length === 0) {
    console.log('Nothing filterable — no job profiles configured for any track.');
    return;
  }

  const model = settings.filter?.model || DEFAULT_MODEL;
  console.log(`🚀 Submitting batch — ${filterable.length} jobs, model: ${model}`);

  const { batchId, idMap } = await submitBatch(filterable, jobProfilesByTrack, searchConfig, candidateProfile, model, apiKey);

  const submittedAt = new Date().toISOString();
  writeState({
    batch_id: batchId,
    submitted_at: submittedAt,
    job_count: filterable.length,
    model,
    tracks: Object.keys(jobProfilesByTrack),
    id_map: idMap,
  });

  console.log(`  Batch submitted: ${batchId}`);
  console.log(`  Results typically ready in < 1 hour. Next run will collect.`);

  // Notify
  await sendTelegram(settings,
    `🔍 *AI Filter submitted*\n${filterable.length} jobs queued for scoring\nBatch: \`${batchId}\``
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (isStats) {
    showStats();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const searchConfig = loadConfig(resolve(__dir, 'config/search_config.json'));
  const candidateProfile = loadConfig(resolve(__dir, 'config/profile.json'));

  console.log('🔍 claw-apply: AI Job Filter\n');

  const state = readState();

  if (state?.batch_id) {
    // Phase 1: collect results from pending batch
    await collect(state, settings);
  } else {
    // Phase 2: submit new batch
    await submit(settings, searchConfig, candidateProfile);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
