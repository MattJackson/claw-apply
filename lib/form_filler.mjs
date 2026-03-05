/**
 * form_filler.mjs — Generic form filling
 * Config-driven: answers loaded from answers.json
 * Returns list of unknown required fields
 */
import {
  DEFAULT_YEARS_EXPERIENCE, DEFAULT_DESIRED_SALARY,
  MINIMUM_SALARY_FACTOR, DEFAULT_SKILL_RATING,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR
} from './constants.mjs';

export class FormFiller {
  constructor(profile, answers) {
    this.profile = profile;
    this.answers = answers || []; // [{ pattern, answer }]
  }

  // Find answer for a label — checks custom answers first, then built-ins
  answerFor(label) {
    if (!label) return null;
    const l = label.toLowerCase();

    // Check custom answers first (user-defined, pattern is substring or regex)
    for (const entry of this.answers) {
      try {
        const re = new RegExp(entry.pattern, 'i');
        if (re.test(l)) return String(entry.answer);
      } catch {
        if (l.includes(entry.pattern.toLowerCase())) return String(entry.answer);
      }
    }

    // Built-in answers
    const p = this.profile;

    // Contact
    if (l.includes('first name') && !l.includes('last')) return p.name?.first || null;
    if (l.includes('last name')) return p.name?.last || null;
    if (l.includes('full name') || l === 'name') {
      const first = p.name?.first;
      const last = p.name?.last;
      return (first && last) ? `${first} ${last}` : null;
    }
    if (l.includes('email')) return p.email || null;
    if (l.includes('phone') || l.includes('mobile')) return p.phone || null;
    if (l.includes('city') && !l.includes('remote')) return p.location?.city || null;
    if (l.includes('state') && !l.includes('statement')) return p.location?.state || null;
    if (l.includes('zip') || l.includes('postal')) return p.location?.zip || null;
    if (l.includes('country')) return p.location?.country || null;
    if (l.includes('linkedin')) return p.linkedin_url || null;
    if (l.includes('website') || l.includes('portfolio')) return p.linkedin_url || null;

    // Work auth
    if (l.includes('sponsor') || l.includes('visa')) return p.work_authorization?.requires_sponsorship ? 'Yes' : 'No';
    if (l.includes('relocat')) return p.willing_to_relocate ? 'Yes' : 'No';
    if (l.includes('authorized') || l.includes('eligible') || l.includes('legally') || l.includes('work in the u')) {
      return p.work_authorization?.authorized ? 'Yes' : 'No';
    }
    if (l.includes('remote') && (l.includes('willing') || l.includes('comfortable') || l.includes('able to'))) return 'Yes';

    // Experience
    if (l.includes('year') && (l.includes('experienc') || l.includes('exp') || l.includes('work'))) {
      if (l.includes('enterprise') || l.includes('b2b')) return '5';
      if (l.includes('crm') || l.includes('salesforce') || l.includes('hubspot') || l.includes('database')) return '7';
      if (l.includes('cold') || l.includes('outbound') || l.includes('prospecting')) return '5';
      if (l.includes('sales') || l.includes('revenue') || l.includes('quota') || l.includes('account')) return '7';
      if (l.includes('saas') || l.includes('software') || l.includes('tech')) return '7';
      if (l.includes('manag') || l.includes('leadership')) return '3';
      return String(p.years_experience || DEFAULT_YEARS_EXPERIENCE);
    }

    // 1-10 scale
    if (l.includes('1 - 10') || l.includes('1-10') || l.includes('scale of 1') || l.includes('rate your')) {
      if (l.includes('cold') || l.includes('outbound') || l.includes('prospecting')) return '9';
      if (l.includes('sales') || l.includes('selling') || l.includes('revenue') || l.includes('gtm')) return '9';
      if (l.includes('enterprise') || l.includes('b2b')) return '9';
      if (l.includes('technical') || l.includes('engineering')) return '7';
      if (l.includes('crm') || l.includes('salesforce')) return '8';
      return DEFAULT_SKILL_RATING;
    }

    // Compensation
    if (l.includes('salary') || l.includes('compensation') || l.includes('expected pay')) return String(p.desired_salary || '');
    if (l.includes('minimum') && l.includes('salary')) return String(Math.round((p.desired_salary || DEFAULT_DESIRED_SALARY) * MINIMUM_SALARY_FACTOR));

    // Dates
    if (l.includes('start date') || l.includes('when can you start') || l.includes('available to start')) return 'Immediately';
    if (l.includes('notice period')) return '2 weeks';

    // Education
    if (l.includes('degree') || l.includes('bachelor')) return 'No';

    // Cover letter
    if (l.includes('cover letter') || l.includes('additional info') || l.includes('tell us') ||
        l.includes('why do you') || l.includes('about yourself') || l.includes('message to')) {
      return p.cover_letter || '';
    }

    return null;
  }

  isHoneypot(label) {
    const l = (label || '').toLowerCase();
    return l.includes('digit code') || l.includes('secret word') || l.includes('not apply on linkedin') ||
           l.includes('best way to apply') || l.includes('hidden code') || l.includes('passcode');
  }

  async getLabel(el) {
    return el.evaluate(node => {
      const id = node.id;
      const forLabel = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : '';
      const ariaLabel = node.getAttribute('aria-label') || '';
      const ariaLabelledBy = node.getAttribute('aria-labelledby');
      const linked = ariaLabelledBy ? document.getElementById(ariaLabelledBy)?.textContent?.trim() : '';
      return forLabel || ariaLabel || linked || node.placeholder || node.name || '';
    }).catch(() => '');
  }

  // Fill all fields in a container (page or modal element)
  // Returns array of unknown required field labels
  async fill(page, resumePath) {
    const unknown = [];
    const modal = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR) || page;

    // Resume upload — only if no existing resume selected
    const hasResumeSelected = await page.$('input[type="radio"][aria-label*="resume"], input[type="radio"][aria-label*="Resume"]').catch(() => null);
    if (!hasResumeSelected && resumePath) {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) await fileInput.setInputFiles(resumePath).catch(() => {});
    }

    // Phone — always overwrite (LinkedIn pre-fills wrong number)
    for (const inp of await page.$$('input[type="text"], input[type="tel"]')) {
      if (!await inp.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(inp);
      if (lbl.toLowerCase().includes('phone') || lbl.toLowerCase().includes('mobile')) {
        await inp.click({ clickCount: 3 }).catch(() => {});
        await inp.fill(this.profile.phone || '').catch(() => {});
      }
    }

    // Text / number / url / email inputs
    for (const inp of await page.$$('input[type="text"], input[type="number"], input[type="url"], input[type="email"]')) {
      if (!await inp.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(inp);
      if (!lbl || lbl.toLowerCase().includes('phone') || lbl.toLowerCase().includes('mobile')) continue;
      const existing = await inp.inputValue().catch(() => '');
      if (existing?.trim()) continue;
      if (this.isHoneypot(lbl)) return [{ label: lbl, honeypot: true }];
      const answer = this.answerFor(lbl);
      if (answer && answer !== this.profile.cover_letter) {
        await inp.fill(String(answer)).catch(() => {});
      } else if (!answer) {
        const required = await inp.getAttribute('required').catch(() => null);
        if (required !== null) unknown.push(lbl);
      }
    }

    // Textareas
    for (const ta of await page.$$('textarea')) {
      if (!await ta.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(ta);
      const existing = await ta.inputValue().catch(() => '');
      if (existing?.trim()) continue;
      const answer = this.answerFor(lbl);
      if (answer) {
        await ta.fill(answer).catch(() => {});
      } else {
        const required = await ta.getAttribute('required').catch(() => null);
        if (required !== null) unknown.push(lbl);
      }
    }

    // Fieldsets (Yes/No radios)
    for (const fs of await page.$$('fieldset')) {
      const leg = await fs.$eval('legend', el => el.textContent.trim()).catch(() => '');
      if (!leg) continue;
      const anyChecked = await fs.$('input:checked');
      if (anyChecked) continue;
      const answer = this.answerFor(leg);
      if (answer) {
        const lbl = await fs.$(`label:has-text("${answer}")`);
        if (lbl) await lbl.click().catch(() => {});
      } else {
        unknown.push(leg);
      }
    }

    // Selects
    for (const sel of await page.$$('select')) {
      if (!await sel.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(sel);
      if (lbl.toLowerCase().includes('country code')) continue;
      const existing = await sel.inputValue().catch(() => '');
      if (existing) continue;
      const answer = this.answerFor(lbl);
      if (answer) {
        await sel.selectOption({ label: answer }).catch(async () => {
          await sel.selectOption({ value: answer }).catch(() => {});
        });
      }
    }

    return unknown;
  }
}
