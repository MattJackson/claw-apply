/**
 * index.mjs — Apply handler registry
 * Maps apply_type → handler module
 * To add a new ATS: create lib/apply/<name>.mjs and add one line here
 */
import * as easyApply  from './easy_apply.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as lever      from './lever.mjs';
import * as workday    from './workday.mjs';
import * as ashby      from './ashby.mjs';
import * as jobvite    from './jobvite.mjs';
import * as wellfound  from './wellfound.mjs';

const ALL_HANDLERS = [
  easyApply,
  greenhouse,
  lever,
  workday,
  ashby,
  jobvite,
  wellfound,
];

// Build registry: apply_type → handler
const REGISTRY = {};
for (const handler of ALL_HANDLERS) {
  for (const type of handler.SUPPORTED_TYPES) {
    REGISTRY[type] = handler;
  }
}

/**
 * Get handler for a given apply_type
 * Returns null if not supported
 */
export function getHandler(applyType) {
  return REGISTRY[applyType] || null;
}

/**
 * List all supported apply types
 */
export function supportedTypes() {
  return Object.keys(REGISTRY);
}

/**
 * Apply to a job using the appropriate handler
 * Returns result object with status
 */
export async function applyToJob(page, job, formFiller) {
  const handler = getHandler(job.apply_type);
  if (!handler) {
    return {
      status: 'skipped_external_unsupported',
      meta: { title: job.title, company: job.company },
      externalUrl: job.apply_url || '',
      ats_platform: job.apply_type || 'unknown',
    };
  }
  return handler.apply(page, job, formFiller);
}
