/**
 * jobvite.mjs — Jobvite ATS handler (extends generic)
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['jobvite'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    submitSelector: 'button:has-text("Submit"), input[type="submit"]',
  });
}
