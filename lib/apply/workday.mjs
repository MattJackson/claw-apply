/**
 * workday.mjs — Workday ATS handler
 * Delegates to generic handler. Workday often requires account creation,
 * so many will return skipped_login_required — that's expected.
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['workday'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller);
}
