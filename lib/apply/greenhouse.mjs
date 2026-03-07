/**
 * greenhouse.mjs — Greenhouse ATS handler
 * Delegates to generic handler — Greenhouse forms are standard HTML forms
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['greenhouse'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller);
}
