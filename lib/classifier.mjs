/**
 * classifier.mjs — Detect apply type for each job
 * Visits each job page and classifies: easy_apply, greenhouse, lever, workday, ashby, etc.
 * Run by searcher as Phase 2 after collecting URLs
 */
import {
  LINKEDIN_BASE, NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, CLICK_WAIT,
  LINKEDIN_APPLY_BUTTON_SELECTOR
} from './constants.mjs';

const EXTERNAL_ATS = [
  { name: 'greenhouse',      pattern: /greenhouse\.io/i },
  { name: 'lever',           pattern: /lever\.co/i },
  { name: 'workday',         pattern: /workday\.com|myworkdayjobs\.com/i },
  { name: 'ashby',           pattern: /ashbyhq\.com/i },
  { name: 'jobvite',         pattern: /jobvite\.com/i },
  { name: 'smartrecruiters', pattern: /smartrecruiters\.com/i },
  { name: 'icims',           pattern: /icims\.com/i },
  { name: 'taleo',           pattern: /taleo\.net/i },
  { name: 'bamboohr',        pattern: /bamboohr\.com/i },
  { name: 'rippling',        pattern: /rippling\.com/i },
  { name: 'workable',        pattern: /workable\.com/i },
  { name: 'breezyhr',        pattern: /breezy\.hr/i },
  { name: 'recruitee',       pattern: /recruitee\.com/i },
  { name: 'dover',           pattern: /dover\.com/i },
];

function detectAts(url) {
  if (!url) return null;
  for (const ats of EXTERNAL_ATS) {
    if (ats.pattern.test(url)) return ats.name;
  }
  return 'unknown_external';
}

export async function classifyLinkedInJob(page, job) {
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    // Check for Easy Apply
    const eaBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}[aria-label*="Easy Apply"]`);
    if (eaBtn) return { apply_type: 'easy_apply', apply_url: job.url };

    // Check for recruiter-only
    const interestedBtn = await page.$('button[aria-label*="interested"]');
    if (interestedBtn) return { apply_type: 'recruiter_only', apply_url: null };

    // Check for external apply button and find ATS URL
    const externalBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}:not([aria-label*="Easy Apply"])`);
    if (externalBtn) {
      // Try to find the actual ATS link in the page
      const atsUrl = await page.evaluate(() => {
        const patterns = [
          'greenhouse', 'lever', 'workday', 'myworkday', 'ashby', 'jobvite',
          'smartrecruiters', 'icims', 'taleo', 'bamboohr', 'rippling', 'workable'
        ];
        const links = Array.from(document.querySelectorAll('a[href]'));
        for (const a of links) {
          for (const p of patterns) {
            if (a.href.includes(p)) return a.href;
          }
        }
        return null;
      });

      const platform = detectAts(atsUrl) || 'unknown_external';
      return { apply_type: platform, apply_url: atsUrl };
    }

    return { apply_type: 'unknown', apply_url: null };
  } catch (e) {
    return { apply_type: 'error', apply_url: null, error: e.message };
  }
}

export async function classifyBatch(page, jobs, { onClassified } = {}) {
  const results = [];
  for (const job of jobs) {
    const classification = await classifyLinkedInJob(page, job);
    const classified = { ...job, ...classification, classified_at: Date.now() };
    results.push(classified);
    if (onClassified) onClassified(classified);
  }
  return results;
}
