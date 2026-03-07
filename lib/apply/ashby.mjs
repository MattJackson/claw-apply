/**
 * ashby.mjs — Ashby ATS handler (extends generic)
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['ashby'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    transformUrl: (url) => url.includes('/application') ? url : url.replace(/\/?(\?|$)/, '/application$1'),
    closedTexts: ['job not found', 'the job you requested was not found'],
    formDetector: '#_systemfield_name',
    applyButtonSelector: 'button:has-text("Apply for this Job"), a:has-text("Apply for this Job")',
    submitSelector: 'button:has-text("Submit Application")',
    verifySelector: '#_systemfield_name',
    beforeSubmit: async (page, formFiller) => {
      if (!formFiller.profile.resume_path) return;
      // Ashby wraps resume upload in a custom component — find the actual file input
      const fileInput = await page.$('#_systemfield_resume input[type="file"]') ||
        await page.$('input[type="file"][name*="resume"]') ||
        await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(formFiller.profile.resume_path).catch(() => {});
        await page.waitForTimeout(1500);
      }
    },
  });
}
