/**
 * workday.mjs — Workday ATS handler (extends generic)
 * Most Workday sites require account creation — generic will return skipped_login_required
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['workday'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller, {
    closedTexts: ['this job posting is no longer active'],
  });
}
