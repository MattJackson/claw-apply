/**
 * easy_apply.mjs — LinkedIn Easy Apply handler
 * Handles the LinkedIn Easy Apply modal flow
 *
 * IMPORTANT: LinkedIn renders the Easy Apply modal inside shadow DOM.
 * This means document.querySelector() inside evaluate() CANNOT find it.
 * Playwright's page.$() pierces shadow DOM, so we use ElementHandle-based
 * operations throughout — never document.querySelector for the modal.
 *
 * Button detection strategy: LinkedIn frequently changes aria-labels and button
 * structure. We use multiple fallback strategies:
 * 1. CSS selector via page.$() (pierces shadow DOM)
 * 2. ElementHandle.evaluate() for text matching (runs on already-found elements)
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
 * All searches use page.$() which pierces shadow DOM, unlike document.querySelector().
 *
 * @param {Page} page - Playwright page
 * @param {string} modalSelector - CSS selector for the modal container
 * @param {Object} opts
 * @param {string[]} opts.ariaLabels - aria-label values to try (exact then substring)
 * @param {string[]} opts.exactTexts - exact button text matches (case-insensitive, trimmed)
 * @returns {ElementHandle|null}
 */
async function findModalButton(page, modalSelector, { ariaLabels = [], exactTexts = [] }) {
  // Strategy 1: aria-label exact match inside modal (non-disabled only)
  // page.$() pierces shadow DOM — safe to use compound selectors
  for (const label of ariaLabels) {
    const btn = await page.$(`${modalSelector} button[aria-label="${label}"]:not([disabled])`);
    if (btn) return btn;
  }

  // Strategy 2: aria-label substring match inside modal
  for (const label of ariaLabels) {
    const btn = await page.$(`${modalSelector} button[aria-label*="${label}"]:not([disabled])`);
    if (btn) return btn;
  }

  // Strategy 3: find modal via page.$(), then scan buttons via ElementHandle.evaluate()
  // This works because evaluate() on an ElementHandle runs in the element's context
  if (exactTexts.length === 0) return null;

  const modal = await page.$(modalSelector);
  if (!modal) return null;

  // Get all non-disabled buttons inside the modal
  const buttons = await modal.$$('button:not([disabled])');
  const targets = exactTexts.map(t => t.toLowerCase());

  for (const btn of buttons) {
    const text = await btn.evaluate(el =>
      (el.innerText || el.textContent || '').trim().toLowerCase()
    ).catch(() => '');
    if (targets.includes(text)) return btn;
  }

  return null;
}

/**
 * Get debug info about the modal using ElementHandle operations.
 * Does NOT use document.querySelector — uses page.$() which pierces shadow DOM.
 */
async function getModalDebugInfo(page, modalSelector) {
  const modal = await page.$(modalSelector);
  if (!modal) return { heading: '', buttons: [], errors: [] };

  const heading = await modal.$eval(
    'h1, h2, h3, [class*="title"], [class*="heading"]',
    el => el.textContent?.trim()?.slice(0, 60) || ''
  ).catch(() => '');

  const buttonEls = await modal.$$('button, [role="button"]');
  const buttons = [];
  for (const b of buttonEls) {
    const info = await b.evaluate(el => ({
      text: (el.innerText || el.textContent || '').trim().slice(0, 50),
      aria: el.getAttribute('aria-label'),
      disabled: el.disabled,
    })).catch(() => null);
    if (info && (info.text || info.aria)) buttons.push(info);
  }

  const errorEls = await modal.$$('[class*="error"], [aria-invalid="true"], .artdeco-inline-feedback--error');
  const errors = [];
  for (const e of errorEls) {
    const text = await e.evaluate(el => el.textContent?.trim()?.slice(0, 60) || '').catch(() => '');
    if (text) errors.push(text);
  }

  return { heading, buttons, errors };
}

export async function apply(page, job, formFiller) {
  const meta = { title: job.title, company: job.company };

  // Navigate to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });

  // Scroll slightly to trigger lazy-loaded content, then wait for Easy Apply button
  await page.evaluate(() => window.scrollTo(0, 300)).catch(() => {});
  let eaBtn = await page.waitForSelector(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: 12000, state: 'attached' }).catch(() => null);

  // Fallback: LinkedIn shows plain "Continue" when a draft exists (span > span > a)
  // The <a> has href containing /apply/ — find it via evaluateHandle in each frame
  // (page.$() may not pierce LinkedIn's specific shadow DOM setup)
  if (!eaBtn) {
    for (const frame of page.frames()) {
      const handle = await frame.evaluateHandle(() => {
        const links = document.querySelectorAll('a[href*="/apply/"]');
        for (const a of links) {
          if (/continue/i.test((a.innerText || '').trim())) return a;
        }
        return null;
      }).catch(() => null);
      if (handle) {
        const el = handle.asElement();
        if (el) {
          eaBtn = el;
          console.log(`    ℹ️  Found "Continue" link (draft application)`);
          break;
        }
        await handle.dispose().catch(() => {});
      }
    }
  }

  if (!eaBtn) {
    console.log(`    ℹ️  No Easy Apply button found. Page URL: ${page.url()}`);
    console.log(`    Action: job may have been removed, filled, or changed to external apply`);
    return { status: 'skipped_easy_apply_unsupported', meta };
  }

  // Re-read meta after page settled
  const pageMeta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  })).catch(() => ({}));
  Object.assign(meta, pageMeta);

  // Click Easy Apply and wait for modal to appear
  await page.click(LINKEDIN_APPLY_BUTTON_SELECTOR, { timeout: APPLY_CLICK_TIMEOUT }).catch(() => {});
  const modal = await page.waitForSelector(LINKEDIN_EASY_APPLY_MODAL_SELECTOR, { timeout: 8000 }).catch(() => null);
  if (!modal) {
    console.log(`    ❌ Modal did not open after clicking Easy Apply`);
    console.log(`    Action: LinkedIn may have changed the modal structure or login expired`);
    return { status: 'no_modal', meta };
  }

  const MODAL = LINKEDIN_EASY_APPLY_MODAL_SELECTOR;

  // Step through modal
  let lastProgress = '-1';
  let lastHeading = '';
  let samePageCount = 0;
  for (let step = 0; step < LINKEDIN_MAX_MODAL_STEPS; step++) {
    const modalStillOpen = await page.$(MODAL);
    if (!modalStillOpen) {
      console.log(`    ✅ Modal closed — submitted`);
      return { status: 'submitted', meta };
    }

    // Read progress bar — use page.$() + evaluate on the handle
    const progressEl = await page.$(`${MODAL} [role="progressbar"]`);
    const progress = progressEl
      ? await progressEl.evaluate(el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || el.style?.width || '').catch(() => '')
      : '';

    // Debug snapshot using ElementHandle operations (shadow DOM safe)
    const debugInfo = await getModalDebugInfo(page, MODAL);
    console.log(`    [step ${step}] progress=${progress} heading="${debugInfo.heading}" buttons=${JSON.stringify(debugInfo.buttons)}${debugInfo.errors.length ? ' errors=' + JSON.stringify(debugInfo.errors) : ''}`);

    // Fill form fields — page.$() in form_filler pierces shadow DOM
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

    // Check for validation errors after form fill (shadow DOM safe)
    const postModal = await page.$(MODAL);
    const postFillErrors = [];
    if (postModal) {
      const errorEls = await postModal.$$('[class*="error"], [aria-invalid="true"], .artdeco-inline-feedback--error');
      for (const e of errorEls) {
        const text = await e.evaluate(el => el.textContent?.trim()?.slice(0, 80) || '').catch(() => '');
        if (text) postFillErrors.push(text);
      }
    }

    if (postFillErrors.length > 0) {
      console.log(`    [step ${step}] ❌ Validation errors after fill: ${JSON.stringify(postFillErrors)}`);
      console.log(`    Action: check answers.json or profile.json for missing/wrong answers`);
      await dismissModal(page, MODAL);
      return { status: 'incomplete', meta, validation_errors: postFillErrors };
    }

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

      // Detect if we're stuck — same heading+progress means page didn't advance
      const curHeading = debugInfo.heading;
      if (curHeading === lastHeading && progress === lastProgress) {
        samePageCount++;
        if (samePageCount >= 2) {
          console.log(`    [step ${step}] stuck — clicked Next but page didn't advance (${samePageCount} times)`);
          console.log(`    Action: a required field may be unfilled. Check select dropdowns still at "Select an option"`);
          await dismissModal(page, MODAL);
          return { status: 'stuck', meta };
        }
      } else {
        samePageCount = 0;
      }
      lastProgress = progress;
      lastHeading = curHeading;
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
      lastHeading = debugInfo.heading;
      samePageCount = 0;
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

      // Verify modal closed
      const modalGone = !(await page.$(MODAL));
      if (modalGone) {
        console.log(`    ✅ Submit confirmed — modal closed`);
        return { status: 'submitted', meta };
      }

      // Modal still open — submit may have failed
      console.log(`    [step ${step}] ⚠️  Modal still open after Submit click`);
      console.log(`    Action: submit may have failed due to validation or network error`);
      await dismissModal(page, MODAL);
      return { status: 'incomplete', meta };
    }

    // Stuck detection — no Next/Review/Submit found
    // (stuck-after-click detection is handled above in the Next button section)

    console.log(`    [step ${step}] ❌ No Next/Review/Submit button found in modal`);
    console.log(`    Action: LinkedIn may have changed button text/structure. Check button snapshot above.`);
    break;
  }

  await dismissModal(page, MODAL);
  return { status: 'incomplete', meta };
}

/**
 * Dismiss the Easy Apply modal.
 * Tries multiple strategies: Dismiss button → Close/X → Escape key.
 * Handles the "Discard" confirmation dialog that appears after Escape.
 * All searches use page.$() which pierces shadow DOM.
 */
async function dismissModal(page, modalSelector) {
  // Step 1: Close the modal — Dismiss button, Close/X, or Escape
  const dismissBtn = await page.$(`${modalSelector} button[aria-label="Dismiss"]`);
  if (dismissBtn) {
    await dismissBtn.click({ timeout: DISMISS_TIMEOUT }).catch(() => {});
  } else {
    const closeBtn = await page.$(`${modalSelector} button[aria-label="Close"], ${modalSelector} button[aria-label*="close"]`);
    if (closeBtn) {
      await closeBtn.click({ timeout: DISMISS_TIMEOUT }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // Step 2: LinkedIn shows a "Discard" confirmation — always wait for it and click
  const discardBtn = await page.waitForSelector(
    'button[data-test-dialog-primary-btn]',
    { timeout: DISMISS_TIMEOUT, state: 'visible' }
  ).catch(() => null);
  if (discardBtn) {
    await discardBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    return;
  }

  // Fallback: find Discard by text — scan all buttons via page.$$()
  const allBtns = await page.$$('button');
  for (const btn of allBtns) {
    const text = await btn.evaluate(el => (el.innerText || '').trim().toLowerCase()).catch(() => '');
    if (text === 'discard') {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}
