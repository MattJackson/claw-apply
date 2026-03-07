/**
 * jobvite.mjs — Jobvite ATS handler
 * Delegates to generic handler — Jobvite forms are standard HTML forms
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['jobvite'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller);
}
