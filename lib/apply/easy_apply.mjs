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

  // Scroll slightly to trigger lazy-loaded content, then wait for Easy Apply button
  await page.evaluate(() => window.scrollTo(0, 300)).catch(() => {});
  const eaBtn = await page.waitForSelector(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: 12000, state: 'attached' }).catch(() => null);
  if (!eaBtn) {
    // Debug: log what apply-related elements exist
    const applyEls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-label*="Easy Apply"], [aria-label*="Apply"]'))
        .map(el => ({ tag: el.tagName, aria: el.getAttribute('aria-label'), visible: el.offsetParent !== null }))
    ).catch(() => []);
    console.log(`    ℹ️  No Easy Apply element found. Apply-related elements: ${JSON.stringify(applyEls)}`);
    return { status: 'skipped_easy_apply_unsupported', meta };
  }

  // Re-read meta after page settled
  const pageMeta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  }));
  Object.assign(meta, pageMeta);

  // Click Easy Apply and wait for modal to appear
  await page.click(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
  const modal = await page.waitForSelector(LINKEDIN_EASY_APPLY_MODAL_SELECTOR, { timeout: 8000 }).catch(() => null);
  if (!modal) return { status: 'no_modal', meta };

  // Step through modal
  let lastProgress = '-1';
  for (let step = 0; step < LINKEDIN_MAX_MODAL_STEPS; step++) {
    const modalStillOpen = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR);
    if (!modalStillOpen) {
      console.log(`    ✅ Modal closed — submitted`);
      return { status: 'submitted', meta };
    }

    const progress = await page.$eval('[role="progressbar"]',
      el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || String(el.style?.width || step)
    ).catch(() => String(step));

    // Snapshot modal heading + all page-level buttons for debugging
    const debugInfo = await page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      const heading = modal?.querySelector('h1, h2, h3, [class*="title"], [class*="heading"]')?.textContent?.trim()?.slice(0, 60) || '';
      const realProgress = document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ||
                           document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext') || null;
      const allBtns = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().slice(0, 40),
        aria: b.getAttribute('aria-label'),
        disabled: b.disabled,
      })).filter(b => (b.text || b.aria) && !['Home', 'Jobs', 'Me', 'For Business', 'Save the job'].includes(b.aria));
      const errors = Array.from(document.querySelectorAll('[class*="error"], [aria-invalid="true"], .artdeco-inline-feedback--error'))
        .map(e => e.textContent?.trim().slice(0, 60)).filter(Boolean);
      return { heading, realProgress, allBtns, errors };
    }, LINKEDIN_EASY_APPLY_MODAL_SELECTOR).catch(() => ({}));
    console.log(`    [step ${step}] heading="${debugInfo.heading}" realProgress=${debugInfo.realProgress} buttons=${JSON.stringify(debugInfo.allBtns)} errors=${JSON.stringify(debugInfo.errors)}`);

    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);
    if (unknowns.length > 0) console.log(`    [step ${step}] unknown fields: ${JSON.stringify(unknowns.map(u => u.label))}`);

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
      console.log(`    [step ${step}] clicking Submit`);
      await page.click(LINKEDIN_SUBMIT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT });
      await page.waitForTimeout(SUBMIT_WAIT);
      return { status: 'submitted', meta };
    }

    if (progress === lastProgress && step > 2) {
      console.log(`    [step ${step}] stuck — progress unchanged at ${progress}`);
      await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
      return { status: 'stuck', meta };
    }

    const hasNext = await page.$(LINKEDIN_NEXT_SELECTOR);
    if (hasNext) {
      console.log(`    [step ${step}] clicking Next`);
      await page.click(LINKEDIN_NEXT_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    const hasReview = await page.$(LINKEDIN_REVIEW_SELECTOR);
    if (hasReview) {
      console.log(`    [step ${step}] clicking Review`);
      await page.click(LINKEDIN_REVIEW_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    console.log(`    [step ${step}] no Next/Review/Submit found — breaking`);
    break;
  }

  await page.click(LINKEDIN_DISMISS_SELECTOR, { timeout: DISMISS_TIMEOUT }).catch(() => {});
  return { status: 'incomplete', meta };
}
