/**
 * linkedin.mjs — LinkedIn search and Easy Apply
 */
import {
  LINKEDIN_BASE, NAVIGATION_TIMEOUT, FEED_NAVIGATION_TIMEOUT,
  PAGE_LOAD_WAIT, SCROLL_WAIT, CLICK_WAIT, MODAL_STEP_WAIT,
  SUBMIT_WAIT, DISMISS_TIMEOUT, APPLY_CLICK_TIMEOUT,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR, LINKEDIN_APPLY_BUTTON_SELECTOR,
  LINKEDIN_SUBMIT_SELECTOR, LINKEDIN_NEXT_SELECTOR,
  LINKEDIN_REVIEW_SELECTOR, LINKEDIN_DISMISS_SELECTOR,
  LINKEDIN_MAX_MODAL_STEPS
} from './constants.mjs';

const MAX_SEARCH_PAGES = 40;

export async function verifyLogin(page) {
  await page.goto(`${LINKEDIN_BASE}/feed/`, { waitUntil: 'domcontentloaded', timeout: FEED_NAVIGATION_TIMEOUT });
  await page.waitForTimeout(CLICK_WAIT);
  return page.url().includes('/feed');
}

export async function searchLinkedIn(page, search, { onPage } = {}) {
  const jobs = [];

  for (const keyword of search.keywords) {
    const params = new URLSearchParams({ keywords: keyword, sortBy: 'DD' });
    if (search.filters?.remote) params.set('f_WT', '2');
    if (search.filters?.easy_apply_only) params.set('f_LF', 'f_AL');
    if (search.filters?.posted_within_days) {
      const seconds = (search.filters.posted_within_days * 86400);
      params.set('f_TPR', `r${seconds}`);
    }

    const url = `${LINKEDIN_BASE}/jobs/search/?${params.toString()}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    // Paginate through all result pages
    let pageNum = 0;
    while (pageNum < MAX_SEARCH_PAGES) {
      // Scroll to load all cards on current page
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SCROLL_WAIT);

      const found = await page.evaluate(({ track, excludes }) => {
        const ids = [...new Set(
          Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))
            .map(a => a.href.match(/\/jobs\/view\/(\d+)/)?.[1])
            .filter(Boolean)
        )];

        return ids.map(id => {
          const link = document.querySelector(`a[href*="/jobs/view/${id}"]`);
          const container = link?.closest('li') || link?.parentElement;
          const title = container?.querySelector('strong, [class*="title"], h3')?.textContent?.trim()
            || link?.textContent?.trim() || '';
          const company = container?.querySelector('[class*="company"], [class*="subtitle"], h4')?.textContent?.trim() || '';
          const location = container?.querySelector('[class*="location"]')?.textContent?.trim() || '';

          const titleLower = title.toLowerCase();
          const companyLower = company.toLowerCase();
          for (const ex of excludes) {
            if (titleLower.includes(ex.toLowerCase()) || companyLower.includes(ex.toLowerCase())) return null;
          }

          return { id: `li_${id}`, platform: 'linkedin', track, title, company, location,
                   url: `https://www.linkedin.com/jobs/view/${id}/`, jobId: id };
        }).filter(Boolean);
      }, { track: search.track, excludes: search.exclude_keywords || [] });

      jobs.push(...found);
      if (found.length > 0 && onPage) onPage(found);

      // Click next page button
      const nextBtn = await page.$('button[aria-label="View next page"]');
      if (!nextBtn) break;
      await nextBtn.click();
      await page.waitForTimeout(PAGE_LOAD_WAIT);
      pageNum++;
    }
  }

  // Dedupe by jobId
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
}

export async function applyLinkedIn(page, job, formFiller) {
  // Navigate directly to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  // Get title/company from detail panel
  const meta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  }));

  // Detect apply type
  const eaBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}[aria-label*="Easy Apply"]`);
  const externalBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}:not([aria-label*="Easy Apply"])`);
  const interestedBtn = await page.$('button[aria-label*="interested"], button:has-text("I\'m interested")');

  if (!eaBtn && interestedBtn) return { status: 'skipped_recruiter_only', meta };
  if (!eaBtn && externalBtn) {
    // Capture the external apply URL for ATS analysis
    const externalUrl = await externalBtn.evaluate(el => el.getAttribute('href') || el.dataset?.href || '')
      .catch(() => '');
    // Also check for redirect links in the page
    const applyLink = await page.evaluate(() => {
      const a = document.querySelector('a[href*="greenhouse"], a[href*="lever"], a[href*="workday"], a[href*="ashby"], a[href*="jobvite"], a[href*="smartrecruiters"], a[href*="icims"], a[href*="taleo"]');
      return a?.href || '';
    }).catch(() => '');
    return { status: 'skipped_external_unsupported', meta, externalUrl: applyLink || externalUrl };
  }
  if (!eaBtn) return { status: 'skipped_easy_apply_unsupported', meta };

  // Click Easy Apply
  await page.click(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(CLICK_WAIT);

  const modal = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR);
  if (!modal) return { status: 'no_modal', meta };

  // Step through modal
  let lastProgress = '-1';
  for (let step = 0; step < LINKEDIN_MAX_MODAL_STEPS; step++) {
    const modalStillOpen = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR);
    if (!modalStillOpen) return { status: 'submitted', meta };

    const progress = await page.$eval('[role="progressbar"]',
      el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || String(el.style?.width || step)
    ).catch(() => String(step));

    // Fill form fields — returns unknown required fields
    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

    // Honeypot?
    if (unknowns[0]?.honeypot) {
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'skipped_honeypot', meta };
    }

    // Has unknown required fields?
    if (unknowns.length > 0) {
      const question = unknowns[0];
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'needs_answer', pending_question: question, meta };
    }

    await page.waitForTimeout(MODAL_STEP_WAIT);

    // Submit?
    const hasSubmit = await page.$(LINKEDIN_SUBMIT_SELECTOR);
    if (hasSubmit) {
      await page.click(LINKEDIN_SUBMIT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT });
      await page.waitForTimeout(SUBMIT_WAIT);
      return { status: 'submitted', meta };
    }

    // Stuck?
    if (progress === lastProgress && step > 2) {
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'stuck', meta };
    }

    // Next/Continue?
    const hasNext = await page.$(LINKEDIN_NEXT_SELECTOR);
    if (hasNext) {
      await page.click(LINKEDIN_NEXT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    // Review?
    const hasReview = await page.$(LINKEDIN_REVIEW_SELECTOR);
    if (hasReview) {
      await page.click(LINKEDIN_REVIEW_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    break;
  }

  await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
  return { status: 'incomplete', meta };
}
