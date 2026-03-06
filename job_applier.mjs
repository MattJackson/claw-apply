#!/usr/bin/env node
/**
 * job_applier.mjs — claw-apply Job Applier
 * Reads jobs queue and applies to each new/needs_answer job
 * Run via cron or manually: node job_applier.mjs [--preview]
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

import { getJobsByStatus, updateJobStatus, appendLog, loadConfig } from './lib/queue.mjs';
import { createBrowser } from './lib/browser.mjs';
import { FormFiller } from './lib/form_filler.mjs';
import { verifyLogin as liLogin, applyLinkedIn } from './lib/linkedin.mjs';
import { verifyLogin as wfLogin, applyWellfound } from './lib/wellfound.mjs';
import { sendTelegram, formatApplySummary, formatUnknownQuestion } from './lib/notify.mjs';
import {
  DEFAULT_REVIEW_WINDOW_MINUTES,
  APPLY_BETWEEN_DELAY_BASE, APPLY_BETWEEN_DELAY_WF_BASE,
  APPLY_BETWEEN_DELAY_JITTER, DEFAULT_MAX_RETRIES
} from './lib/constants.mjs';

const isPreview = process.argv.includes('--preview');

async function main() {
  console.log('🚀 claw-apply: Job Applier starting\n');

  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const profile = loadConfig(resolve(__dir, 'config/profile.json'));
  const answersPath = resolve(__dir, 'config/answers.json');
  const answers = existsSync(answersPath) ? loadConfig(answersPath) : [];

  const formFiller = new FormFiller(profile, answers);
  const maxApps = settings.max_applications_per_run || Infinity;
  const maxRetries = settings.max_retries ?? DEFAULT_MAX_RETRIES;

  // Preview mode: show queue and exit
  if (isPreview) {
    const newJobs = getJobsByStatus('new');
    if (newJobs.length === 0) {
      console.log('No new jobs in queue.');
      return;
    }
    console.log(`📋 ${newJobs.length} job(s) queued:\n`);
    for (const j of newJobs) {
      console.log(`  • [${j.platform}] ${j.title} @ ${j.company || '?'} — ${j.url}`);
    }
    console.log('\nRun without --preview to apply.');
    return;
  }

  // Get jobs to process: new + needs_answer (retries)
  const allJobs = getJobsByStatus(['new', 'needs_answer']);
  const jobs = allJobs.slice(0, maxApps);
  console.log(`📋 ${jobs.length} job(s) to process${allJobs.length > jobs.length ? ` (capped from ${allJobs.length})` : ''}\n`);

  if (jobs.length === 0) {
    console.log('Nothing to apply to. Run job_searcher.mjs first.');
    return;
  }

  const results = {
    submitted: 0, failed: 0, needs_answer: 0, total: jobs.length,
    skipped_recruiter: 0, skipped_external: 0, skipped_no_easy_apply: 0
  };

  // Group by platform
  const liJobs = jobs.filter(j => j.platform === 'linkedin');
  const wfJobs = jobs.filter(j => j.platform === 'wellfound');

  // --- LinkedIn ---
  if (liJobs.length > 0) {
    console.log(`🔗 LinkedIn: ${liJobs.length} jobs\n`);
    let liBrowser;
    try {
      liBrowser = await createBrowser(settings, 'linkedin');
      const loggedIn = await liLogin(liBrowser.page);
      if (!loggedIn) throw new Error('LinkedIn not logged in');
      console.log('  ✅ Logged in\n');

      for (const job of liJobs) {
        console.log(`  → ${job.title} @ ${job.company || '?'}`);
        try {
          const result = await applyLinkedIn(liBrowser.page, job, formFiller);
          await handleResult(job, result, results, settings);
        } catch (e) {
          handleError(job, e, results, maxRetries);
        }
        await liBrowser.page.waitForTimeout(APPLY_BETWEEN_DELAY_BASE + Math.random() * APPLY_BETWEEN_DELAY_JITTER);
      }
    } catch (e) {
      console.error(`  ❌ LinkedIn browser error: ${e.message}`);
      results.failed += liJobs.length;
    } finally {
      await liBrowser?.browser?.close().catch(() => {});
    }
  }

  // --- Wellfound ---
  if (wfJobs.length > 0) {
    console.log(`\n🌐 Wellfound: ${wfJobs.length} jobs\n`);
    let wfBrowser;
    try {
      wfBrowser = await createBrowser(settings, 'wellfound');
      await wfLogin(wfBrowser.page);
      console.log('  ✅ Started\n');

      for (const job of wfJobs) {
        console.log(`  → ${job.title} @ ${job.company || '?'}`);
        try {
          const result = await applyWellfound(wfBrowser.page, job, formFiller);
          await handleResult(job, result, results, settings);
        } catch (e) {
          handleError(job, e, results, maxRetries);
        }
        await wfBrowser.page.waitForTimeout(APPLY_BETWEEN_DELAY_WF_BASE + Math.random() * APPLY_BETWEEN_DELAY_JITTER);
      }
    } catch (e) {
      console.error(`  ❌ Wellfound browser error: ${e.message}`);
      results.failed += wfJobs.length;
    } finally {
      await wfBrowser?.browser?.close().catch(() => {});
    }
  }

  // Final summary
  const summary = formatApplySummary(results);
  console.log(`\n${summary.replace(/\*/g, '')}`);
  await sendTelegram(settings, summary);

  console.log('\n✅ Apply run complete');
  return results;
}

async function handleResult(job, result, results, settings) {
  const { status, meta, pending_question } = result;
  const title = meta?.title || job.title;
  const company = meta?.company || job.company;

  switch (status) {
    case 'submitted':
      console.log(`    ✅ Applied!`);
      updateJobStatus(job.id, 'applied', { applied_at: new Date().toISOString(), title, company });
      appendLog({ ...job, title, company, status: 'applied', applied_at: new Date().toISOString() });
      results.submitted++;
      break;

    case 'needs_answer':
      console.log(`    ❓ Unknown question: "${pending_question}"`);
      updateJobStatus(job.id, 'needs_answer', { pending_question, title, company });
      appendLog({ ...job, title, company, status: 'needs_answer', pending_question });
      await sendTelegram(settings, formatUnknownQuestion({ title, company }, pending_question));
      results.needs_answer++;
      break;

    case 'skipped_honeypot':
      console.log(`    🚫 Skipped — honeypot question`);
      updateJobStatus(job.id, 'skipped', { notes: 'honeypot', title, company });
      appendLog({ ...job, title, company, status: 'skipped', notes: 'honeypot' });
      break;

    case 'skipped_recruiter_only':
      console.log(`    ⏭️  Skipped — recruiter-only ("I'm interested")`);
      updateJobStatus(job.id, 'skipped_recruiter_only', { title, company });
      appendLog({ ...job, title, company, status: 'skipped_recruiter_only' });
      results.skipped_recruiter++;
      break;

    case 'skipped_external_unsupported':
      console.log(`    ⏭️  Skipped — external ATS (not yet supported)`);
      updateJobStatus(job.id, 'skipped_external_unsupported', { title, company });
      appendLog({ ...job, title, company, status: 'skipped_external_unsupported' });
      results.skipped_external++;
      break;

    case 'skipped_easy_apply_unsupported':
    case 'no_easy_apply':
    case 'no_button':
      console.log(`    ⏭️  Skipped — no Easy Apply`);
      updateJobStatus(job.id, 'skipped_easy_apply_unsupported', { title, company });
      appendLog({ ...job, title, company, status: 'skipped_easy_apply_unsupported' });
      results.skipped_no_easy_apply++;
      break;

    default:
      console.log(`    ⚠️  ${status}`);
      updateJobStatus(job.id, 'failed', { notes: status, title, company });
      appendLog({ ...job, title, company, status: 'failed', notes: status });
      results.failed++;
  }
}

function handleError(job, e, results, maxRetries) {
  const msg = e.message?.substring(0, 80);
  const retries = (job.retry_count || 0) + 1;
  if (retries <= maxRetries) {
    console.log(`    ⚠️  Error (retry ${retries}/${maxRetries}): ${msg}`);
    updateJobStatus(job.id, 'new', { retry_count: retries, last_error: msg });
  } else {
    console.log(`    ❌ Error (max retries reached): ${msg}`);
    updateJobStatus(job.id, 'failed', { retry_count: retries, notes: msg });
    appendLog({ ...job, status: 'failed', error: msg });
    results.failed++;
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
