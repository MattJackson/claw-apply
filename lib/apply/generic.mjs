/**
 * generic.mjs — Configurable external ATS handler
 *
 * Base apply logic for any career page. ATS-specific handlers pass
 * an options object to customize URL transformation, selectors,
 * resume targeting, and submission verification.
 *
 * Options:
 *   transformUrl(url)       — modify the apply URL before navigation
 *   formDetector            — CSS selector to detect if form is already loaded
 *   applyButtonSelector     — selector for the "Apply" button on listing pages
 *   resumeSelector          — CSS selector for the resume file input
 *   submitSelector          — selector for the submit button (use locator syntax)
 *   verifySelector          — CSS selector to check if form is still present after submit
 *   beforeSubmit(page)      — async hook to run before clicking submit (e.g. upload resume)
 *   closedTexts             — extra strings to detect closed listings
 */
import {
  NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, FORM_FILL_WAIT, SUBMIT_WAIT
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['unknown_external'];

const MAX_STEPS = 5;

const DEFAULT_APPLY_BUTTONS = [
  'a:has-text("Apply Now")',
  'button:has-text("Apply Now")',
  'a:has-text("Apply for this job")',
  'button:has-text("Apply for this job")',
  'a:has-text("Apply")',
  'button:has-text("Apply")',
].join(', ');

const DEFAULT_SUBMIT_BUTTONS = [
  'button:has-text("Submit Application")',
  'button:has-text("Submit your application")',
  'button:has-text("Apply Now")',
  'button:has-text("Apply for this job")',
  'input[type="submit"]:not([disabled])',
  'button[type="submit"]:not([disabled])',
].join(', ');

const DEFAULT_NEXT_BUTTONS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Save and Continue")',
  'a:has-text("Next")',
].join(', ');

const CLOSED_TEXTS = [
  'no longer accepting', 'position has been filled',
  'this job is no longer', 'job not found',
  'this position is closed', 'listing has expired',
  'no longer available', 'page you are looking for',
  'job may be no longer', 'does not exist',
  'this role has been filled', 'posting has closed',
];

export async function apply(page, job, formFiller, opts = {}) {
  const url = opts.transformUrl ? opts.transformUrl(job.apply_url) : job.apply_url;
  if (!url) return { status: 'no_button', meta: { title: job.title, company: job.company } };

  const meta = { title: job.title, company: job.company };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  // Detect blockers
  const extraClosed = opts.closedTexts || [];
  const pageCheck = await page.evaluate((extraClosed) => {
    const text = (document.body.innerText || '').toLowerCase();
    const hasLogin = !!(document.querySelector('input[type="password"]') ||
      (text.includes('sign in') && text.includes('create account')) ||
      (text.includes('log in') && text.includes('register')));
    const captchaFrames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="captcha"]'));
    const hasCaptcha = captchaFrames.some(f => {
      if (f.src.includes('size=invisible')) return false;
      const rect = f.getBoundingClientRect();
      return rect.width > 50 && rect.height > 50;
    });
    const closedTexts = [
      'no longer accepting', 'position has been filled',
      'this job is no longer', 'job not found',
      'this position is closed', 'listing has expired',
      'no longer available', 'page you are looking for',
      'job may be no longer', 'does not exist',
      'this role has been filled', 'posting has closed',
      ...extraClosed,
    ];
    const isClosed = closedTexts.some(t => text.includes(t)) || document.title.toLowerCase().includes('404');
    return { hasLogin, hasCaptcha, isClosed };
  }, extraClosed).catch(() => ({}));

  if (pageCheck.isClosed) return { status: 'closed', meta };
  if (pageCheck.hasLogin) return { status: 'skipped_login_required', meta };
  if (pageCheck.hasCaptcha) return { status: 'skipped_captcha', meta };

  // Check if form is already loaded
  const formSelector = opts.formDetector || 'input[type="text"], input[type="email"], textarea';
  const hasFormAlready = await page.$(formSelector);
  if (!hasFormAlready) {
    const applySelector = opts.applyButtonSelector || DEFAULT_APPLY_BUTTONS;
    const applyBtn = page.locator(applySelector).first();

    if (await applyBtn.count() === 0) return { status: 'no_button', meta };

    // Check if Apply button opens a new tab
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null),
      applyBtn.click(),
    ]);

    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(PAGE_LOAD_WAIT);
      return fillAndSubmit(newPage, job, formFiller, meta, opts);
    }

    await page.waitForTimeout(FORM_FILL_WAIT);

    // Re-check for blockers after click
    const postClick = await page.evaluate(() => ({
      hasLogin: !!document.querySelector('input[type="password"]'),
      hasCaptcha: Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="captcha"]'))
        .some(f => !f.src.includes('size=invisible') && f.getBoundingClientRect().width > 50),
    })).catch(() => ({}));
    if (postClick.hasLogin) return { status: 'skipped_login_required', meta };
    if (postClick.hasCaptcha) return { status: 'skipped_captcha', meta };
  }

  return fillAndSubmit(page, job, formFiller, meta, opts);
}

async function fillAndSubmit(page, job, formFiller, meta, opts) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

    if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
    if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

    // Hook: before submit (e.g. targeted resume upload)
    if (opts.beforeSubmit) await opts.beforeSubmit(page, formFiller);

    // Find submit button
    const submitSelector = opts.submitSelector || DEFAULT_SUBMIT_BUTTONS;
    const submitBtn = page.locator(submitSelector).first();
    const hasSubmit = await submitBtn.count() > 0;

    if (hasSubmit) {
      await submitBtn.click();

      // Wait for submission — poll for success or form disappearance
      // (invisible reCAPTCHA + server round-trip can take several seconds)
      const verifySelector = opts.verifySelector || 'form button[type="submit"]:not([disabled])';
      let postSubmit = { hasSuccess: false, hasForm: true, validationErrors: [] };
      for (let wait = 0; wait < 10; wait++) {
        await page.waitForTimeout(wait === 0 ? SUBMIT_WAIT : 3000);
        postSubmit = await page.evaluate((vs) => {
          const text = (document.body.innerText || '').toLowerCase();
          const errorEls = document.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"]');
          const validationErrors = Array.from(errorEls)
            .map(el => el.innerText?.trim())
            .filter(t => t && t.length < 200)
            .slice(0, 3);
          return {
            hasSuccess: text.includes('application submitted') || text.includes('successfully applied') ||
              text.includes('thank you') || text.includes('application received') ||
              text.includes('application has been') || text.includes('we received your'),
            hasForm: !!document.querySelector(vs),
            validationErrors,
          };
        }, verifySelector).catch(() => ({ hasSuccess: false, hasForm: false, validationErrors: [] }));

        if (postSubmit.hasSuccess || !postSubmit.hasForm) {
          return { status: 'submitted', meta };
        }
        // Stop polling if validation errors appeared (form didn't submit)
        if (postSubmit.validationErrors.length > 0) break;
      }

      return {
        status: 'incomplete', meta,
        ...(postSubmit.validationErrors?.length && { validation_errors: postSubmit.validationErrors }),
      };
    }

    // Multi-step: Next/Continue
    const nextBtn = await page.$(DEFAULT_NEXT_BUTTONS);
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(FORM_FILL_WAIT);
      continue;
    }

    return { status: 'no_submit', meta };
  }

  return { status: 'incomplete', meta };
}
