/**
 * form_filler.mjs — Generic form filling
 * Config-driven: answers loaded from answers.json
 * Returns list of unknown required fields
 */
import { writeFileSync, renameSync } from 'fs';
import {
  DEFAULT_YEARS_EXPERIENCE, DEFAULT_DESIRED_SALARY,
  MINIMUM_SALARY_FACTOR, DEFAULT_SKILL_RATING,
  LINKEDIN_EASY_APPLY_MODAL_SELECTOR, FORM_PATTERN_MAX_LENGTH,
  AUTOCOMPLETE_WAIT, AUTOCOMPLETE_TIMEOUT, ANTHROPIC_API_URL
} from './constants.mjs';

/**
 * Normalize answers from either format:
 *   Object: { "question": "answer" }  →  [{ pattern: "question", answer: "answer" }]
 *   Array:  [{ pattern, answer }]      →  as-is
 */
function normalizeAnswers(answers) {
  if (!answers) return [];
  if (Array.isArray(answers)) return answers;
  if (typeof answers === 'object') {
    return Object.entries(answers).map(([pattern, answer]) => ({ pattern, answer: String(answer) }));
  }
  return [];
}

export class FormFiller {
  constructor(profile, answers, opts = {}) {
    this.profile = profile;
    this.answers = normalizeAnswers(answers); // [{ pattern, answer }]
    this.apiKey = opts.apiKey || null;
    this.answersPath = opts.answersPath || null; // path to answers.json for saving
    this.jobContext = opts.jobContext || {}; // { title, company }
  }

  /**
   * Save a new answer to answers.json and in-memory cache.
   * Skips if pattern already exists.
   */
  saveAnswer(pattern, answer) {
    if (!pattern || !answer) return;
    const existing = this.answers.findIndex(a => a.pattern === pattern);
    if (existing >= 0) return; // already saved
    this.answers.push({ pattern, answer });
    if (this.answersPath) {
      try {
        const tmp = this.answersPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(this.answers, null, 2));
        renameSync(tmp, this.answersPath);
      } catch { /* best effort */ }
    }
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
    if (l.includes('authorized') || l.includes('eligible') || l.includes('legally') || l.includes('work in the u') || l.includes('right to work')) {
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

      // Clean up label text
      let raw = forLabel || ariaLabel || linked || ancestorLabel || node.placeholder || node.name || '';
      // Normalize whitespace, strip trailing *, strip "Required" suffix
      raw = raw.replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
      // Deduplicate repeated label text (LinkedIn renders label text twice)
      // e.g. "First sales hire?First sales hire?" → "First sales hire?"
      if (raw.length > 8) {
        for (let len = Math.ceil(raw.length / 2); len >= 4; len--) {
          const candidate = raw.slice(0, len);
          if (raw.startsWith(candidate + candidate)) {
            raw = candidate.trim();
            break;
          }
        }
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
   * Ask AI to answer an unknown question. Passes all saved answers so AI can
   * recognize variations of previously answered questions.
   * Returns the answer string, or null if AI can't help.
   */
  async aiAnswerFor(label, opts = {}) {
    if (!this.apiKey) return null;

    const savedAnswers = this.answers.map(a => `Q: "${a.pattern}" → A: "${a.answer}"`).join('\n');
    const optionsHint = opts.options?.length ? `\nAvailable options: ${opts.options.join(', ')}` : '';

    const systemPrompt = `You are helping a job candidate fill out application forms. You have access to their profile and previously answered questions.

Rules:
- If this question is a variation of a previously answered question, return the SAME answer
- For yes/no or multiple choice, return ONLY the exact option text
- For short-answer fields, be brief and direct (1 line)
- Use first person
- Never make up facts
- Just the answer text — no preamble, no explanation, no quotes`;

    const userPrompt = `Candidate: ${this.profile.name?.first} ${this.profile.name?.last}
Location: ${this.profile.location?.city}, ${this.profile.location?.state}
Years experience: ${this.profile.years_experience || 7}
Applying for: ${this.jobContext.title || 'a role'} at ${this.jobContext.company || 'a company'}

Previously answered questions:
${savedAnswers || '(none yet)'}

New question: "${label}"${optionsHint}

Answer:`;

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const answer = data.content?.[0]?.text?.trim() || null;
      if (answer) console.log(`    [AI] "${label}" → "${answer}"`);
      return answer;
    } catch {
      return null;
    }
  }

  /**
   * Select an option from a <select> with case-insensitive, trimmed matching.
   * Tries: exact label → case-insensitive label → substring match → value match.
   */
  async selectOptionFuzzy(sel, answer) {
    // Try exact match first (fastest path)
    const exactWorked = await sel.selectOption({ label: answer }).then(() => true).catch(() => false);
    if (exactWorked) return;

    // Scan options for case-insensitive / trimmed match
    const opts = await sel.$$('option');
    const target = answer.trim().toLowerCase();
    let substringMatch = null;

    for (const opt of opts) {
      const text = (await opt.textContent().catch(() => '') || '').trim();
      if (text.toLowerCase() === target) {
        await sel.selectOption({ label: text }).catch(() => {});
        return;
      }
      // Track first substring match as fallback (e.g. answer "Yes" matches "Yes, I am authorized")
      if (!substringMatch && text.toLowerCase().includes(target)) {
        substringMatch = text;
      }
    }

    if (substringMatch) {
      await sel.selectOption({ label: substringMatch }).catch(() => {});
      return;
    }

    // Last resort: try by value
    await sel.selectOption({ value: answer }).catch(() => {});
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

    // Resume selection — LinkedIn shows radio buttons for previously uploaded resumes
    // Select the first resume radio if none is already checked
    const resumeRadios = await container.$$('input[type="radio"][aria-label*="resume"], input[type="radio"][aria-label*="Resume"]');
    if (resumeRadios.length > 0) {
      const anyChecked = await container.$('input[type="radio"][aria-label*="resume"]:checked, input[type="radio"][aria-label*="Resume"]:checked').catch(() => null);
      if (!anyChecked) {
        await resumeRadios[0].click().catch(() => {});
      }
    } else if (resumePath) {
      // No resume radios — try file upload
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
      let answer = this.answerFor(lbl);
      // AI fallback for unknown required fields
      if (!answer && await this.isRequired(inp)) {
        answer = await this.aiAnswerFor(lbl);
        if (answer) this.saveAnswer(lbl, answer);
      }
      if (answer && answer !== this.profile.cover_letter) {
        await inp.fill(String(answer)).catch(() => {});
        // Handle city/location autocomplete dropdowns
        const ll = lbl.toLowerCase();
        if (ll.includes('city') || ll.includes('location') || ll.includes('located')) {
          await this.selectAutocomplete(page, container);
        }
      } else {
        // No answer from profile, custom answers, or AI — check if required
        if (await this.isRequired(inp)) unknown.push(lbl);
      }
    }

    // Textareas
    for (const ta of await container.$$('textarea')) {
      if (!await ta.isVisible().catch(() => false)) continue;
      const lbl = await this.getLabel(ta);
      const existing = await ta.inputValue().catch(() => '');
      if (existing?.trim()) continue;
      let answer = this.answerFor(lbl);
      if (!answer && await this.isRequired(ta)) {
        answer = await this.aiAnswerFor(lbl);
        if (answer) this.saveAnswer(lbl, answer);
      }
      if (answer) {
        await ta.fill(answer).catch(() => {});
      } else {
        if (await this.isRequired(ta)) unknown.push(lbl);
      }
    }

    // Fieldsets (radios and checkbox groups)
    for (const fs of await container.$$('fieldset')) {
      const leg = await fs.$eval('legend', el => {
        let raw = (el.textContent || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
        if (raw.length > 8) {
          for (let len = Math.ceil(raw.length / 2); len >= 4; len--) {
            const candidate = raw.slice(0, len);
            if (raw.startsWith(candidate + candidate)) { raw = candidate.trim(); break; }
          }
        }
        return raw;
      }).catch(() => '');
      if (!leg) continue;
      const anyChecked = await fs.$('input:checked');
      if (anyChecked) continue;
      // Detect if this is a checkbox group (multi-select) vs radio group
      const isCheckboxGroup = (await fs.$$('input[type="checkbox"]')).length > 0;
      // Collect option labels for AI context
      const labels = await fs.$$('label');
      const optionTexts = [];
      for (const lbl of labels) {
        const t = (await lbl.textContent().catch(() => '') || '').trim();
        if (t) optionTexts.push(t);
      }
      let answer = this.answerFor(leg);
      if (!answer) {
        answer = await this.aiAnswerFor(leg, { options: optionTexts });
        if (answer) this.saveAnswer(leg, answer);
      }
      if (answer) {
        if (isCheckboxGroup) {
          // Multi-select: split comma-separated answers and click each matching label
          const selections = answer.split(',').map(s => s.trim().toLowerCase());
          for (const lbl of labels) {
            const text = (await lbl.textContent().catch(() => '') || '').trim();
            if (selections.some(s => text.toLowerCase() === s || text.toLowerCase().includes(s))) {
              await lbl.click().catch(() => {});
            }
          }
        } else {
          // Single-select radio: click the matching label, then verify
          let clicked = false;
          for (const lbl of labels) {
            const text = (await lbl.textContent().catch(() => '') || '').trim();
            if (text.toLowerCase() === answer.toLowerCase() ||
                text.toLowerCase().startsWith(answer.toLowerCase())) {
              await lbl.click().catch(() => {});
              clicked = true;
              break;
            }
          }
          // Verify a radio got checked — if not, try clicking the input directly
          if (clicked) {
            const nowChecked = await fs.$('input:checked');
            if (!nowChecked) {
              const radios = await fs.$$('input[type="radio"]');
              for (const radio of radios) {
                const val = await radio.evaluate(el => el.value || el.nextSibling?.textContent?.trim() || '').catch(() => '');
                if (val.toLowerCase() === answer.toLowerCase() ||
                    val.toLowerCase().startsWith(answer.toLowerCase())) {
                  await radio.click({ force: true }).catch(() => {});
                  break;
                }
              }
            }
          }
          // Last resort: try as a <select> within the fieldset
          if (!clicked || !(await fs.$('input:checked'))) {
            const sel = await fs.$('select');
            if (sel) await this.selectOptionFuzzy(sel, answer);
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
      // Get available options for validation
      const availOpts = await sel.$$eval('option', els =>
        els.map(el => el.textContent?.trim()).filter(t => t && !/^select/i.test(t))
      ).catch(() => []);
      let answer = this.answerFor(lbl);
      // If built-in answer doesn't match any option (e.g. got "7" but options are Yes/No), discard it
      if (answer && availOpts.length > 0) {
        const ansLower = answer.toLowerCase();
        const matches = availOpts.some(o => o.toLowerCase() === ansLower || o.toLowerCase().includes(ansLower) || ansLower.includes(o.toLowerCase()));
        if (!matches) answer = null;
      }
      if (!answer) {
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
          continue;
        }
        // AI fallback for required selects
        if (await this.isRequired(sel)) {
          const opts = await sel.$$('option');
          const options = [];
          for (const opt of opts) {
            const text = (await opt.textContent().catch(() => '') || '').trim();
            if (text && !/^select/i.test(text)) options.push(text);
          }
          answer = await this.aiAnswerFor(lbl, { options });
          if (answer) {
            this.saveAnswer(lbl, answer);
          } else {
            unknown.push({ label: lbl, type: 'select', options });
            continue;
          }
        }
      }
      if (answer) {
        await this.selectOptionFuzzy(sel, answer);
      }
    }

    // Checkboxes — "mark as top choice" and similar opt-ins
    for (const cb of await container.$$('input[type="checkbox"]')) {
      if (!await cb.isVisible().catch(() => false)) continue;
      if (await cb.isChecked().catch(() => false)) continue;
      const lbl = await this.getLabel(cb);
      const ll = lbl.toLowerCase();
      if (ll.includes('top choice') || ll.includes('interested') || ll.includes('confirm') || ll.includes('agree') || ll.includes('consent')) {
        await cb.check().catch(() => {});
      }
    }

    return unknown;
  }
}
