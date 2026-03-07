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
      // Upload resume
      if (formFiller.profile.resume_path) {
        const resumeInput = await page.$('#resume');
        if (resumeInput) {
          const hasFile = await resumeInput.evaluate(el => !!el.value);
          if (!hasFile) {
            await resumeInput.setInputFiles(formFiller.profile.resume_path).catch(() => {});
            await page.waitForTimeout(1000);
          }
        }
      }

      // Fix React Select dropdowns (Country, Location) — fill() doesn't trigger them
      const reactSelects = [
        { id: 'country', value: formFiller.profile.location?.country || 'United States' },
        { id: 'candidate-location', value: `${formFiller.profile.location?.city || ''}, ${formFiller.profile.location?.state || ''}` },
      ];
      for (const { id, value } of reactSelects) {
        const el = await page.$(`#${id}`);
        if (!el) continue;
        const currentVal = await el.evaluate(e => e.value);
        // Check if React Select already has a selection
        const hasSelection = await page.evaluate((inputId) => {
          const singleVal = document.querySelector(`#${inputId}`)?.closest('[class*="select__"]')?.querySelector('[class*="singleValue"]');
          return !!singleVal;
        }, id);
        if (hasSelection) continue;

        await el.click();
        await el.evaluate(e => { e.value = ''; });
        await el.type(value, { delay: 30 });
        await page.waitForTimeout(1000);
        const option = await page.$(`[id*="react-select-${id}-option"]`);
        if (option) {
          await option.click();
          await page.waitForTimeout(300);
        }
      }
    },
  });
}
