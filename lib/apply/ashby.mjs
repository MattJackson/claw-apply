/**
 * ashby.mjs — Ashby ATS handler
 *
 * Ashby forms have a consistent structure:
 * - URLs ending in /application land directly on the form
 * - Other URLs show a job listing with "Apply for this Job" button
 * - Form fields: Name, Email, Resume (file), optional extras (phone, LinkedIn, etc.)
 * - Resume input has id="_systemfield_resume"
 * - There's also an "autofill from resume" file input — don't confuse with actual resume
 * - "Upload file" buttons are type="submit" — must target "Submit Application" specifically
 * - Invisible reCAPTCHA on submit
 */
import {
  NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, FORM_FILL_WAIT, SUBMIT_WAIT
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['ashby'];

export async function apply(page, job, formFiller) {
  const url = job.apply_url;
  if (!url) return { status: 'no_button', meta: { title: job.title, company: job.company } };

  const meta = { title: job.title, company: job.company };

  // Navigate — append /application if not already there
  const applyUrl = url.includes('/application') ? url : url.replace(/\/?(\?|$)/, '/application$1');
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  await page.waitForTimeout(PAGE_LOAD_WAIT);

  // Check if we landed on the form or a listing page
  const hasForm = await page.$('#_systemfield_name, input[name="_systemfield_name"]');
  if (!hasForm) {
    // Try clicking "Apply for this Job"
    const applyBtn = page.locator('button:has-text("Apply for this Job"), a:has-text("Apply for this Job")').first();
    if (await applyBtn.count() === 0) return { status: 'no_button', meta };
    await applyBtn.click();
    await page.waitForTimeout(FORM_FILL_WAIT);
  }

  // Check for closed listing
  const closed = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return text.includes('no longer accepting') || text.includes('position has been filled') ||
      text.includes('no longer available') || text.includes('does not exist');
  }).catch(() => false);
  if (closed) return { status: 'closed', meta };

  // Fill form fields
  const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);
  if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
  if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

  // Upload resume to the correct file input (not the autofill one)
  const resumeInput = await page.$('#_systemfield_resume');
  if (resumeInput && formFiller.profile.resume_path) {
    await resumeInput.setInputFiles(formFiller.profile.resume_path).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Click "Submit Application" specifically — NOT the "Upload file" buttons
  const submitBtn = page.locator('button:has-text("Submit Application")').first();
  if (await submitBtn.count() === 0) return { status: 'no_submit', meta };

  await submitBtn.click();
  await page.waitForTimeout(SUBMIT_WAIT);

  // Verify submission
  const postSubmit = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return {
      hasSuccess: text.includes('thank you') || text.includes('application submitted') ||
        text.includes('application received') || text.includes('successfully'),
      hasForm: !!document.querySelector('#_systemfield_name'),
    };
  }).catch(() => ({ hasSuccess: false, hasForm: false }));

  if (postSubmit.hasSuccess || !postSubmit.hasForm) {
    return { status: 'submitted', meta };
  }

  return { status: 'incomplete', meta };
}
