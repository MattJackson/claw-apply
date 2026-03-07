/**
 * lever.mjs — Lever ATS handler (extends generic)
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['lever'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    // Lever apply URLs already end in /apply
    submitSelector: 'button:has-text("Submit application"), button[type="submit"]',
  });
}
