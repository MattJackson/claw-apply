/**
 * wellfound.mjs — Wellfound search and apply
 */
import {
  WELLFOUND_BASE, NAVIGATION_TIMEOUT, SEARCH_NAVIGATION_TIMEOUT,
  SEARCH_LOAD_WAIT, SEARCH_SCROLL_WAIT, LOGIN_WAIT, PAGE_LOAD_WAIT,
  FORM_FILL_WAIT, SUBMIT_WAIT, SEARCH_RESULTS_MAX
} from './constants.mjs';

const MAX_INFINITE_SCROLL = 10;

export async function verifyLogin(page) {
  await page.goto(`${WELLFOUND_BASE}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(LOGIN_WAIT);
  const loggedIn = await page.evaluate(() =>
    document.body.innerText.includes('Applied') || document.body.innerText.includes('Open to offers')
  );
  return loggedIn;
}

export async function searchWellfound(page, search, { onPage } = {}) {
  const jobs = [];

  for (const keyword of search.keywords) {
    const url = `${WELLFOUND_BASE}/jobs?q=${encodeURIComponent(keyword)}&remote=true`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SEARCH_NAVIGATION_TIMEOUT });
    } catch (e) {
      console.error(`    ⚠️ Navigation failed for "${keyword}": ${e.message}`);
      continue;
    }
    await page.waitForTimeout(SEARCH_LOAD_WAIT);

    // Scroll to bottom repeatedly to trigger infinite scroll
    let lastHeight = 0;
    for (let i = 0; i < MAX_INFINITE_SCROLL; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SEARCH_SCROLL_WAIT);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === lastHeight) break;
      lastHeight = newHeight;
    }

    const found = await page.evaluate(({ track, excludes, maxResults }) => {
      const seen = new Set();
      const results = [];

      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        const isJob = href.match(/wellfound\.com\/(jobs\/.{5,}|l\/.+)/) &&
                      !href.match(/\/(home|applications|messages|starred|on-demand|settings|profile|jobs\?)$/);
        if (!isJob) return;
        seen.add(href);

        const card = a.closest('[class*="job"]') || a.closest('[class*="card"]') || a.closest('div') || a.parentElement;
        const title = a.textContent?.trim().substring(0, 100) || '';
        const company = card?.querySelector('[class*="company"], [class*="startup"], h2')?.textContent?.trim() || '';

        // Exclusion filter
        const titleL = title.toLowerCase();
        const companyL = company.toLowerCase();
        for (const ex of excludes) {
          if (titleL.includes(ex.toLowerCase()) || companyL.includes(ex.toLowerCase())) return;
        }

        if (title.length > 3) {
          // Deterministic ID from URL path
          const slug = href.split('/').pop().split('?')[0];
          results.push({
            id: `wf_${slug}`,
            platform: 'wellfound',
            track,
            title,
            company,
            url: href,
          });
        }
      });

      return results.slice(0, maxResults);
    }, { track: search.track, excludes: search.exclude_keywords || [], maxResults: SEARCH_RESULTS_MAX });

    jobs.push(...found);
    if (found.length > 0 && onPage) onPage(found);
  }

  // Dedupe by URL
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.url)) return false; seen.add(j.url); return true; });
}

export async function applyWellfound(page, job, formFiller) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  const meta = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim(),
    company: document.querySelector('[class*="company"] h2, [class*="startup"] h2, h2')?.textContent?.trim(),
  }));

  const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply Now"), a:has-text("Apply Now")');
  if (!applyBtn) return { status: 'no_button', meta };

  await applyBtn.click();
  await page.waitForTimeout(FORM_FILL_WAIT);

  // Fill form
  const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

  if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
  if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

  const submitBtn = await page.$('button[type="submit"]:not([disabled]), input[type="submit"]');
  if (!submitBtn) return { status: 'no_submit', meta };

  await submitBtn.click();
  await page.waitForTimeout(SUBMIT_WAIT);

  return { status: 'submitted', meta };
}
