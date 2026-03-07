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
      // Upload resume — #_systemfield_resume IS the file input (not a container)
      if (formFiller.profile.resume_path) {
        const fileInput = await page.$('input[type="file"]#_systemfield_resume') ||
          await page.$('input[type="file"]');
        if (fileInput) {
          const hasFile = await fileInput.evaluate(el => !!el.value);
          if (!hasFile) {
            await fileInput.setInputFiles(formFiller.profile.resume_path).catch(() => {});
            await page.waitForTimeout(2000);
          }
        }
      }

      // Ashby uses button-style Yes/No for questions (not radios/fieldsets).
      // Find .ashby-application-form-field-entry containers with Yes/No buttons.
      const buttonQuestions = await page.evaluate(() => {
        const entries = document.querySelectorAll('.ashby-application-form-field-entry');
        const questions = [];
        for (const entry of entries) {
          const btns = entry.querySelectorAll('button');
          const btnTexts = Array.from(btns).map(b => b.innerText.trim());
          if (btnTexts.includes('Yes') && btnTexts.includes('No')) {
            const label = entry.innerText.replace(/Yes/g, '').replace(/No/g, '').trim();
            questions.push(label);
          }
        }
        return questions;
      });

      const p = formFiller.profile;
      for (const label of buttonQuestions) {
        const ll = label.toLowerCase();
        let answer = null;
        if (ll.includes('authorized') || ll.includes('legally') || ll.includes('eligible') || ll.includes('right to work')) {
          answer = p.work_authorization?.authorized ? 'Yes' : 'No';
        } else if (ll.includes('sponsor')) {
          answer = p.work_authorization?.requires_sponsorship ? 'Yes' : 'No';
        } else if (ll.includes('consent') || ll.includes('text message') || ll.includes('sms')) {
          answer = 'Yes';
        }
        if (answer) {
          // Use Playwright locator for reliable clicking
          const entry = page.locator('.ashby-application-form-field-entry', { hasText: label.substring(0, 40) });
          const btn = entry.locator(`button:has-text("${answer}")`).first();
          if (await btn.count() > 0) {
            await btn.click().catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      }
    },
  });
}
