/**
 * greenhouse.mjs — Greenhouse ATS handler (extends generic)
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['greenhouse'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    submitSelector: 'button:has-text("Submit Application"), input[type="submit"]',
  });
}
