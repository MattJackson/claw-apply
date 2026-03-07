/**
 * lever.mjs — Lever ATS handler
 * Delegates to generic handler — Lever forms are standard HTML forms
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['lever'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller);
}
