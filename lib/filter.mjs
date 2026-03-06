/**
 * filter.mjs — AI job relevance filter
 * Scores queued jobs 0-10 against candidate profile + job profiles using Claude Haiku
 * Jobs below filter_min_score are marked 'filtered' and skipped by the applier
 */

import { readFileSync, existsSync } from 'fs';

const BATCH_SIZE = 10;
const DESC_MAX_CHARS = 800;

function loadProfile(profilePath) {
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
5-6 = Borderline (relevant but some mismatches — wrong industry, wrong seniority, or vague posting)
3-4 = Weak match (mostly off target but some overlap)
0-2 = Not relevant (wrong role type, wrong industry, recruiter spam, part-time, etc.)

Penalize heavily for:
- Part-time roles
- Wrong industry (insurance, healthcare PR, construction, retail, K-12 education, utilities)
- Wrong role type (SDR/BDR, customer success, partnerships, marketing, coordinator)
- Junior or entry-level
- Staffing agency spam where no real company is named
- Salary clearly below minimum`;
}

function buildUserPrompt(jobs) {
  const jobList = jobs.map((j, i) => {
    const desc = (j.description || '').substring(0, DESC_MAX_CHARS).replace(/\s+/g, ' ').trim();
    return `JOB ${i + 1}
Title: ${j.title}
Company: ${j.company || 'Unknown'}
Location: ${j.location || 'Unknown'}
Description: ${desc}`;
  }).join('\n\n---\n\n');

  return `Score each of the following ${jobs.length} jobs. Return ONLY a JSON array with one object per job in order:
[{"score": 7, "reason": "one line explaining score"}, ...]

${jobList}`;
}

async function filterBatch(jobs, jobProfile, candidateProfile, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: buildSystemPrompt(jobProfile, candidateProfile),
      messages: [{ role: 'user', content: buildUserPrompt(jobs) }]
    })
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.content[0].text.trim();
  const clean = text.replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(clean);
}

/**
 * runFilter — score all new jobs and return results
 * @param {Array} jobs - jobs with status 'new'
 * @param {Object} searchConfig - search_config.json
 * @param {Object} settings - settings.json (needs settings.filter.job_profiles)
 * @param {Object} candidateProfile - profile.json
 * @param {string} apiKey - Anthropic API key
 * @param {Object} opts - { onProgress }
 * @returns {Array} [{ job, score, reason, pass, minScore }]
 */
export async function runFilter(jobs, searchConfig, settings, candidateProfile, apiKey, { onProgress } = {}) {
  const globalMin = searchConfig.filter_min_score ?? 5;

  // Group jobs by track
  const byTrack = {};
  for (const job of jobs) {
    const track = job.track || 'ae';
    if (!byTrack[track]) byTrack[track] = [];
    byTrack[track].push(job);
  }

  const results = [];

  for (const [track, trackJobs] of Object.entries(byTrack)) {
    const searchEntry = (searchConfig.searches || []).find(s => s.track === track);
    const minScore = searchEntry?.filter_min_score ?? globalMin;

    const profilePath = settings.filter?.job_profiles?.[track];
    const jobProfile = loadProfile(profilePath);

    if (!jobProfile) {
      console.warn(`⚠️  No job profile configured for track "${track}" — passing ${trackJobs.length} jobs through unfiltered`);
      for (const job of trackJobs) {
        results.push({ job, score: null, reason: 'no_profile', pass: true, minScore });
      }
      continue;
    }

    let done = 0;
    for (let i = 0; i < trackJobs.length; i += BATCH_SIZE) {
      const batch = trackJobs.slice(i, i + BATCH_SIZE);

      try {
        const scores = await filterBatch(batch, jobProfile, candidateProfile, apiKey);

        for (let j = 0; j < batch.length; j++) {
          const job = batch[j];
          const result = scores[j] || { score: 5, reason: 'parse_error' };
          results.push({
            job,
            score: result.score,
            reason: result.reason,
            pass: result.score >= minScore,
            minScore
          });
        }
      } catch (err) {
        console.error(`\n  Filter batch error (track: ${track}, batch ${i}–${i + batch.length}): ${err.message}`);
        // On error, pass jobs through — don't block applications
        for (const job of batch) {
          results.push({ job, score: null, reason: 'filter_error', pass: true, minScore });
        }
      }

      done += batch.length;
      if (onProgress) onProgress(done, trackJobs.length, track);
    }
  }

  return results;
}
