/**
 * index.mjs — Apply handler registry
 *
 * Two lookup mechanisms:
 * 1. apply_type → handler (explicit ATS classification)
 * 2. apply_url domain → handler (auto-detect from URL, fallback to generic)
 */
import * as easyApply  from './easy_apply.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as lever      from './lever.mjs';
import * as workday    from './workday.mjs';
import * as ashby      from './ashby.mjs';
import * as jobvite    from './jobvite.mjs';
import * as wellfound  from './wellfound.mjs';
import * as generic    from './generic.mjs';

const ALL_HANDLERS = [
  easyApply,
  greenhouse,
  lever,
  workday,
  ashby,
  jobvite,
  wellfound,
  generic,
];

// Build registry: apply_type → handler
const REGISTRY = {};
for (const handler of ALL_HANDLERS) {
  for (const type of handler.SUPPORTED_TYPES) {
    REGISTRY[type] = handler;
  }
}

// Domain → handler mapping for URL-based auto-detection
// When apply_type is unknown_external, match apply_url against these patterns
const DOMAIN_REGISTRY = [
  { pattern: /ashbyhq\.com/i,                    handler: ashby },
  { pattern: /greenhouse\.io|grnh\.se/i,         handler: greenhouse },
  { pattern: /lever\.co|jobs\.lever\.co/i,       handler: lever },
  { pattern: /workday\.com|myworkdayjobs\.com|myworkdaysite\.com/i, handler: workday },
  { pattern: /jobvite\.com|applytojob\.com/i,    handler: jobvite },
];

/**
 * Get handler for a job — checks apply_type first, then URL domain, then generic
 */
function resolveHandler(job) {
  // Explicit type match
  if (job.apply_type && REGISTRY[job.apply_type]) {
    return REGISTRY[job.apply_type];
  }

  // Domain match from apply_url
  if (job.apply_url) {
    for (const { pattern, handler } of DOMAIN_REGISTRY) {
      if (pattern.test(job.apply_url)) return handler;
    }
  }

  // Fallback to generic if it has a URL, otherwise unsupported
  return job.apply_url ? generic : null;
}

/**
 * List all supported apply types
 */
export function supportedTypes() {
  return Object.keys(REGISTRY);
}

const STATUS_MAP = {
  no_button:  'skipped_no_apply',
  no_submit:  'skipped_no_apply',
  no_modal:   'skipped_no_apply',
};

/**
 * Apply to a job using the appropriate handler
 * Returns result object with normalized status
 */
export async function applyToJob(page, job, formFiller) {
  const handler = resolveHandler(job);
  if (!handler) {
    return {
      status: 'skipped_external_unsupported',
      meta: { title: job.title, company: job.company },
      externalUrl: job.apply_url || '',
      ats_platform: job.apply_type || 'unknown',
    };
  }
  const result = await handler.apply(page, job, formFiller);
  return { ...result, status: STATUS_MAP[result.status] || result.status };
}
