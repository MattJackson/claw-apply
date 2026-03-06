/**
 * wellfound.mjs — Wellfound apply handler
 */
import {
  NAVIGATION_TIMEOUT, PAGE_LOAD_WAIT, FORM_FILL_WAIT, SUBMIT_WAIT
} from '../constants.mjs';

export const SUPPORTED_TYPES = ['wellfound', 'wellfound_apply'];

export async function apply(page, job, formFiller) {
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

  const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

  if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
  if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

  const submitBtn = await page.$('button[type="submit"]:not([disabled]), input[type="submit"]');
  if (!submitBtn) return { status: 'no_submit', meta };

  await submitBtn.click();
  await page.waitForTimeout(SUBMIT_WAIT);

  return { status: 'submitted', meta };
}
