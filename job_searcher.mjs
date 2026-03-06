#!/usr/bin/env node
/**
 * job_searcher.mjs — claw-apply Job Searcher
 * Searches LinkedIn + Wellfound and populates the jobs queue
 * Run via cron or manually: node job_searcher.mjs
 */
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

import { addJobs, loadQueue, loadConfig } from './lib/queue.mjs';
import { createBrowser } from './lib/browser.mjs';
import { verifyLogin as liLogin, searchLinkedIn } from './lib/linkedin.mjs';
import { verifyLogin as wfLogin, searchWellfound } from './lib/wellfound.mjs';
import { sendTelegram, formatSearchSummary } from './lib/notify.mjs';
import { DEFAULT_FIRST_RUN_DAYS } from './lib/constants.mjs';
import { generateKeywords } from './lib/keywords.mjs';

async function main() {
  console.log('🔍 claw-apply: Job Searcher starting\n');

  // Load config
  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const searchConfig = loadConfig(resolve(__dir, 'config/search_config.json'));

  // First run detection: if queue is empty, use first_run_days lookback
  const profile = loadConfig(resolve(__dir, 'config/profile.json'));
  const anthropicKey = process.env.ANTHROPIC_API_KEY || settings.anthropic_api_key;

  // Enhance keywords with AI if API key available
  if (anthropicKey) {
    console.log('🤖 Generating AI-enhanced search keywords...');
    for (const search of searchConfig.searches) {
      try {
        const aiKeywords = await generateKeywords(search, profile, anthropicKey);
        const merged = [...new Set([...search.keywords, ...aiKeywords])];
        console.log(`  [${search.name}] ${search.keywords.length} → ${merged.length} keywords`);
        search.keywords = merged;
      } catch (e) {
        console.warn(`  [${search.name}] AI keywords failed, using static: ${e.message}`);
      }
    }
    console.log('');
  }

  const isFirstRun = loadQueue().length === 0;
  const lookbackDays = isFirstRun ? (searchConfig.first_run_days || DEFAULT_FIRST_RUN_DAYS) : null;
  if (isFirstRun) console.log(`📅 First run — looking back ${lookbackDays} days\n`);

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
        const effectiveSearch = lookbackDays
          ? { ...search, filters: { ...search.filters, posted_within_days: lookbackDays } }
          : search;
        const jobs = await searchLinkedIn(liBrowser.page, effectiveSearch);
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
        const effectiveSearch = lookbackDays
          ? { ...search, filters: { ...search.filters, posted_within_days: lookbackDays } }
          : search;
        const jobs = await searchWellfound(wfBrowser.page, effectiveSearch);
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
