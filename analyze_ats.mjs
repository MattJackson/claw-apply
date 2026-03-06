#!/usr/bin/env node
/**
 * analyze_ats.mjs — Full job pipeline breakdown
 * Shows Easy Apply vs external ATS platforms vs other skips
 * Run: node analyze_ats.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const logPath = resolve(__dir, 'data/applications_log.json');
const queuePath = resolve(__dir, 'data/jobs_queue.json');

function hostname(url) {
  try { return new URL(url).hostname.replace('www.', '').split('.')[0]; } catch { return 'unknown'; }
}

function analyze() {
  const all = [];

  if (existsSync(queuePath)) {
    all.push(...JSON.parse(readFileSync(queuePath, 'utf8')));
  }
  if (existsSync(logPath)) {
    all.push(...JSON.parse(readFileSync(logPath, 'utf8')));
  }

  if (all.length === 0) {
    console.log('No data yet. Run the searcher first.');
    return;
  }

  // Counters
  let easyApply = 0, applied = 0, failed = 0, needsAnswer = 0;
  let recruiterOnly = 0, noEasyApply = 0;
  const atsCounts = {};
  const atsExamples = {};
  let newJobs = 0;

  for (const job of all) {
    switch (job.status) {
      case 'new':             newJobs++;        break;
      case 'applied':         applied++;        break;
      case 'failed':          failed++;         break;
      case 'needs_answer':    needsAnswer++;    break;
      case 'skipped_recruiter_only':      recruiterOnly++;  break;
      case 'skipped_easy_apply_unsupported': noEasyApply++; break;
      case 'skipped_external_unsupported': {
        const platform = job.ats_platform || (job.ats_url ? hostname(job.ats_url) : 'unknown');
        atsCounts[platform] = (atsCounts[platform] || 0) + 1;
        if (!atsExamples[platform]) atsExamples[platform] = [];
        if (atsExamples[platform].length < 3) {
          atsExamples[platform].push({ title: job.title, company: job.company, url: job.ats_url });
        }
        break;
      }
      default:
        // Count easy apply eligible (status=new on linkedin with easy apply available)
        if (job.status === 'new' && job.easy_apply) easyApply++;
    }
  }

  const totalExternal = Object.values(atsCounts).reduce((a, b) => a + b, 0);
  const total = all.length;

  console.log(`\n📊 Job Pipeline Breakdown — ${total} total jobs\n`);
  console.log(`  ✅ Applied:             ${applied}`);
  console.log(`  🔄 Pending (new):       ${newJobs}`);
  console.log(`  💬 Needs answer:        ${needsAnswer}`);
  console.log(`  ❌ Failed:              ${failed}`);
  console.log(`  🚫 Recruiter-only:      ${recruiterOnly}`);
  console.log(`  ⏭️  No Easy Apply btn:   ${noEasyApply}`);
  console.log(`  🌐 External ATS:        ${totalExternal}`);
  console.log('');

  if (totalExternal > 0) {
    const sorted = Object.entries(atsCounts).sort((a, b) => b[1] - a[1]);
    console.log('  External ATS breakdown:');
    for (const [platform, count] of sorted) {
      const pct = ((count / totalExternal) * 100).toFixed(0);
      const bar = '█'.repeat(Math.max(1, Math.round(count / totalExternal * 15)));
      console.log(`    ${platform.padEnd(18)} ${String(count).padEnd(5)} (${pct}%) ${bar}`);
    }

    console.log('\n  Top ATS — examples:');
    for (const [platform, count] of sorted.slice(0, 4)) {
      console.log(`\n  ${platform} (${count} jobs):`);
      for (const ex of (atsExamples[platform] || [])) {
        console.log(`    • ${ex.title || '?'} @ ${ex.company || '?'}`);
        if (ex.url) console.log(`      ${ex.url}`);
      }
    }

    console.log(`\n💡 Build support for: ${sorted.slice(0, 3).map(([p]) => p).join(', ')} first.`);
  } else {
    console.log('  No external ATS data yet — run the applier to classify jobs.');
  }
}

analyze();
