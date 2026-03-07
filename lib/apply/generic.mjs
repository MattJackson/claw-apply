/**
 * generic.mjs — Generic external ATS handler
 * Best-effort form filler for any career page with a standard HTML form.
 * Handles single-page and multi-step flows (up to 5 steps).
 * Skips pages that require account creation or have CAPTCHAs.
 */
import {
  NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, FORM_FILL_WAIT, SUBMIT_WAIT
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['unknown_external'];

const MAX_STEPS = 5;

export async function apply(page, job, formFiller) {
  const url = job.apply_url;
  if (!url) return { status: 'no_button', meta: { title: job.title, company: job.company } };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  const meta = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim()?.slice(0, 100),
    company: document.querySelector('[class*="company"] h2, h2, [class*="employer"]')?.textContent?.trim()?.slice(0, 80),
  })).catch(() => ({}));
  meta.title = meta.title || job.title;
  meta.company = meta.company || job.company;

  // Detect blockers: login walls, CAPTCHAs, closed listings
  const pageCheck = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    const hasLogin = !!(document.querySelector('input[type="password"]') ||
      (text.includes('sign in') && text.includes('create account')) ||
      (text.includes('log in') && text.includes('register')));
    // Only block on visible CAPTCHAs — invisible reCAPTCHA (size=invisible) fires on submit and usually passes
    const captchaFrames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="captcha"]'));
    const hasVisibleCaptcha = captchaFrames.some(f => {
      if (f.src.includes('size=invisible')) return false;
      const rect = f.getBoundingClientRect();
      return rect.width > 50 && rect.height > 50;
    });
    const hasCaptcha = hasVisibleCaptcha;
    const isClosed = text.includes('no longer accepting') || text.includes('position has been filled') ||
      text.includes('this job is no longer') || text.includes('job not found') ||
      text.includes('this position is closed') || text.includes('listing has expired');
    return { hasLogin, hasCaptcha, isClosed };
  }).catch(() => ({}));

  if (pageCheck.isClosed) return { status: 'closed', meta };
  if (pageCheck.hasLogin) return { status: 'skipped_login_required', meta };
  if (pageCheck.hasCaptcha) return { status: 'skipped_captcha', meta };

  // Some pages land directly on the form; others need an Apply button click
  // Check if we landed directly on a form (with or without <form> wrapper)
  const hasFormAlready = await page.$('input[type="text"], input[type="email"], textarea');
  if (!hasFormAlready) {
    const applyBtn = page.locator([
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ].join(', ')).first();

    if (await applyBtn.count() === 0) return { status: 'no_button', meta };

    // Check if Apply button opens a new tab
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null),
      applyBtn.click(),
    ]);

    if (newPage) {
      // Apply opened a new tab — switch to it
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(PAGE_LOAD_WAIT);
      // Recursively handle the new page (but return result to caller)
      return applyOnPage(newPage, job, formFiller, meta);
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

  return applyOnPage(page, job, formFiller, meta);
}

async function applyOnPage(page, job, formFiller, meta) {
  for (let step = 0; step < MAX_STEPS; step++) {
    // Fill the current page/step
    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

    if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
    if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

    // Look for submit button
    const submitBtn = await page.$([
      'button[type="submit"]:not([disabled])',
      'input[type="submit"]:not([disabled])',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
    ].join(', '));

    // Look for Next/Continue button (multi-step forms)
    const nextBtn = !submitBtn ? await page.$([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Save and Continue")',
      'a:has-text("Next")',
    ].join(', ')) : null;

    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(SUBMIT_WAIT);

      const postSubmit = await page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return {
          hasSuccess: text.includes('application submitted') || text.includes('successfully applied') ||
            text.includes('thank you') || text.includes('application received') ||
            text.includes('application has been') || text.includes('we received your'),
          hasForm: !!document.querySelector('form button[type="submit"]:not([disabled])'),
        };
      }).catch(() => ({ hasSuccess: false, hasForm: false }));

      if (postSubmit.hasSuccess || !postSubmit.hasForm) {
        return { status: 'submitted', meta };
      }

      console.log(`    [generic] Submit clicked but form still present — may not have submitted`);
      return { status: 'incomplete', meta };
    }

    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(FORM_FILL_WAIT);
      continue; // Fill next step
    }

    // No submit or next button found
    return { status: 'no_submit', meta };
  }

  console.log(`    [generic] Exceeded ${MAX_STEPS} form steps`);
  return { status: 'incomplete', meta };
}
