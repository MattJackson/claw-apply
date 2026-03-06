#!/usr/bin/env node
/**
 * job_searcher.mjs — claw-apply Job Searcher
 * Searches LinkedIn + Wellfound and populates the jobs queue
 * Run via cron or manually: node job_searcher.mjs
 */
import { loadEnv } from './lib/env.mjs';
loadEnv(); // load .env before anything else
/**
 */
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

import { addJobs, loadQueue, loadConfig } from './lib/queue.mjs';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { acquireLock } from './lib/lock.mjs';
import { createBrowser } from './lib/browser.mjs';
import { verifyLogin as liLogin, searchLinkedIn } from './lib/linkedin.mjs';
import { verifyLogin as wfLogin, searchWellfound } from './lib/wellfound.mjs';
import { sendTelegram, formatSearchSummary } from './lib/notify.mjs';
import { DEFAULT_FIRST_RUN_DAYS } from './lib/constants.mjs';
import { generateKeywords } from './lib/keywords.mjs';
import { initProgress, isCompleted, markComplete } from './lib/search_progress.mjs';
import { ensureLoggedIn } from './lib/session.mjs';

async function main() {
  const lock = acquireLock('searcher', resolve(__dir, 'data'));
  console.log('🔍 claw-apply: Job Searcher starting\n');

  let totalAdded = 0, totalSeen = 0;
  const platformsRun = [];
  const startedAt = Date.now();

  const writeLastRun = (finished = false) => {
    writeFileSync(resolve(__dir, 'data/searcher_last_run.json'), JSON.stringify({
      started_at: startedAt,
      finished_at: finished ? Date.now() : null,
      finished,
      added: totalAdded,
      seen: totalSeen,
      skipped_dupes: totalSeen - totalAdded,
      platforms: platformsRun,
    }, null, 2));
  };

  lock.onShutdown(() => {
    console.log('  Writing partial results to last-run file...');
    writeLastRun(false);
  });

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

  // Determine lookback: check for an in-progress run first, then fall back to first-run/normal logic
  const savedProgress = existsSync(resolve(__dir, 'data/search_progress.json'))
    ? JSON.parse(readFileSync(resolve(__dir, 'data/search_progress.json'), 'utf8'))
    : null;
  const isFirstRun = loadQueue().length === 0;
  const lookbackDays = savedProgress?.lookback_days
    || (isFirstRun ? (searchConfig.first_run_days || DEFAULT_FIRST_RUN_DAYS) : (searchConfig.posted_within_days || 2));

  if (savedProgress?.lookback_days) {
    console.log(`🔁 Resuming ${lookbackDays}-day search run\n`);
  } else if (isFirstRun) {
    console.log(`📅 First run — looking back ${lookbackDays} days\n`);
  }

  // Init progress tracking — enables resume on restart
  initProgress(resolve(__dir, 'data'), lookbackDays);

  // Group searches by platform
  const liSearches = searchConfig.searches.filter(s => s.platforms?.includes('linkedin'));
  const wfSearches = searchConfig.searches.filter(s => s.platforms?.includes('wellfound'));

  // --- LinkedIn ---
  if (liSearches.length > 0) {
    console.log('🔗 LinkedIn search...');
    let liBrowser;
    try {
      console.log('  Creating browser...');
      liBrowser = await createBrowser(settings, 'linkedin');
      console.log('  Browser connected, verifying login...');
      const loggedIn = await ensureLoggedIn(liBrowser.page, liLogin, 'linkedin', settings.kernel_api_key || process.env.KERNEL_API_KEY, settings.kernel?.connection_ids || {});
      if (!loggedIn) throw new Error('LinkedIn not logged in');
      console.log('  ✅ Logged in');

      for (const search of liSearches) {
        if (isCompleted('linkedin', search.name)) {
          console.log(`  [${search.name}] ✓ already done, skipping`);
          continue;
        }
        const effectiveSearch = { ...search, filters: { ...search.filters, posted_within_days: lookbackDays } };
        let queryFound = 0, queryAdded = 0;
        await searchLinkedIn(liBrowser.page, effectiveSearch, {
          onPage: (pageJobs) => {
            const added = addJobs(pageJobs);
            totalAdded += added;
            totalSeen += pageJobs.length;
            queryFound += pageJobs.length;
            queryAdded += added;
            process.stdout.write(`\r  [${search.name}] ${queryFound} found, ${queryAdded} new...`);
          }
        });
        console.log(`\r  [${search.name}] ${queryFound} found, ${queryAdded} new`);
        markComplete('linkedin', search.name, { found: queryFound, added: queryAdded });
      }

      platformsRun.push('LinkedIn');
    } catch (e) {
      console.error(`  ❌ LinkedIn error: ${e.message}`);
      if (e.stack) console.error(`  Stack: ${e.stack.split('\n').slice(1, 3).join(' | ').trim()}`);
    } finally {
      await liBrowser?.browser?.close().catch(() => {});
    }
  }

  // --- Wellfound ---
  if (wfSearches.length > 0) {
    console.log('\n🌐 Wellfound search...');
    let wfBrowser;
    try {
      console.log('  Creating browser...');
      wfBrowser = await createBrowser(settings, 'wellfound');
      console.log('  Browser connected, verifying login...');
      const loggedIn = await ensureLoggedIn(wfBrowser.page, wfLogin, 'wellfound', settings.kernel_api_key || process.env.KERNEL_API_KEY, settings.kernel?.connection_ids || {});
      if (!loggedIn) console.warn('  ⚠️ Wellfound login unconfirmed, proceeding');
      else console.log('  ✅ Logged in');

      for (const search of wfSearches) {
        if (isCompleted('wellfound', search.name)) {
          console.log(`  [${search.name}] ✓ already done, skipping`);
          continue;
        }
        const effectiveSearch = { ...search, filters: { ...search.filters, posted_within_days: lookbackDays } };
        let queryFound = 0, queryAdded = 0;
        await searchWellfound(wfBrowser.page, effectiveSearch, {
          onPage: (pageJobs) => {
            const added = addJobs(pageJobs);
            totalAdded += added;
            totalSeen += pageJobs.length;
            queryFound += pageJobs.length;
            queryAdded += added;
            process.stdout.write(`\r  [${search.name}] ${queryFound} found, ${queryAdded} new...`);
          }
        });
        console.log(`\r  [${search.name}] ${queryFound} found, ${queryAdded} new`);
        markComplete('wellfound', search.name, { found: queryFound, added: queryAdded });
      }

      platformsRun.push('Wellfound');
    } catch (e) {
      console.error(`  ❌ Wellfound error: ${e.message}`);
      if (e.stack) console.error(`  Stack: ${e.stack.split('\n').slice(1, 3).join(' | ').trim()}`);
    } finally {
      await wfBrowser?.browser?.close().catch(() => {});
    }
  }

  // Summary
  const summary = formatSearchSummary(totalAdded, totalSeen - totalAdded, platformsRun);
  console.log(`\n${summary.replace(/\*/g, '')}`);
  if (totalAdded > 0) await sendTelegram(settings, summary);

  writeLastRun(true);

  console.log('\n✅ Search complete');
  return { added: totalAdded, seen: totalSeen };
}

main().catch(e => {
  console.error('Fatal:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
