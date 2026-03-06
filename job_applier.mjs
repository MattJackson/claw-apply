#!/usr/bin/env node
import { loadEnv } from './lib/env.mjs';
loadEnv(); // load .env before anything else
/**
 * job_applier.mjs — claw-apply Job Applier
 * Reads jobs queue and applies using the appropriate handler per apply_type
 * Run via cron or manually: node job_applier.mjs [--preview]
 */
import { existsSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

import { getJobsByStatus, updateJobStatus, appendLog, loadConfig, isAlreadyApplied } from './lib/queue.mjs';
import { acquireLock } from './lib/lock.mjs';
import { createBrowser } from './lib/browser.mjs';
import { FormFiller } from './lib/form_filler.mjs';
import { applyToJob, supportedTypes } from './lib/apply/index.mjs';
import { sendTelegram, formatApplySummary } from './lib/notify.mjs';
import { generateAnswer } from './lib/ai_answer.mjs';
import {
  APPLY_BETWEEN_DELAY_BASE, APPLY_BETWEEN_DELAY_JITTER, DEFAULT_MAX_RETRIES,
  APPLY_RUN_TIMEOUT_MS, PER_JOB_TIMEOUT_MS
} from './lib/constants.mjs';

const DEFAULT_ENABLED_APPLY_TYPES = ['easy_apply'];

const isPreview = process.argv.includes('--preview');

// Priority order — Easy Apply first, then by ATS volume (data-driven later)
const APPLY_PRIORITY = ['easy_apply', 'wellfound', 'greenhouse', 'lever', 'ashby', 'workday', 'jobvite', 'unknown_external'];

async function main() {
  const lock = acquireLock('applier', resolve(__dir, 'data'));

  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const profile = loadConfig(resolve(__dir, 'config/profile.json'));
  const answersPath = resolve(__dir, 'config/answers.json');
  const answers = existsSync(answersPath) ? loadConfig(answersPath) : [];
  const formFiller = new FormFiller(profile, answers);
  const maxApps = settings.max_applications_per_run || Infinity;
  const maxRetries = settings.max_retries ?? DEFAULT_MAX_RETRIES;
  const enabledTypes = settings.enabled_apply_types || DEFAULT_ENABLED_APPLY_TYPES;
  const apiKey = process.env.ANTHROPIC_API_KEY || settings.anthropic_api_key;

  const startedAt = Date.now();
  const results = {
    submitted: 0, failed: 0, needs_answer: 0, total: 0,
    skipped_recruiter: 0, skipped_external: 0, skipped_no_apply: 0, skipped_other: 0,
    already_applied: 0, atsCounts: {}
  };

  lock.onShutdown(() => {
    writeFileSync(resolve(__dir, 'data/applier_last_run.json'), JSON.stringify({
      started_at: startedAt, finished_at: null, finished: false, ...results
    }, null, 2));
  });

  console.log('🚀 claw-apply: Job Applier starting\n');
  console.log(`Supported apply types: ${supportedTypes().join(', ')}\n`);

  // Preview mode
  if (isPreview) {
    const newJobs = getJobsByStatus('new');
    if (newJobs.length === 0) { console.log('No new jobs in queue.'); return; }
    console.log(`📋 ${newJobs.length} job(s) queued:\n`);
    for (const j of newJobs) {
      console.log(`  • [${j.apply_type || 'unclassified'}] ${j.title} @ ${j.company || '?'}`);
    }
    return;
  }

  // Get + sort jobs — only enabled apply types
  const allJobs = getJobsByStatus(['new', 'needs_answer'])
    .filter(j => enabledTypes.includes(j.apply_type))
    .sort((a, b) => {
      const ap = APPLY_PRIORITY.indexOf(a.apply_type ?? 'unknown_external');
      const bp = APPLY_PRIORITY.indexOf(b.apply_type ?? 'unknown_external');
      return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    });
  const jobs = allJobs.slice(0, maxApps);
  console.log(`Enabled types: ${enabledTypes.join(', ')}\n`);
  results.total = jobs.length;

  if (jobs.length === 0) { console.log('Nothing to apply to. Run job_searcher.mjs first.'); return; }

  // Print breakdown
  const typeCounts = jobs.reduce((acc, j) => {
    acc[j.apply_type || 'unclassified'] = (acc[j.apply_type || 'unclassified'] || 0) + 1;
    return acc;
  }, {});
  console.log(`📋 ${jobs.length} jobs to process:`);
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`  • ${type}: ${count}`);
  }
  console.log('');

  // Group by platform to share browser sessions
  const byPlatform = {};
  for (const job of jobs) {
    const platform = job.apply_type === 'easy_apply' ? 'linkedin'
      : job.platform === 'wellfound' || job.apply_type === 'wellfound' ? 'wellfound'
      : 'external'; // Greenhouse, Lever etc. — no auth needed
    if (!byPlatform[platform]) byPlatform[platform] = [];
    byPlatform[platform].push(job);
  }

  // Process each platform group
  for (const [platform, platformJobs] of Object.entries(byPlatform)) {
    console.log(`\n--- ${platform.toUpperCase()} (${platformJobs.length} jobs) ---\n`);
    let browser;
    try {
      // LinkedIn and Wellfound need authenticated sessions; external ATS uses plain browser
      if (platform === 'external') {
        browser = await createBrowser(settings, null); // no profile needed
      } else {
        browser = await createBrowser(settings, platform);
        console.log('  ✅ Logged in\n');
      }

      for (const job of platformJobs) {
        if (isAlreadyApplied(job.id)) {
          console.log(`  ⏭️  Already applied — ${job.title} @ ${job.company || '?'}`);
          updateJobStatus(job.id, 'already_applied', {});
          results.already_applied++;
          continue;
        }

        console.log(`  → [${job.apply_type}] ${job.title} @ ${job.company || '?'}`);

        // Check overall run timeout
        if (Date.now() - startedAt > APPLY_RUN_TIMEOUT_MS) {
          console.log(`  ⏱️  Run timeout (${Math.round(APPLY_RUN_TIMEOUT_MS / 60000)}min) — stopping`);
          break;
        }

        try {
          // Per-job timeout — prevents a single hung browser from blocking the run
          const result = await Promise.race([
            applyToJob(browser.page, job, formFiller),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Job apply timed out')), PER_JOB_TIMEOUT_MS)),
          ]);
          await handleResult(job, result, results, settings, profile, apiKey);
        } catch (e) {
          console.error(`    ❌ Error: ${e.message}`);
          if (e.stack) console.error(`    Stack: ${e.stack.split('\n').slice(1, 3).join(' | ').trim()}`);
          const retries = (job.retry_count || 0) + 1;
          if (retries <= maxRetries) {
            updateJobStatus(job.id, 'new', { retry_count: retries });
          } else {
            updateJobStatus(job.id, 'failed', { error: e.message });
            appendLog({ ...job, status: 'failed', error: e.message });
            results.failed++;
          }
        }

        // Delay between applications
        await new Promise(r => setTimeout(r, APPLY_BETWEEN_DELAY_BASE + Math.random() * APPLY_BETWEEN_DELAY_JITTER));
      }
    } catch (e) {
      console.error(`  ❌ Browser error for ${platform}: ${e.message}`);
      if (e.stack) console.error(`  Stack: ${e.stack.split('\n').slice(1, 3).join(' | ').trim()}`);
    } finally {
      await browser?.browser?.close().catch(() => {});
    }
  }

  // Final summary + Telegram
  const summary = formatApplySummary(results);
  console.log(`\n${summary.replace(/\*/g, '')}`);
  await sendTelegram(settings, summary);

  // Write last-run metadata
  writeFileSync(resolve(__dir, 'data/applier_last_run.json'), JSON.stringify({
    started_at: startedAt, finished_at: Date.now(), finished: true, ...results
  }, null, 2));

  console.log('\n✅ Apply run complete');
  return results;
}

async function handleResult(job, result, results, settings, profile, apiKey) {
  const { status, meta, pending_question, externalUrl, ats_platform } = result;
  const title = meta?.title || job.title || '?';
  const company = meta?.company || job.company || '?';

  switch (status) {
    case 'submitted':
      console.log(`    ✅ Applied!`);
      updateJobStatus(job.id, 'applied', { title, company, applied_at: Date.now() });
      appendLog({ ...job, title, company, status: 'applied', applied_at: Date.now() });
      results.submitted++;
      break;

    case 'needs_answer': {
      const questionText = pending_question?.label || pending_question || 'Unknown question';
      const questionOptions = pending_question?.options || [];
      console.log(`    💬 Unknown question — asking Claude: "${questionText}"${questionOptions.length ? ` (options: ${questionOptions.join(', ')})` : ''}`);

      const aiAnswer = await generateAnswer(questionText, profile, apiKey, { title, company });

      updateJobStatus(job.id, 'needs_answer', {
        title, company, pending_question,
        ai_suggested_answer: aiAnswer || null,
      });
      appendLog({ ...job, title, company, status: 'needs_answer', pending_question, ai_suggested_answer: aiAnswer });

      const msg = [
        `❓ *New question* — ${company} / ${title}`,
        ``,
        `*Question:* ${questionText}`,
        questionOptions.length ? `*Options:* ${questionOptions.join(' | ')}` : '',
        ``,
        aiAnswer
          ? `*AI answer:*\n${aiAnswer}`
          : `_AI could not generate an answer._`,
        ``,
        `Reply with your answer to store it, or reply *ACCEPT* to use the AI answer.`,
      ].filter(Boolean).join('\n');

      await sendTelegram(settings, msg);
      results.needs_answer++;
      break;
    }

    case 'skipped_recruiter_only':
      console.log(`    🚫 Recruiter-only`);
      updateJobStatus(job.id, 'skipped_recruiter_only', { title, company });
      appendLog({ ...job, title, company, status: 'skipped_recruiter_only' });
      results.skipped_recruiter++;
      break;

    case 'skipped_external_unsupported': {
      const platform = ats_platform || job.apply_type || 'unknown';
      console.log(`    ⏭️  External ATS: ${platform}`);
      updateJobStatus(job.id, 'skipped_external_unsupported', { title, company, ats_url: externalUrl, ats_platform: platform });
      appendLog({ ...job, title, company, status: 'skipped_external_unsupported', ats_url: externalUrl, ats_platform: platform });
      results.skipped_external++;
      results.atsCounts[platform] = (results.atsCounts[platform] || 0) + 1;
      break;
    }

    case 'skipped_no_apply':
    case 'skipped_easy_apply_unsupported':
      console.log(`    ⏭️  Skipped — ${status}`);
      updateJobStatus(job.id, status, { title, company });
      appendLog({ ...job, title, company, status });
      results.skipped_no_apply++;
      break;

    case 'skipped_honeypot':
    case 'stuck':
    case 'incomplete':
      console.log(`    ⏭️  Skipped — ${status}`);
      updateJobStatus(job.id, status, { title, company });
      appendLog({ ...job, title, company, status });
      results.skipped_other++;
      break;

    default:
      console.warn(`    ⚠️  Unhandled status: ${status}`);
      updateJobStatus(job.id, status, { title, company });
      appendLog({ ...job, title, company, status });
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
