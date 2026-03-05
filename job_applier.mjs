#!/usr/bin/env node
/**
 * job_applier.mjs — claw-apply Job Applier
 * Reads jobs queue and applies to each new/needs_answer job
 * Run via cron or manually: node job_applier.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = p => JSON.parse(readFileSync(resolve(__dir, p), 'utf8'));

import { getJobsByStatus, updateJobStatus, appendLog } from './lib/queue.mjs';
import { createBrowser } from './lib/browser.mjs';
import { FormFiller } from './lib/form_filler.mjs';
import { verifyLogin as liLogin, applyLinkedIn } from './lib/linkedin.mjs';
import { verifyLogin as wfLogin, applyWellfound } from './lib/wellfound.mjs';
import { sendTelegram, formatApplySummary, formatUnknownQuestion } from './lib/notify.mjs';

async function main() {
  console.log('🚀 claw-apply: Job Applier starting\n');

  const settings = cfg('config/settings.json');
  const profile = cfg('config/profile.json');
  const answers = existsSync(resolve(__dir, 'config/answers.json'))
    ? JSON.parse(readFileSync(resolve(__dir, 'config/answers.json'), 'utf8'))
    : [];

  const formFiller = new FormFiller(profile, answers);

  // Mode B: send queue preview and wait for review window
  if (settings.mode === 'B') {
    const newJobs = getJobsByStatus('new');
    if (newJobs.length > 0) {
      const preview = newJobs.slice(0, 10).map(j => `• ${j.title} @ ${j.company}`).join('\n');
      const msg = `📋 *Apply run starting in ${settings.review_window_minutes || 30} min*\n\n${preview}${newJobs.length > 10 ? `\n...and ${newJobs.length - 10} more` : ''}\n\nReply with job IDs to skip, or ignore to proceed.`;
      await sendTelegram(settings, msg);
      console.log(`[Mode B] Waiting ${settings.review_window_minutes || 30} minutes for review...`);
      await new Promise(r => setTimeout(r, (settings.review_window_minutes || 30) * 60 * 1000));
    }
  }

  // Get jobs to process: new + needs_answer (retries)
  const jobs = getJobsByStatus(['new', 'needs_answer']);
  console.log(`📋 ${jobs.length} job(s) to process\n`);

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
          console.log(`    ❌ Error: ${e.message?.substring(0, 80)}`);
          updateJobStatus(job.id, 'failed', { notes: e.message?.substring(0, 80) });
          appendLog({ ...job, status: 'failed', error: e.message?.substring(0, 80) });
          results.failed++;
        }
        await liBrowser.page.waitForTimeout(2000 + Math.random() * 1000);
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
          console.log(`    ❌ Error: ${e.message?.substring(0, 80)}`);
          updateJobStatus(job.id, 'failed', { notes: e.message?.substring(0, 80) });
          appendLog({ ...job, status: 'failed', error: e.message?.substring(0, 80) });
          results.failed++;
        }
        await wfBrowser.page.waitForTimeout(1500 + Math.random() * 1000);
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
      results.skipped++;
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

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
