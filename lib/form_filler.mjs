/**
 * form_filler.mjs — Generic form filling
 * Config-driven: answers loaded from answers.json
 * Returns list of unknown required fields
 *
 * Performance: uses a single evaluate() to snapshot all form state from the DOM,
 * does answer matching locally in Node, then only makes CDP calls to fill/click.
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
 *   Object: { "question": "answer" }  ->  [{ pattern: "question", answer: "answer" }]
 *   Array:  [{ pattern, answer }]     ->  as-is
 */
function normalizeAnswers(answers) {
  if (!answers) return [];
  if (Array.isArray(answers)) return answers;
  if (typeof answers === 'object') {
    return Object.entries(answers).map(([pattern, answer]) => ({ pattern, answer: String(answer) }));
  }
  return [];
}

/**
 * Extract label text from a DOM node. Runs inside evaluate().
 * Checks: label[for], aria-label, aria-labelledby, ancestor label, placeholder, name.
 */
function extractLabel(node) {
  const id = node.id;
  const forLabel = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : '';
  const ariaLabel = node.getAttribute('aria-label') || '';
  const ariaLabelledBy = node.getAttribute('aria-labelledby');
  const linked = ariaLabelledBy ? document.getElementById(ariaLabelledBy)?.textContent?.trim() : '';

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

  let raw = forLabel || ariaLabel || linked || ancestorLabel || node.placeholder || node.name || '';
  raw = raw.replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
  // Deduplicate repeated label text (LinkedIn renders label text twice)
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
}

/**
 * Check if a node is required. Runs inside evaluate().
 */
function checkRequired(node) {
  if (node.required || node.getAttribute('required') !== null) return true;
  if (node.getAttribute('aria-required') === 'true') return true;
  const id = node.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label && label.textContent.includes('*')) return true;
  }
  let parent = node.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    const lbl = parent.querySelector('label');
    if (lbl && lbl.textContent.includes('*')) return true;
    const reqSpan = parent.querySelector('[class*="required"], .artdeco-text-input--required');
    if (reqSpan) return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Normalize a fieldset legend, same logic as extractLabel dedup.
 */
function normalizeLegend(el) {
  let raw = (el.textContent || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
  if (raw.length > 8) {
    for (let len = Math.ceil(raw.length / 2); len >= 4; len--) {
      const candidate = raw.slice(0, len);
      if (raw.startsWith(candidate + candidate)) { raw = candidate.trim(); break; }
    }
  }
  return raw;
}

export class FormFiller {
  constructor(profile, answers, opts = {}) {
    this.profile = profile;
    this.answers = normalizeAnswers(answers); // [{ pattern, answer }]
    this.apiKey = opts.apiKey || null;
    this.answersPath = opts.answersPath || null;
    this.jobContext = opts.jobContext || {};
  }

  saveAnswer(pattern, answer) {
    if (!pattern || !answer) return;
    const existing = this.answers.findIndex(a => a.pattern === pattern);
    if (existing >= 0) return;
    this.answers.push({ pattern, answer });
    if (this.answersPath) {
      try {
        const tmp = this.answersPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(this.answers, null, 2));
        renameSync(tmp, this.answersPath);
      } catch { /* best effort */ }
    }
  }

  answerFor(label) {
    if (!label) return null;
    const l = label.toLowerCase();

    // Check custom answers first
    for (const entry of this.answers) {
      try {
        if (entry.pattern.length > FORM_PATTERN_MAX_LENGTH) throw new Error('pattern too long');
        const re = new RegExp(entry.pattern, 'i');
        if (re.test(l)) return String(entry.answer);
      } catch {
        if (l.includes(entry.pattern.toLowerCase())) return String(entry.answer);
      }
    }

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
    if (l.includes('authoriz') || l.includes('eligible') || l.includes('legally') || l.includes('work in the u') || l.includes('right to work')) {
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

  // Keep these for external callers (test scripts etc)
  async getLabel(el) {
    return await el.evaluate(extractLabel).catch(() => '');
  }

  async isRequired(el) {
    return await el.evaluate(checkRequired).catch(() => false);
  }

  async aiAnswerFor(label, opts = {}) {
    if (!this.apiKey) return null;

    const savedAnswers = this.answers.map(a => `Q: "${a.pattern}" -> A: "${a.answer}"`).join('\n');
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
      if (answer) console.log(`    [AI] "${label}" -> "${answer}"`);
      return answer;
    } catch {
      return null;
    }
  }

  async selectOptionFuzzy(sel, answer) {
    const exactWorked = await sel.selectOption({ label: answer }).then(() => true).catch(() => false);
    if (exactWorked) return;

    const opts = await sel.$$('option');
    const target = answer.trim().toLowerCase();
    let substringMatch = null;

    for (const opt of opts) {
      const text = (await opt.textContent().catch(() => '') || '').trim();
      if (text.toLowerCase() === target) {
        await sel.selectOption({ label: text }).catch(() => {});
        return;
      }
      if (!substringMatch && text.toLowerCase().includes(target)) {
        substringMatch = text;
      }
    }

    if (substringMatch) {
      await sel.selectOption({ label: substringMatch }).catch(() => {});
      return;
    }

    await sel.selectOption({ value: answer }).catch(() => {});
  }

  async selectAutocomplete(page, container) {
    const selectors = '[role="option"], [role="listbox"] li, ul[class*="autocomplete"] li';
    const option = await container.waitForSelector(selectors, {
      timeout: AUTOCOMPLETE_TIMEOUT, state: 'visible',
    }).catch(() => {
      return page.waitForSelector(selectors, {
        timeout: AUTOCOMPLETE_TIMEOUT, state: 'visible',
      }).catch(() => null);
    });
    if (option) {
      await option.click().catch(() => {});
      await page.waitForTimeout(AUTOCOMPLETE_WAIT);
    }
  }

  /**
   * Snapshot all form fields from the DOM in a single evaluate() call.
   * Returns a plain JSON object describing every field, avoiding per-element CDP round-trips.
   */
  async _snapshotFields(container) {
    return await container.evaluate((extractLabelSrc, checkRequiredSrc, normalizeLegendSrc) => {
      // Reconstruct functions inside browser context
      const extractLabel = new Function('node', `
        ${extractLabelSrc}
        return extractLabel(node);
      `);
      // Can't pass functions directly — inline the logic instead
      // We'll inline extractLabel and checkRequired logic directly

      function _extractLabel(node) {
        const id = node.id;
        const forLabel = id ? document.querySelector('label[for="' + id + '"]')?.textContent?.trim() : '';
        const ariaLabel = node.getAttribute('aria-label') || '';
        const ariaLabelledBy = node.getAttribute('aria-labelledby');
        const linked = ariaLabelledBy ? document.getElementById(ariaLabelledBy)?.textContent?.trim() : '';

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

        let raw = forLabel || ariaLabel || linked || ancestorLabel || node.placeholder || node.name || '';
        raw = raw.replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
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
      }

      function _checkRequired(node) {
        if (node.required || node.getAttribute('required') !== null) return true;
        if (node.getAttribute('aria-required') === 'true') return true;
        const id = node.id;
        if (id) {
          const label = document.querySelector('label[for="' + id + '"]');
          if (label && label.textContent.includes('*')) return true;
        }
        let parent = node.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const lbl = parent.querySelector('label');
          if (lbl && lbl.textContent.includes('*')) return true;
          const reqSpan = parent.querySelector('[class*="required"], .artdeco-text-input--required');
          if (reqSpan) return true;
          parent = parent.parentElement;
        }
        return false;
      }

      function _normalizeLegend(el) {
        let raw = (el.textContent || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*Required\s*$/i, '').trim();
        if (raw.length > 8) {
          for (let len = Math.ceil(raw.length / 2); len >= 4; len--) {
            const candidate = raw.slice(0, len);
            if (raw.startsWith(candidate + candidate)) { raw = candidate.trim(); break; }
          }
        }
        return raw;
      }

      function isVisible(el) {
        if (!el.offsetParent && el.style.position !== 'fixed') return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      const result = {
        resumeRadios: [],
        hasFileInput: false,
        inputs: [],
        textareas: [],
        fieldsets: [],
        selects: [],
        checkboxes: [],
      };

      // Resume radios
      const resumeInputs = document.querySelectorAll('input[type="radio"][aria-label*="resume"], input[type="radio"][aria-label*="Resume"]');
      let resumeChecked = false;
      resumeInputs.forEach((r, i) => {
        if (r.checked) resumeChecked = true;
        result.resumeRadios.push({ index: i, checked: r.checked });
      });
      result.resumeChecked = resumeChecked;

      // File input
      result.hasFileInput = !!document.querySelector('input[type="file"]');

      // Text / number / url / email / tel inputs
      const inputEls = document.querySelectorAll('input[type="text"], input[type="number"], input[type="url"], input[type="email"], input[type="tel"]');
      inputEls.forEach((inp, i) => {
        if (!isVisible(inp)) return;
        const label = _extractLabel(inp);
        const value = inp.value || '';
        const required = _checkRequired(inp);
        const type = inp.type;
        result.inputs.push({ index: i, label, value, required, type });
      });

      // Textareas
      const taEls = document.querySelectorAll('textarea');
      taEls.forEach((ta, i) => {
        if (!isVisible(ta)) return;
        const label = _extractLabel(ta);
        const value = ta.value || '';
        const required = _checkRequired(ta);
        result.textareas.push({ index: i, label, value, required });
      });

      // Fieldsets
      const fsEls = document.querySelectorAll('fieldset');
      fsEls.forEach((fs, i) => {
        const legend = fs.querySelector('legend');
        if (!legend) return;
        const leg = _normalizeLegend(legend);
        if (!leg) return;

        const checkboxes = fs.querySelectorAll('input[type="checkbox"]');
        const isCheckboxGroup = checkboxes.length > 0;
        const radios = fs.querySelectorAll('input[type="radio"]');
        let anyChecked = false;
        radios.forEach(r => { if (r.checked) anyChecked = true; });
        checkboxes.forEach(c => { if (c.checked) anyChecked = true; });

        const options = [];
        fs.querySelectorAll('label').forEach(lbl => {
          const t = (lbl.textContent || '').trim();
          if (t) options.push(t);
        });

        // Check for a select inside the fieldset
        const selectInFs = fs.querySelector('select');
        const selectOptions = [];
        if (selectInFs) {
          selectInFs.querySelectorAll('option').forEach(opt => {
            const t = (opt.textContent || '').trim();
            if (t && !/^select/i.test(t)) selectOptions.push(t);
          });
        }

        result.fieldsets.push({
          index: i, legend: leg, isCheckboxGroup,
          anyChecked, options, hasSelect: !!selectInFs, selectOptions,
        });
      });

      // Selects (standalone, not inside fieldsets we already handle)
      const selEls = document.querySelectorAll('select');
      selEls.forEach((sel, i) => {
        if (!isVisible(sel)) return;
        const label = _extractLabel(sel);
        const value = sel.value || '';
        const selectedText = sel.options[sel.selectedIndex]?.textContent?.trim() || '';
        const required = _checkRequired(sel);
        const options = [];
        sel.querySelectorAll('option').forEach(opt => {
          const t = (opt.textContent || '').trim();
          if (t && !/^select/i.test(t)) options.push(t);
        });
        // Check if inside a fieldset we're already handling
        const inFieldset = !!sel.closest('fieldset')?.querySelector('legend');
        result.selects.push({ index: i, label, value, selectedText, required, options, inFieldset });
      });

      // Checkboxes (standalone)
      const cbEls = document.querySelectorAll('input[type="checkbox"]');
      cbEls.forEach((cb, i) => {
        if (!isVisible(cb)) return;
        // Skip if inside a fieldset with a legend (handled in fieldsets section)
        if (cb.closest('fieldset')?.querySelector('legend')) return;
        const label = _extractLabel(cb);
        const checked = cb.checked;
        result.checkboxes.push({ index: i, label, checked });
      });

      return result;
    }).catch(() => null);
  }

  /**
   * Fill all fields in a container (page or modal element).
   * Uses _snapshotFields() to batch-read all DOM state in one call,
   * then only makes individual CDP calls for elements that need action.
   * Returns array of unknown required field labels.
   */
  async fill(page, resumePath) {
    const unknown = [];
    const container = await page.$(LINKEDIN_EASY_APPLY_MODAL_SELECTOR) || page;

    // Single DOM snapshot — all labels, values, visibility, required status
    const snap = await this._snapshotFields(container);
    if (!snap) return unknown;

    // --- Resume ---
    if (snap.resumeRadios.length > 0 && !snap.resumeChecked) {
      const radios = await container.$$('input[type="radio"][aria-label*="resume"], input[type="radio"][aria-label*="Resume"]');
      if (radios[0]) await radios[0].click().catch(() => {});
    } else if (snap.resumeRadios.length === 0 && snap.hasFileInput && resumePath) {
      const fileInput = await container.$('input[type="file"]');
      if (fileInput) await fileInput.setInputFiles(resumePath).catch(() => {});
    }

    // --- Inputs (text/number/url/email/tel) ---
    // We need element handles for filling — get them once
    const inputEls = snap.inputs.length > 0
      ? await container.$$('input[type="text"], input[type="number"], input[type="url"], input[type="email"], input[type="tel"]')
      : [];

    // Build a map from snapshot index to element handle (only visible ones are in snap)
    // snap.inputs[i].index is the original DOM index
    for (const field of snap.inputs) {
      const el = inputEls[field.index];
      if (!el) continue;
      const lbl = field.label;
      const ll = lbl.toLowerCase();

      // Phone — always overwrite
      if (ll.includes('phone') || ll.includes('mobile')) {
        await el.click({ clickCount: 3 }).catch(() => {});
        await el.fill(this.profile.phone || '').catch(() => {});
        continue;
      }

      if (!lbl) continue;
      if (field.value?.trim()) continue; // already filled
      if (this.isHoneypot(lbl)) return [{ label: lbl, honeypot: true }];

      let answer = this.answerFor(lbl);
      if (!answer && field.required) {
        answer = await this.aiAnswerFor(lbl);
        if (answer) this.saveAnswer(lbl, answer);
      }
      if (answer && answer !== this.profile.cover_letter) {
        await el.fill(String(answer)).catch(() => {});
        if (ll.includes('city') || ll.includes('location') || ll.includes('located')) {
          await this.selectAutocomplete(page, container);
        }
      } else if (field.required) {
        unknown.push(lbl);
      }
    }

    // --- Textareas ---
    const taEls = snap.textareas.length > 0 ? await container.$$('textarea') : [];
    for (const field of snap.textareas) {
      const el = taEls[field.index];
      if (!el) continue;
      if (field.value?.trim()) continue;
      let answer = this.answerFor(field.label);
      if (!answer && field.required) {
        answer = await this.aiAnswerFor(field.label);
        if (answer) this.saveAnswer(field.label, answer);
      }
      if (answer) {
        await el.fill(answer).catch(() => {});
      } else if (field.required) {
        unknown.push(field.label);
      }
    }

    // --- Fieldsets (radios and checkbox groups) ---
    const fsEls = snap.fieldsets.length > 0 ? await container.$$('fieldset') : [];
    for (const field of snap.fieldsets) {
      const fs = fsEls[field.index];
      if (!fs) continue;

      // For radios: skip if any already checked. For checkboxes: never skip
      if (!field.isCheckboxGroup && field.anyChecked) continue;

      let answer = this.answerFor(field.legend);
      // Validate answer against available options
      if (answer && field.options.length > 0) {
        const ansLower = answer.toLowerCase();
        const matches = field.options.some(o =>
          o.toLowerCase() === ansLower || o.toLowerCase().includes(ansLower) || ansLower.includes(o.toLowerCase())
        );
        if (!matches) answer = null;
      }
      if (!answer) {
        answer = await this.aiAnswerFor(field.legend, { options: field.options });
        if (answer) this.saveAnswer(field.legend, answer);
      }
      if (answer) {
        const labels = await fs.$$('label');
        if (field.isCheckboxGroup) {
          const selections = answer.split(',').map(s => s.trim().toLowerCase());
          for (const lbl of labels) {
            const text = (await lbl.textContent().catch(() => '') || '').trim();
            if (selections.some(s => text.toLowerCase() === s || text.toLowerCase().includes(s))) {
              await lbl.click().catch(() => {});
            }
          }
        } else {
          // Single-select radio
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
          // Verify radio got checked
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
          // Last resort: select within fieldset
          if (!clicked || !(await fs.$('input:checked'))) {
            if (field.hasSelect) {
              const sel = await fs.$('select');
              if (sel) await this.selectOptionFuzzy(sel, answer);
            }
          }
        }
      } else {
        unknown.push(field.legend);
      }
    }

    // --- Selects (standalone) ---
    const selEls = snap.selects.length > 0 ? await container.$$('select') : [];
    for (const field of snap.selects) {
      if (field.inFieldset) continue; // handled above
      const sel = selEls[field.index];
      if (!sel) continue;

      const existing = field.selectedText || field.value || '';
      if (existing && !/^select an? /i.test(existing)) continue;

      let answer = this.answerFor(field.label);
      // Validate answer against available options
      if (answer && field.options.length > 0) {
        const ansLower = answer.toLowerCase();
        const matches = field.options.some(o =>
          o.toLowerCase() === ansLower || o.toLowerCase().includes(ansLower) || ansLower.includes(o.toLowerCase())
        );
        if (!matches) answer = null;
      }
      if (!answer) {
        // EEO/voluntary fields
        const ll = field.label.toLowerCase();
        if (ll.includes('race') || ll.includes('ethnicity') || ll.includes('gender') ||
            ll.includes('veteran') || ll.includes('disability') || ll.includes('identification')) {
          // Find "prefer not to disclose" option from snapshot
          const declineOpt = field.options.find(t => /prefer not|decline|do not wish|i don/i.test(t));
          if (declineOpt) {
            await sel.selectOption({ label: declineOpt }).catch(() => {});
          }
          continue;
        }
        // AI fallback for required selects
        if (field.required) {
          answer = await this.aiAnswerFor(field.label, { options: field.options });
          if (answer) {
            this.saveAnswer(field.label, answer);
          } else {
            unknown.push({ label: field.label, type: 'select', options: field.options });
            continue;
          }
        }
      }
      if (answer) {
        await this.selectOptionFuzzy(sel, answer);
      }
    }

    // --- Checkboxes (standalone) ---
    const cbEls = snap.checkboxes.length > 0 ? await container.$$('input[type="checkbox"]') : [];
    for (const field of snap.checkboxes) {
      if (field.checked) continue;
      const ll = field.label.toLowerCase();
      if (ll.includes('top choice') || ll.includes('interested') || ll.includes('confirm') || ll.includes('agree') || ll.includes('consent')) {
        const el = cbEls[field.index];
        if (el) await el.check().catch(() => {});
      }
    }

    return unknown;
  }
}
