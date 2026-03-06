/**
 * easy_apply.mjs — LinkedIn Easy Apply handler
 * Handles the LinkedIn Easy Apply modal flow
 */
import {
  NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, CLICK_WAIT, MODAL_STEP_WAIT,
  SUBMIT_WAIT, DISMISS_TIMEOUT, APPLY_CLICK_TIMEOUT,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR, LINKEDIN_APPLY_BUTTON_SELECTOR,
  LINKEDIN_SUBMIT_SELECTOR, LINKEDIN_NEXT_SELECTOR,
  LINKEDIN_REVIEW_SELECTOR, LINKEDIN_DISMISS_SELECTOR,
  LINKEDIN_MAX_MODAL_STEPS
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['easy_apply'];

export async function apply(page, job, formFiller) {
  const meta = { title: job.title, company: job.company };

  // Navigate to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });

  // Wait for Easy Apply button to appear (up to PAGE_LOAD_WAIT)
  const eaBtn = await page.waitForSelector(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: PAGE_LOAD_WAIT }).catch(() => null);
  if (!eaBtn) return { status: 'skipped_easy_apply_unsupported', meta };

  // Re-read meta after page settled
  const pageMeta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  }));
  Object.assign(meta, pageMeta);

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

    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

    if (unknowns[0]?.honeypot) {
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'skipped_honeypot', meta };
    }

    if (unknowns.length > 0) {
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'needs_answer', pending_question: unknowns[0], meta };
    }

    await page.waitForTimeout(MODAL_STEP_WAIT);

    const hasSubmit = await page.$(LINKEDIN_SUBMIT_SELECTOR);
    if (hasSubmit) {
      await page.click(LINKEDIN_SUBMIT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT });
      await page.waitForTimeout(SUBMIT_WAIT);
      return { status: 'submitted', meta };
    }

    if (progress === lastProgress && step > 2) {
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'stuck', meta };
    }

    const hasNext = await page.$(LINKEDIN_NEXT_SELECTOR);
    if (hasNext) {
      await page.click(LINKEDIN_NEXT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

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
