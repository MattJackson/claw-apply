/**
 * easy_apply.mjs — LinkedIn Easy Apply handler
 * Handles the LinkedIn Easy Apply modal flow
 *
 * Button detection strategy: LinkedIn frequently changes aria-labels and button
 * structure. We use multiple fallback strategies:
 * 1. aria-label exact match (fastest, but brittle)
 * 2. aria-label substring match (handles minor text changes)
 * 3. Exact button text match (most resilient — matches trimmed innerText)
 * All searches are scoped to the modal dialog to avoid clicking page buttons.
 *
 * Modal flow: Easy Apply → [fill → Next] × N → Review → Submit application
 * Check order per step: Next → Review → Submit (only submit when no forward nav exists)
 */
import {
  NAVIGATION_TIMEOUT, CLICK_WAIT, MODAL_STEP_WAIT,
  SUBMIT_WAIT, DISMISS_TIMEOUT, APPLY_CLICK_TIMEOUT,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR, LINKEDIN_APPLY_BUTTON_SELECTOR,
  LINKEDIN_MAX_MODAL_STEPS
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['easy_apply'];

/**
 * Find a non-disabled button inside the modal using multiple strategies.
 * @param {Page} page - Playwright page
 * @param {string} modalSelector - CSS selector for the modal container
 * @param {Object} opts
 * @param {string[]} opts.ariaLabels - aria-label values to try (exact then substring)
 * @param {string[]} opts.exactTexts - exact button text matches (case-insensitive, trimmed)
 * @returns {ElementHandle|null}
 */
async function findModalButton(page, modalSelector, { ariaLabels = [], exactTexts = [] }) {
  // Strategy 1: aria-label exact match inside modal (non-disabled only)
  for (const label of ariaLabels) {
    const btn = await page.$(`${modalSelector} button[aria-label="${label}"]:not([disabled])`);
    if (btn) return btn;
  }

  // Strategy 2: aria-label substring match inside modal
  for (const label of ariaLabels) {
    const btn = await page.$(`${modalSelector} button[aria-label*="${label}"]:not([disabled])`);
    if (btn) return btn;
  }

  // Strategy 3: exact text match on button innerText (case-insensitive, trimmed)
  // Uses evaluateHandle to return a live DOM reference
  if (exactTexts.length === 0) return null;

  const handle = await page.evaluateHandle((sel, texts) => {
    const modal = document.querySelector(sel);
    if (!modal) return null;
    const targets = texts.map(t => t.toLowerCase());
    const buttons = modal.querySelectorAll('button:not([disabled])');
    for (const btn of buttons) {
      // Use innerText (not textContent) to get rendered text without hidden children
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (targets.includes(text)) return btn;
    }
    return null;
  }, modalSelector, exactTexts).catch(() => null);

  if (handle) {
    const el = handle.asElement();
    if (el) return el;
    await handle.dispose().catch(() => {});
  }

  return null;
}

export async function apply(page, job, formFiller) {
  const meta = { title: job.title, company: job.company };

  // Navigate to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });

  // Scroll slightly to trigger lazy-loaded content, then wait for Easy Apply button
  await page.evaluate(() => window.scrollTo(0, 300)).catch(() => {});
  const eaBtn = await page.waitForSelector(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: 12000, state: 'attached' }).catch(() => null);
  if (!eaBtn) {
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

  const MODAL = LINKEDIN_EASY_APPLY_MODAL_SELECTOR;

  // Step through modal
  let lastProgress = '-1';
  for (let step = 0; step < LINKEDIN_MAX_MODAL_STEPS; step++) {
    const modalStillOpen = await page.$(MODAL);
    if (!modalStillOpen) {
      console.log(`    ✅ Modal closed — submitted`);
      return { status: 'submitted', meta };
    }

    const progress = await page.$eval(`${MODAL} [role="progressbar"]`,
      el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || el.style?.width || ''
    ).catch(() => '');

    // Debug snapshot: heading, buttons in modal, and any validation errors
    const debugInfo = await page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      if (!modal) return { heading: '', buttons: [], errors: [] };
      const heading = modal.querySelector('h1, h2, h3, [class*="title"], [class*="heading"]')?.textContent?.trim()?.slice(0, 60) || '';
      const buttons = Array.from(modal.querySelectorAll('button, [role="button"]')).map(b => ({
        text: (b.innerText || b.textContent || '').trim().slice(0, 50),
        aria: b.getAttribute('aria-label'),
        disabled: b.disabled,
      })).filter(b => b.text || b.aria);
      const errors = Array.from(modal.querySelectorAll('[class*="error"], [aria-invalid="true"], .artdeco-inline-feedback--error'))
        .map(e => e.textContent?.trim().slice(0, 60)).filter(Boolean);
      return { heading, buttons, errors };
    }, MODAL).catch(() => ({ heading: '', buttons: [], errors: [] }));
    console.log(`    [step ${step}] progress=${progress} heading="${debugInfo.heading}" buttons=${JSON.stringify(debugInfo.buttons)}${debugInfo.errors.length ? ' errors=' + JSON.stringify(debugInfo.errors) : ''}`);

    // Fill form fields
    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);
    if (unknowns.length > 0) console.log(`    [step ${step}] unknown fields: ${JSON.stringify(unknowns.map(u => u.label || u))}`);

    if (unknowns[0]?.honeypot) {
      await dismissModal(page, MODAL);
      return { status: 'skipped_honeypot', meta };
    }

    if (unknowns.length > 0) {
      await dismissModal(page, MODAL);
      return { status: 'needs_answer', pending_question: unknowns[0], meta };
    }

    await page.waitForTimeout(MODAL_STEP_WAIT);

    // --- Button check order: Next → Review → Submit ---
    // Check Next first — only fall through to Submit when there's no forward navigation.
    // This prevents accidentally clicking a Submit-like element on early modal steps.

    // Check for Next button
    const nextBtn = await findModalButton(page, MODAL, {
      ariaLabels: ['Continue to next step'],
      exactTexts: ['Next'],
    });
    if (nextBtn) {
      console.log(`    [step ${step}] clicking Next`);
      await nextBtn.click({ timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    // Check for Review button
    const reviewBtn = await findModalButton(page, MODAL, {
      ariaLabels: ['Review your application'],
      exactTexts: ['Review'],
    });
    if (reviewBtn) {
      console.log(`    [step ${step}] clicking Review`);
      await reviewBtn.click({ timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT);
      lastProgress = progress;
      continue;
    }

    // Check for Submit button (only when no Next/Review exists)
    const submitBtn = await findModalButton(page, MODAL, {
      ariaLabels: ['Submit application'],
      exactTexts: ['Submit application'],
    });
    if (submitBtn) {
      console.log(`    [step ${step}] clicking Submit`);
      await submitBtn.click({ timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(SUBMIT_WAIT);
      return { status: 'submitted', meta };
    }

    // Stuck detection — progress hasn't changed and we've been through a few steps
    if (progress && progress === lastProgress && step > 2) {
      console.log(`    [step ${step}] stuck — progress unchanged at ${progress}`);
      await dismissModal(page, MODAL);
      return { status: 'stuck', meta };
    }

    console.log(`    [step ${step}] no Next/Review/Submit found — breaking`);
    break;
  }

  await dismissModal(page, MODAL);
  return { status: 'incomplete', meta };
}

/**
 * Dismiss the Easy Apply modal.
 * Tries multiple strategies: Dismiss button → Close/X → Escape key.
 * Handles the "Discard" confirmation dialog that appears after Escape.
 */
async function dismissModal(page, modalSelector) {
  // Try aria-label Dismiss
  const dismissBtn = await page.$(`${modalSelector} button[aria-label="Dismiss"]`);
  if (dismissBtn) {
    await dismissBtn.click({ timeout: DISMISS_TIMEOUT }).catch(() => {});
    return;
  }

  // Try close/X button
  const closeBtn = await page.$(`${modalSelector} button[aria-label="Close"], ${modalSelector} button[aria-label*="close"]`);
  if (closeBtn) {
    await closeBtn.click({ timeout: DISMISS_TIMEOUT }).catch(() => {});
    return;
  }

  // Fallback: Escape key
  await page.keyboard.press('Escape').catch(() => {});

  // Handle "Discard" confirmation dialog that may appear after Escape
  const discardBtn = await page.waitForSelector(
    'button[data-test-dialog-primary-btn]',
    { timeout: DISMISS_TIMEOUT, state: 'visible' }
  ).catch(() => null);
  if (discardBtn) {
    await discardBtn.click().catch(() => {});
    return;
  }

  // Last resort: find Discard by exact text
  const handle = await page.evaluateHandle(() => {
    for (const b of document.querySelectorAll('button')) {
      if ((b.innerText || '').trim().toLowerCase() === 'discard') return b;
    }
    return null;
  }).catch(() => null);
  const el = handle?.asElement();
  if (el) await el.click().catch(() => {});
  else await handle?.dispose().catch(() => {});
}
