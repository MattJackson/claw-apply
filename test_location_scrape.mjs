import { loadEnv } from './lib/env.mjs';
loadEnv();
import { createBrowser } from './lib/browser.mjs';
import { loadConfig } from './lib/queue.mjs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const settings = loadConfig(resolve(__dir, 'config/settings.json'));

const b = await createBrowser(settings, 'linkedin');
await b.page.goto('https://www.linkedin.com/jobs/search/?keywords=founding+account+executive&f_WT=2&sortBy=DD', { waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(3000);

// Click first job card
const card = await b.page.$('li.jobs-search-results__list-item');
if (card) await card.click();
await b.page.waitForTimeout(2000);

const result = await b.page.evaluate(() => {
  // Try various location selectors
  const selectors = [
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__workplace-type',
    '[class*="workplace-type"]',
    '[class*="location"]',
    '.tvm__text',
    '.job-details-jobs-unified-top-card__job-insight span',
    'span[class*="topcard__flavor"]',
  ];
  const results = {};
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel));
    if (els.length) results[sel] = els.map(e => e.textContent.trim()).filter(Boolean);
  }
  // Also dump all text in the top card area
  const topCard = document.querySelector('.jobs-details__main-content, .scaffold-layout__detail');
  results['_topCardText'] = topCard?.textContent?.trim().slice(0, 500) || 'not found';
  return results;
});

console.log(JSON.stringify(result, null, 2));
await b.browser.close();
