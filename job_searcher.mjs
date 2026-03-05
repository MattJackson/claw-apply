#!/usr/bin/env node
/**
 * job_searcher.mjs — claw-apply Job Searcher
 * Searches LinkedIn + Wellfound and populates the jobs queue
 * Run via cron or manually: node job_searcher.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = p => JSON.parse(readFileSync(resolve(__dir, p), 'utf8'));

import { addJobs } from './lib/queue.mjs';
import { createBrowser } from './lib/browser.mjs';
import { verifyLogin as liLogin, searchLinkedIn } from './lib/linkedin.mjs';
import { verifyLogin as wfLogin, searchWellfound } from './lib/wellfound.mjs';
import { sendTelegram, formatSearchSummary } from './lib/notify.mjs';

async function main() {
  console.log('🔍 claw-apply: Job Searcher starting\n');

  // Load config
  const settings = cfg('config/settings.json');
  const searchConfig = cfg('config/search_config.json');

  let totalAdded = 0;
  let totalSeen = 0;
  const platformsRun = [];

  // Group searches by platform
  const liSearches = searchConfig.searches.filter(s => s.platforms?.includes('linkedin'));
  const wfSearches = searchConfig.searches.filter(s => s.platforms?.includes('wellfound'));

  // --- LinkedIn ---
  if (liSearches.length > 0) {
    console.log('🔗 LinkedIn search...');
    let liBrowser;
    try {
      liBrowser = await createBrowser(settings, 'linkedin');
      const loggedIn = await liLogin(liBrowser.page);
      if (!loggedIn) throw new Error('LinkedIn not logged in');
      console.log('  ✅ Logged in');

      for (const search of liSearches) {
        const jobs = await searchLinkedIn(liBrowser.page, search);
        const added = addJobs(jobs);
        totalAdded += added;
        totalSeen += jobs.length;
        console.log(`  [${search.name}] ${jobs.length} found, ${added} new`);
      }

      platformsRun.push('LinkedIn');
    } catch (e) {
      console.error(`  ❌ LinkedIn error: ${e.message}`);
    } finally {
      await liBrowser?.browser?.close().catch(() => {});
    }
  }

  // --- Wellfound ---
  if (wfSearches.length > 0) {
    console.log('\n🌐 Wellfound search...');
    let wfBrowser;
    try {
      wfBrowser = await createBrowser(settings, 'wellfound');
      const loggedIn = await wfLogin(wfBrowser.page);
      if (!loggedIn) console.warn('  ⚠️ Wellfound login unconfirmed, proceeding');
      else console.log('  ✅ Logged in');

      for (const search of wfSearches) {
        const jobs = await searchWellfound(wfBrowser.page, search);
        const added = addJobs(jobs);
        totalAdded += added;
        totalSeen += jobs.length;
        console.log(`  [${search.name}] ${jobs.length} found, ${added} new`);
      }

      platformsRun.push('Wellfound');
    } catch (e) {
      console.error(`  ❌ Wellfound error: ${e.message}`);
    } finally {
      await wfBrowser?.browser?.close().catch(() => {});
    }
  }

  // Summary
  const summary = formatSearchSummary(totalAdded, totalSeen - totalAdded, platformsRun);
  console.log(`\n${summary.replace(/\*/g, '')}`);
  if (totalAdded > 0) await sendTelegram(settings, summary);

  console.log('\n✅ Search complete');
  return { added: totalAdded, seen: totalSeen };
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
