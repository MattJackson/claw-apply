#!/usr/bin/env node
import { loadEnv } from './lib/env.mjs';
loadEnv();

/**
 * job_filter.mjs — claw-apply AI Job Filter
 * Scores all queued 'new' jobs 0-10 against candidate profile using Claude Haiku
 * Jobs below filter_min_score (default 5, configurable per-search in search_config.json)
 * are marked 'filtered' and skipped by the applier
 *
 * Usage:
 *   node job_filter.mjs           — filter all new jobs
 *   node job_filter.mjs --dry-run — score without writing status changes
 *   node job_filter.mjs --stats   — show filter stats only (no re-filter)
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

import { getJobsByStatus, updateJobStatus, loadConfig } from './lib/queue.mjs';
import { acquireLock } from './lib/lock.mjs';
import { runFilter } from './lib/filter.mjs';

const isDryRun = process.argv.includes('--dry-run');
const isStats = process.argv.includes('--stats');

async function showStats() {
  const all = getJobsByStatus(['new', 'filtered']);
  const filtered = all.filter(j => j.status === 'filtered');
  const scored = all.filter(j => j.filter_score != null);

  console.log(`📊 Filter Stats\n`);
  console.log(`  Filtered (blocked): ${filtered.length}`);
  console.log(`  New (passed/unscored): ${all.length - filtered.length}`);
  console.log(`  Total scored: ${scored.length}\n`);

  if (filtered.length > 0) {
    console.log(`Sample filtered jobs:`);
    filtered.slice(0, 10).forEach(j => {
      console.log(`  [${j.filter_score}/10] ${j.title} @ ${j.company} — ${j.filter_reason}`);
    });
  }
}

async function main() {
  if (isStats) {
    await showStats();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY not set — filter requires Anthropic API');
    process.exit(1);
  }

  const lock = acquireLock('filter', resolve(__dir, 'data'));

  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const searchConfig = loadConfig(resolve(__dir, 'config/search_config.json'));
  const candidateProfile = loadConfig(resolve(__dir, 'config/profile.json'));

  const jobs = getJobsByStatus('new');
  const globalMin = searchConfig.filter_min_score ?? 5;

  console.log(`🔍 claw-apply: AI Job Filter${isDryRun ? ' (DRY RUN)' : ''}\n`);
  console.log(`  Jobs to score: ${jobs.length}`);
  console.log(`  Default threshold: ${globalMin}/10\n`);

  if (jobs.length === 0) {
    console.log('Nothing to filter.');
    return;
  }

  let passed = 0, filtered = 0, errors = 0;
  const filterLog = [];

  const results = await runFilter(jobs, searchConfig, settings, candidateProfile, apiKey, {
    onProgress: (done, total, track) => {
      process.stdout.write(`\r  [${track}] ${done}/${total} scored...`);
    }
  });

  console.log('\n');

  for (const { job, score, reason, pass, minScore } of results) {
    if (score === null) {
      errors++;
      continue;
    }

    filterLog.push({ id: job.id, title: job.title, company: job.company, score, reason, pass, minScore });

    if (pass) {
      passed++;
      if (!isDryRun) {
        updateJobStatus(job.id, 'new', { filter_score: score, filter_reason: reason });
      }
    } else {
      filtered++;
      if (!isDryRun) {
        updateJobStatus(job.id, 'filtered', { filter_score: score, filter_reason: reason });
      }
    }
  }

  console.log(`✅ Filter complete${isDryRun ? ' (no changes written)' : ''}`);
  console.log(`  ✅ Passed:   ${passed}`);
  console.log(`  🚫 Filtered: ${filtered}`);
  console.log(`  ⚠️  Errors:   ${errors} (passed through)`);
  console.log(`  📊 Pass rate: ${jobs.length > 0 ? Math.round((passed / jobs.length) * 100) : 0}%\n`);

  if (isDryRun && filterLog.length > 0) {
    console.log(`Sample scores:`);
    filterLog.slice(0, 20).forEach(j => {
      const icon = j.pass ? '✅' : '🚫';
      console.log(`  ${icon} [${j.score}/10] ${j.title} @ ${j.company} — ${j.reason}`);
    });
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
