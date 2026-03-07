/**
 * greenhouse.mjs — Greenhouse ATS handler (extends generic)
 *
 * Greenhouse boards show the form directly on the page (no Apply button needed).
 * Form ID: #application-form. Resume input: #resume. Submit: "Submit application".
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['greenhouse'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    formDetector: '#application-form',
    submitSelector: 'button:has-text("Submit application"), input[type="submit"]',
    verifySelector: '#application-form',
    beforeSubmit: async (page, formFiller) => {
      if (!formFiller.profile.resume_path) return;
      const resumeInput = await page.$('#resume');
      if (resumeInput) {
        const hasFile = await resumeInput.evaluate(el => !!el.value);
        if (!hasFile) {
          await resumeInput.setInputFiles(formFiller.profile.resume_path).catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
    },
  });
}
