/**
 * filter.mjs — AI job relevance filter (Anthropic Batch API)
 * Scores queued jobs 0-10 against candidate profile using Claude (Sonnet by default)
 * Uses Batch API for 50% cost savings + prompt caching for shared context
 */

import { readFileSync, existsSync } from 'fs';

const DESC_MAX_CHARS = 800;
const BATCH_API = 'https://api.anthropic.com/v1/messages/batches';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function loadProfile(profilePath) {
  if (!profilePath || !existsSync(profilePath)) return null;
  try { return JSON.parse(readFileSync(profilePath, 'utf8')); } catch { return null; }
}

function buildSystemPrompt(jobProfile, candidateProfile) {
  const tr = jobProfile.target_role;
  const exp = jobProfile.experience || {};
  const highlights = (exp.highlights || []).map(h => `- ${h}`).join('\n');

  return `You are a job relevance scorer. Score each job 0-10 based on how well it matches this candidate.

## Candidate
- Name: ${candidateProfile.name?.first} ${candidateProfile.name?.last}
- Location: ${candidateProfile.location?.city}, ${candidateProfile.location?.state} (remote only, will not relocate)
- Years in sales: ${candidateProfile.years_experience}
- Desired salary: $${(candidateProfile.desired_salary || 0).toLocaleString()}
- Background: ${(candidateProfile.cover_letter || '').substring(0, 300)}

## Target Role Criteria
- Titles: ${(tr.titles || []).join(', ')}
- Industries: ${(exp.industries || []).join(', ')}
- Company stage: ${(tr.company_stage || []).join(', ') || 'any'}
- Company size: ${tr.company_size || 'any'}
- Salary minimum: $${(tr.salary_min || 0).toLocaleString()}
- Remote only: ${tr.remote ? 'Yes' : 'No'}
- Excluded keywords: ${(tr.exclude_keywords || []).join(', ')}

## Experience Highlights
${highlights}

## Scoring Guide
10 = Perfect match (exact title, right company stage, right industry, right salary range)
7-9 = Strong match (right role type, maybe slightly off industry or stage)
5-6 = Borderline (relevant but some mismatches — wrong industry, seniority, or vague posting)
3-4 = Weak match (mostly off target but some overlap)
0-2 = Not relevant (wrong role type, wrong industry, recruiter spam, part-time, etc.)

Penalize heavily for:
- Part-time roles
- Wrong industry (insurance, healthcare PR, construction, retail, K-12 education, utilities)
- Wrong role type (SDR/BDR, customer success, partnerships, marketing, coordinator)
- Junior or entry-level positions
- Staffing agency spam with no real company named
- Salary clearly below minimum

Return ONLY a JSON object: {"score": <0-10>, "reason": "<one line>"}`;
}

function sanitize(str) {
  // Remove lone surrogates and other invalid Unicode that breaks JSON encoding
  return (str || '').replace(/[\uD800-\uDFFF]/g, '').replace(/\0/g, '');
}

function buildJobMessage(job) {
  const desc = sanitize(job.description).substring(0, DESC_MAX_CHARS).replace(/\s+/g, ' ').trim();
  return `Title: ${sanitize(job.title)}
Company: ${sanitize(job.company) || 'Unknown'}
Location: ${sanitize(job.location) || 'Unknown'}
Description: ${desc}

Return ONLY: {"score": <0-10>, "reason": "<one line>"}`;
}

// ---------------------------------------------------------------------------
// Batch API
// ---------------------------------------------------------------------------

function apiHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  };
}

/**
 * Submit all jobs as a single Anthropic batch.
 * System prompt is marked cache_control=ephemeral so it's cached across requests.
 * Returns the batch ID.
 */
export async function submitBatch(jobs, jobProfilesByTrack, searchConfig, candidateProfile, model, apiKey) {
  const globalMin = searchConfig.filter_min_score ?? 5;

  const requests = [];
  const idMap = {}; // custom_id → job.id (handles truncation edge cases)

  for (const job of jobs) {
    const track = job.track || 'ae';
    const jobProfile = jobProfilesByTrack[track];
    if (!jobProfile) continue; // no profile → skip (caller handles this)

    const systemPrompt = buildSystemPrompt(jobProfile, candidateProfile);
    // Anthropic custom_id max 64 chars
    const customId = job.id.length <= 64 ? job.id : job.id.substring(0, 64);
    idMap[customId] = job.id;

    requests.push({
      custom_id: customId,
      params: {
        model,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }, // cache the shared context
          }
        ],
        messages: [
          { role: 'user', content: buildJobMessage(job) }
        ],
      }
    });
  }

  if (requests.length === 0) throw new Error('No requests to submit — check job profiles are configured');

  // Return idMap alongside batch ID so collector can resolve truncated IDs
  const res = await fetch(BATCH_API, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Batch submit failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return { batchId: data.id, idMap };
}

/**
 * Check batch status. Returns { status: 'in_progress'|'ended', counts }
 */
export async function checkBatch(batchId, apiKey) {
  const res = await fetch(`${BATCH_API}/${batchId}`, {
    headers: apiHeaders(apiKey),
  });

  if (!res.ok) throw new Error(`Batch status check failed ${res.status}`);
  const data = await res.json();

  return {
    status: data.processing_status, // 'in_progress' | 'ended'
    counts: data.request_counts,    // { processing, succeeded, errored, canceled, expired }
    resultsUrl: data.results_url,
  };
}

/**
 * Download and parse batch results. Returns array of { jobId, score, reason, error }
 */
export async function downloadResults(batchId, apiKey, idMap = {}) {
  const res = await fetch(`${BATCH_API}/${batchId}/results`, {
    headers: apiHeaders(apiKey),
  });

  if (!res.ok) throw new Error(`Results download failed ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  const results = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Resolve truncated custom_id back to original job ID
      const jobId = idMap[entry.custom_id] || entry.custom_id;

      if (entry.result?.type === 'succeeded') {
        const content = entry.result.message?.content?.[0]?.text || '';
        try {
          const clean = content.replace(/```json\n?|\n?```/g, '').trim();
          const parsed = JSON.parse(clean);
          results.push({ jobId, score: parsed.score, reason: parsed.reason });
        } catch {
          results.push({ jobId, score: null, reason: 'parse_error', error: true });
        }
      } else {
        results.push({ jobId, score: null, reason: entry.result?.type || 'unknown_error', error: true });
      }
    } catch {
      // malformed line — skip
    }
  }

  return results;
}
