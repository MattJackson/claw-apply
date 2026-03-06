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
  LINKEDIN_MAX_MODAL_STEPS, EXTERNAL_ATS_PATTERNS
} from './constants.mjs';

const MAX_SEARCH_PAGES = 40;

function detectAts(url) {
  if (!url) return 'unknown_external';
  for (const { name, pattern } of EXTERNAL_ATS_PATTERNS) {
    if (pattern.test(url)) return name;
  }
  return 'unknown_external';
}

export async function verifyLogin(page) {
  await page.goto(`${LINKEDIN_BASE}/feed/`, { waitUntil: 'domcontentloaded', timeout: FEED_NAVIGATION_TIMEOUT });
  await page.waitForTimeout(CLICK_WAIT);
  return page.url().includes('/feed');
}

export async function searchLinkedIn(page, search, { onPage } = {}) {
  const jobs = [];
  const seenIds = new Set();

  for (const keyword of search.keywords) {
    const params = new URLSearchParams({ keywords: keyword, sortBy: 'DD' });
    if (search.filters?.remote) params.set('f_WT', '2');
    if (search.filters?.easy_apply_only) params.set('f_LF', 'f_AL');
    if (search.filters?.posted_within_days) {
      params.set('f_TPR', `r${search.filters.posted_within_days * 86400}`);
    }

    const url = `${LINKEDIN_BASE}/jobs/search/?${params.toString()}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    } catch (e) {
      console.error(`    ⚠️ Navigation failed for "${keyword}": ${e.message}`);
      continue;
    }
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    let pageNum = 0;
    while (pageNum < MAX_SEARCH_PAGES) {
      // Scroll to load all cards
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SCROLL_WAIT);

      // Get all job IDs on this page
      const pageIds = await page.evaluate(() =>
        [...new Set(
          Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))
            .map(a => a.href.match(/\/jobs\/view\/(\d+)/)?.[1])
            .filter(Boolean)
        )]
      );

      const pageJobs = [];

      for (const jobId of pageIds) {
        if (seenIds.has(jobId)) continue;

        // Click the job card to load right panel
        try {
          await page.evaluate((id) => {
            const link = document.querySelector(`a[href*="/jobs/view/${id}"]`);
            link?.closest('li')?.click() || link?.click();
          }, jobId);
          await page.waitForTimeout(CLICK_WAIT);
        } catch (e) {
          console.warn(`    ⚠️ Could not click job card ${jobId}: ${e.message}`);
        }

        // Read title, company, location from detail panel (more accurate)
        const meta = await page.evaluate(({ id, track, excludes }) => {
          const panel = document.querySelector('.jobs-unified-top-card, .job-details-jobs-unified-top-card__job-title');
          const title = document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim()
            || document.querySelector('.jobs-unified-top-card__job-title')?.textContent?.trim() || '';
          const company = document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim() || '';
          const location = document.querySelector('.job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__bullet')?.textContent?.trim() || '';

          const tl = title.toLowerCase(), cl = company.toLowerCase();
          for (const ex of excludes) {
            if (tl.includes(ex.toLowerCase()) || cl.includes(ex.toLowerCase())) return null;
          }
          return { title, company, location };
        }, { id: jobId, track: search.track, excludes: search.exclude_keywords || [] });

        if (!meta) { seenIds.add(jobId); continue; } // excluded

        // Detect apply type from right panel
        const applyInfo = await page.evaluate(({ atsPatterns }) => {
          const eaBtn = document.querySelector('button.jobs-apply-button[aria-label*="Easy Apply"]');
          if (eaBtn) return { apply_type: 'easy_apply', apply_url: null };

          const interestedBtn = document.querySelector('button[aria-label*="interested"]');
          if (interestedBtn) return { apply_type: 'recruiter_only', apply_url: null };

          // Look for external ATS link
          const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
          for (const href of allLinks) {
            for (const { name, pattern } of atsPatterns) {
              if (new RegExp(pattern).test(href)) return { apply_type: name, apply_url: href };
            }
          }

          const externalBtn = document.querySelector('button.jobs-apply-button:not([aria-label*="Easy Apply"])');
          if (externalBtn) return { apply_type: 'unknown_external', apply_url: null };

          return { apply_type: 'unknown', apply_url: null };
        }, { atsPatterns: EXTERNAL_ATS_PATTERNS.map(({ name, pattern }) => ({ name, pattern: pattern.source })) });

        seenIds.add(jobId);
        const job = {
          id: `li_${jobId}`,
          platform: 'linkedin',
          track: search.track,
          jobId,
          url: `https://www.linkedin.com/jobs/view/${jobId}/`,
          classified_at: Date.now(),
          ...meta,
          ...applyInfo,
        };
        pageJobs.push(job);
        jobs.push(job);
      }

      if (pageJobs.length > 0 && onPage) onPage(pageJobs);

      const nextBtn = await page.$('button[aria-label="View next page"]');
      if (!nextBtn) break;
      await nextBtn.click();
      await page.waitForTimeout(PAGE_LOAD_WAIT);
      pageNum++;
    }
  }

  return jobs;
}

export async function applyLinkedIn(page, job, formFiller) {
  // Use pre-classified apply_type from searcher if available
  const meta = { title: job.title, company: job.company };

  // Route by apply_type — no re-detection needed if already classified
  if (job.apply_type && job.apply_type !== 'easy_apply' && job.apply_type !== 'unknown') {
    if (job.apply_type === 'recruiter_only') return { status: 'skipped_recruiter_only', meta };
    // External ATS — skip for now, already have the URL
    return { status: 'skipped_external_unsupported', meta, externalUrl: job.apply_url || '' };
  }

  // Navigate to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  // Re-read meta from page (more accurate title/company)
  const pageMeta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  }));
  Object.assign(meta, pageMeta);

  // Verify Easy Apply button is present (classify may have been wrong)
  const eaBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}[aria-label*="Easy Apply"]`);
  const interestedBtn = await page.$('button[aria-label*="interested"]');
  const externalBtn = await page.$(`${LINKEDIN_APPLY_BUTTON_SELECTOR}:not([aria-label*="Easy Apply"])`);

  if (!eaBtn && interestedBtn) return { status: 'skipped_recruiter_only', meta };
  if (!eaBtn && externalBtn) {
    const applyLink = await page.evaluate(() => {
      const a = document.querySelector('a[href*="greenhouse"], a[href*="lever"], a[href*="workday"], a[href*="ashby"], a[href*="jobvite"], a[href*="smartrecruiters"], a[href*="icims"], a[href*="taleo"]');
      return a?.href || '';
    }).catch(() => '');
    return { status: 'skipped_external_unsupported', meta, externalUrl: applyLink };
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
