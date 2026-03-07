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
      // Find question labels and click the appropriate button.
      const buttonQuestions = await page.evaluate(() => {
        const questions = [];
        // Find containers with question text + Yes/No buttons
        const allBtns = Array.from(document.querySelectorAll('button[type="submit"]'));
        const yesNoBtns = allBtns.filter(b => b.innerText.trim() === 'Yes' || b.innerText.trim() === 'No');
        const seen = new Set();
        for (const btn of yesNoBtns) {
          const container = btn.parentElement?.parentElement;
          if (!container || seen.has(container)) continue;
          seen.add(container);
          const label = container.innerText.replace(/Yes\s*No/g, '').trim();
          if (label) questions.push({ label, containerIdx: questions.length });
        }
        return questions;
      });

      const p = formFiller.profile;
      for (const q of buttonQuestions) {
        const ll = q.label.toLowerCase();
        let answer = null;
        if (ll.includes('authorized') || ll.includes('legally') || ll.includes('eligible') || ll.includes('right to work')) {
          answer = p.work_authorization?.authorized ? 'Yes' : 'No';
        } else if (ll.includes('sponsor')) {
          answer = p.work_authorization?.requires_sponsorship ? 'Yes' : 'No';
        } else if (ll.includes('consent') || ll.includes('text message') || ll.includes('sms')) {
          answer = 'Yes';
        }
        if (answer) {
          // Click the matching button - find by text within the question's container
          const clicked = await page.evaluate((label, answer) => {
            const allBtns = Array.from(document.querySelectorAll('button[type="submit"]'));
            const containers = new Set();
            for (const btn of allBtns) {
              const c = btn.parentElement?.parentElement;
              if (!c) continue;
              const cText = c.innerText.replace(/Yes\s*No/g, '').trim();
              if (cText === label) {
                const target = Array.from(c.querySelectorAll('button')).find(b => b.innerText.trim() === answer);
                if (target) { target.click(); return true; }
              }
            }
            return false;
          }, q.label, answer);
          if (clicked) await page.waitForTimeout(300);
        }
      }
    },
  });
}
