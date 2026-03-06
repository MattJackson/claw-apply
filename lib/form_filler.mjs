/**
 * form_filler.mjs — Generic form filling
 * Config-driven: answers loaded from answers.json
 * Returns list of unknown required fields
 */
import {
  DEFAULT_YEARS_EXPERIENCE, DEFAULT_DESIRED_SALARY,
  MINIMUM_SALARY_FACTOR, DEFAULT_SKILL_RATING,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR, FORM_PATTERN_MAX_LENGTH,
  AUTOCOMPLETE_WAIT, AUTOCOMPLETE_TIMEOUT
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
        if (entry.pattern.length > FORM_PATTERN_MAX_LENGTH) throw new Error('pattern too long');
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
    if (l.includes('zip') || l.includes('postal')) return p.location?.zip || null;
    if (l.includes('country code') || l.includes('phone country')) return 'United States (+1)';
    if (l.includes('country')) return p.location?.country || null;
    if (l.includes('state') && !l.includes('statement')) return p.location?.state || null;
    if (l.includes('linkedin')) return p.linkedin_url || null;
    if (l.includes('website') || l.includes('portfolio')) return p.linkedin_url || null;
    if (l.includes('currently located') || l.includes('current location') || l.includes('where are you')) {
      return `${p.location?.city || ''}, ${p.location?.state || ''}`.trim().replace(/^,\s*|,\s*$/, '');
    }
    if (l.includes('hear about') || l.includes('how did you find') || l.includes('how did you hear')) return 'LinkedIn';

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
    return await el.evaluate(node => {
      const id = node.id;
      const forLabel = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : '';
      const ariaLabel = node.getAttribute('aria-label') || '';
      const ariaLabelledBy = node.getAttribute('aria-labelledby');
      const linked = ariaLabelledBy ? document.getElementById(ariaLabelledBy)?.textContent?.trim() : '';

      // LinkedIn doesn't use label[for] — labels are ancestor elements.
      // Walk up the DOM to find the nearest label in a parent container.
      let ancestorLabel = '';
      if (!forLabel && !ariaLabel && !linked) {
        let parent = node.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const lbl = parent.querySelector('label');
          if (lbl) {
            ancestorLabel = lbl.textContent?.trim() || '';
            break;
          }
          parent = parent.parentElement;
        }
      }

      // Clean up — remove trailing * from required field labels
      // Also deduplicate labels like "Phone country codePhone country code"
      let raw = forLabel || ariaLabel || linked || ancestorLabel || node.placeholder || node.name || '';
      raw = raw.replace(/\s*\*\s*$/, '').trim();
      // Deduplicate repeated label text (LinkedIn renders label text twice sometimes)
      if (raw.length > 4) {
        const half = Math.floor(raw.length / 2);
        if (raw.slice(0, half) === raw.slice(half)) raw = raw.slice(0, half);
      }
      return raw;
    }).catch(() => '');
  }

  /**
   * Check if a form element is required.
   * LinkedIn uses multiple patterns: required attribute, aria-required, or * in label.
   */
  async isRequired(el) {
    return await el.evaluate(node => {
      if (node.required || node.getAttribute('required') !== null) return true;
      if (node.getAttribute('aria-required') === 'true') return true;
      // Check if any associated label contains * — try label[for], then ancestor labels
      const id = node.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label && label.textContent.includes('*')) return true;
      }
      // Walk up ancestors to find a label with *
      let parent = node.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const lbl = parent.querySelector('label');
        if (lbl && lbl.textContent.includes('*')) return true;
        // Also check for "Required" text in parent
        const reqSpan = parent.querySelector('[class*="required"], .artdeco-text-input--required');
        if (reqSpan) return true;
        parent = parent.parentElement;
      }
      return false;
    }).catch(() => false);
  }

  /**
   * Select the first option from an autocomplete dropdown.
   * Waits for the dropdown to appear, then clicks the first option.
   * Scoped to the input's nearest container to avoid clicking wrong dropdowns.
   */
  async selectAutocomplete(page, container) {
    // Wait for dropdown to appear — scope to container (modal) to avoid clicking wrong dropdowns
    const selectors = '[role="option"], [role="listbox"] li, ul[class*="autocomplete"] li';
    const option = await container.waitForSelector(selectors, {
      timeout: AUTOCOMPLETE_TIMEOUT, state: 'visible',
    }).catch(() => {
      // Fallback to page-level if container doesn't support waitForSelector (e.g. ElementHandle)
      return page.waitForSelector(selectors, {
        timeout: AUTOCOMPLETE_TIMEOUT, state: 'visible',
      }).catch(() => null);
    });
    if (option) {
      await option.click().catch(() => {});
      await page.waitForTimeout(AUTOCOMPLETE_WAIT);
    }
  }

  // Fill all fields in a container (page or modal element)
  // Returns array of unknown required field labels
  async fill(page, resumePath) {
    const unknown = [];
    // Scope to modal if present, otherwise use page
    const container = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR) || page;

    // Resume upload — only if no existing resume selected
    const hasResumeSelected = await container.$('input[type="radio"][aria-label*="resume"], input[type="radio"][aria-label*="Resume"]').catch(() => null);
    if (!hasResumeSelected && resumePath) {
      const fileInput = await container.$('input[type="file"]');
      if (fileInput) await fileInput.setInputFiles(resumePath).catch(() => {});
    }

    // Phone — always overwrite (LinkedIn pre-fills wrong number)
    for (const inp of await container.$$('input[type="text"], input[type="tel"]')) {
      if (!await inp.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(inp);
      if (lbl.toLowerCase().includes('phone') || lbl.toLowerCase().includes('mobile')) {
        await inp.click({ clickCount: 3 }).catch(() => {});
        await inp.fill(this.profile.phone || '').catch(() => {});
      }
    }

    // Text / number / url / email inputs
    for (const inp of await container.$$('input[type="text"], input[type="number"], input[type="url"], input[type="email"]')) {
      if (!await inp.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(inp);
      if (!lbl || lbl.toLowerCase().includes('phone') || lbl.toLowerCase().includes('mobile')) continue;
      const existing = await inp.inputValue().catch(() => '');
      if (existing?.trim()) continue;
      if (this.isHoneypot(lbl)) return [{ label: lbl, honeypot: true }];
      const answer = this.answerFor(lbl);
      if (answer && answer !== this.profile.cover_letter) {
        await inp.fill(String(answer)).catch(() => {});
        // Handle city/location autocomplete dropdowns
        const ll = lbl.toLowerCase();
        if (ll.includes('city') || ll.includes('location') || ll.includes('located')) {
          await this.selectAutocomplete(page, container);
        }
      } else {
        // No answer, or answer is cover letter (too long for a text input) — check if required
        if (await this.isRequired(inp)) unknown.push(lbl);
      }
    }

    // Textareas
    for (const ta of await container.$$('textarea')) {
      if (!await ta.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(ta);
      const existing = await ta.inputValue().catch(() => '');
      if (existing?.trim()) continue;
      const answer = this.answerFor(lbl);
      if (answer) {
        await ta.fill(answer).catch(() => {});
      } else {
        if (await this.isRequired(ta)) unknown.push(lbl);
      }
    }

    // Fieldsets (Yes/No radios)
    for (const fs of await container.$$('fieldset')) {
      const leg = await fs.$eval('legend', el => el.textContent.trim()).catch(() => '');
      if (!leg) continue;
      const anyChecked = await fs.$('input:checked');
      if (anyChecked) continue;
      const answer = this.answerFor(leg);
      if (answer) {
        // Find label within this fieldset that matches the answer text
        const labels = await fs.$$('label');
        for (const lbl of labels) {
          const text = await lbl.textContent().catch(() => '');
          if (text.trim().toLowerCase() === answer.toLowerCase()) {
            await lbl.click().catch(() => {});
            break;
          }
        }
      } else {
        unknown.push(leg);
      }
    }

    // Selects
    for (const sel of await container.$$('select')) {
      if (!await sel.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(sel);
      const existing = await sel.inputValue().catch(() => '');
      // "Select an option" is LinkedIn's placeholder — treat as unfilled
      if (existing && !/^select an? /i.test(existing)) continue;
      const answer = this.answerFor(lbl);
      if (answer) {
        await sel.selectOption({ label: answer }).catch(async () => {
          await sel.selectOption({ value: answer }).catch(() => {});
        });
      } else {
        // EEO/voluntary fields — default to "Prefer not to disclose"
        const ll = lbl.toLowerCase();
        if (ll.includes('race') || ll.includes('ethnicity') || ll.includes('gender') ||
            ll.includes('veteran') || ll.includes('disability') || ll.includes('identification')) {
          const opts = await sel.$$('option');
          for (const opt of opts) {
            const text = await opt.textContent().catch(() => '');
            if (/prefer not|decline|do not wish|i don/i.test(text || '')) {
              await sel.selectOption({ label: text.trim() }).catch(() => {});
              break;
            }
          }
        } else if (await this.isRequired(sel)) {
          // Non-EEO required select with no answer — report as unknown with options
          const opts = await sel.$$('option');
          const options = [];
          for (const opt of opts) {
            const text = (await opt.textContent().catch(() => '') || '').trim();
            if (text && !/^select/i.test(text)) options.push(text);
          }
          unknown.push({ label: lbl, type: 'select', options });
        }
      }
    }

    // Checkboxes — "mark as top choice" and similar opt-ins
    for (const cb of await container.$$('input[type="checkbox"]')) {
      if (!await cb.isVisible().catch(() => false)) continue;
      if (await cb.isChecked().catch(() => false)) continue;
      const lbl = await this.getLabel(cb);
      const ll = lbl.toLowerCase();
      if (ll.includes('top choice') || ll.includes('interested') || ll.includes('confirm') || ll.includes('agree')) {
        await cb.check().catch(() => {});
      }
    }

    return unknown;
  }
}
