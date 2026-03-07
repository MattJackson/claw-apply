/**
 * ashby.mjs — Ashby ATS handler
 * Delegates to generic handler — Ashby forms are standard HTML forms
 */
import { apply as genericApply } from './generic.mjs';

export const SUPPORTED_TYPES = ['ashby'];

export async function apply(page, job, formFiller) {
  return genericApply(page, job, formFiller);
}
