#!/usr/bin/env node
/**
 * analyze_ats.mjs — ATS platform analysis
 * Reads the applications log and ranks external ATS platforms by job count
 * Run: node analyze_ats.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const logPath = resolve(__dir, 'data/applications_log.json');
const queuePath = resolve(__dir, 'data/jobs_queue.json');

function analyze() {
  const atsCounts = {};
  const atsExamples = {};
  let totalExternal = 0;
  let unknownCount = 0;

  // From applications log (processed jobs)
  if (existsSync(logPath)) {
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    for (const entry of log) {
      if (entry.status === 'skipped_external_unsupported') {
        totalExternal++;
        const platform = entry.ats_platform || 'unknown';
        atsCounts[platform] = (atsCounts[platform] || 0) + 1;
        if (!atsExamples[platform]) atsExamples[platform] = [];
        if (atsExamples[platform].length < 3) {
          atsExamples[platform].push({ title: entry.title, company: entry.company, url: entry.ats_url });
        }
        if (platform === 'unknown') unknownCount++;
      }
    }
  }

  // From queue (not yet processed)
  if (existsSync(queuePath)) {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    for (const job of queue) {
      if (job.status === 'skipped_external_unsupported') {
        totalExternal++;
        const platform = job.ats_platform || 'unknown';
        atsCounts[platform] = (atsCounts[platform] || 0) + 1;
        if (!atsExamples[platform]) atsExamples[platform] = [];
        if (atsExamples[platform].length < 3) {
          atsExamples[platform].push({ title: job.title, company: job.company, url: job.ats_url });
        }
      }
    }
  }

  if (totalExternal === 0) {
    console.log('No external ATS jobs found yet. Run the applier first.');
    return;
  }

  const sorted = Object.entries(atsCounts).sort((a, b) => b[1] - a[1]);

  console.log(`\n📊 ATS Platform Analysis — ${totalExternal} external jobs\n`);
  console.log('Platform         Count   % of external   Build next?');
  console.log('─'.repeat(60));

  for (const [platform, count] of sorted) {
    const pct = ((count / totalExternal) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(count / totalExternal * 20));
    console.log(`${platform.padEnd(16)} ${String(count).padEnd(7)} ${pct.padEnd(15)}% ${bar}`);
  }

  console.log('\nTop platforms with examples:');
  for (const [platform, count] of sorted.slice(0, 5)) {
    console.log(`\n  ${platform} (${count} jobs):`);
    for (const ex of (atsExamples[platform] || [])) {
      console.log(`    • ${ex.title} @ ${ex.company}`);
      if (ex.url) console.log(`      ${ex.url}`);
    }
  }

  if (unknownCount > 0) {
    console.log(`\n⚠️  ${unknownCount} jobs with unknown ATS (URL capture may need improvement)`);
  }

  console.log('\n💡 Recommendation: Build support for the top 2-3 platforms first.');
}

analyze();
