/**
 * linkedin.mjs — LinkedIn search and Easy Apply
 */
import { makeJobId } from './queue.mjs';

const BASE = 'https://www.linkedin.com';

export async function verifyLogin(page) {
  await page.goto(`${BASE}/feed/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  return page.url().includes('/feed');
}

export async function searchLinkedIn(page, search) {
  const jobs = [];

  for (const keyword of search.keywords) {
    const params = new URLSearchParams({ keywords: keyword, sortBy: 'DD' });
    if (search.filters?.remote) params.set('f_WT', '2');
    if (search.filters?.easy_apply_only) params.set('f_LF', 'f_AL');
    if (search.filters?.posted_within_days) {
      const seconds = (search.filters.posted_within_days * 86400);
      params.set('f_TPR', `r${seconds}`);
    }

    const url = `${BASE}/jobs/search/?${params.toString()}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);

    const found = await page.evaluate((track, excludes) => {
      const ids = [...new Set(
        Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))
          .map(a => a.href.match(/\/jobs\/view\/(\d+)/)?.[1])
          .filter(Boolean)
      )];

      return ids.map(id => {
        const link = document.querySelector(`a[href*="/jobs/view/${id}"]`);
        const container = link?.closest('li') || link?.parentElement;
        const title = container?.querySelector('strong, [class*="title"], h3')?.textContent?.trim()
          || link?.textContent?.trim() || '';
        const company = container?.querySelector('[class*="company"], [class*="subtitle"], h4')?.textContent?.trim() || '';
        const location = container?.querySelector('[class*="location"]')?.textContent?.trim() || '';

        // Basic exclusion filter
        const titleLower = title.toLowerCase();
        const companyLower = company.toLowerCase();
        for (const ex of excludes) {
          if (titleLower.includes(ex.toLowerCase()) || companyLower.includes(ex.toLowerCase())) return null;
        }

        return { id: `li_${id}`, platform: 'linkedin', track, title, company, location,
                 url: `https://www.linkedin.com/jobs/view/${id}/`, jobId: id };
      }).filter(Boolean);
    }, search.track, search.exclude_keywords || []);

    jobs.push(...found);
  }

  // Dedupe by jobId
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
}

export async function applyLinkedIn(page, job, formFiller) {
  // Navigate to search results with Easy Apply filter to get two-panel view
  const params = new URLSearchParams({
    keywords: job.title,
    f_WT: '2',
    f_LF: 'f_AL',
    sortBy: 'DD'
  });
  await page.goto(`${BASE}/jobs/search/?${params.toString()}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);

  // Click the specific job by ID
  const clicked = await page.evaluate((jobId) => {
    const link = document.querySelector(`a[href*="/jobs/view/${jobId}"]`);
    if (link) { link.click(); return true; }
    return false;
  }, job.jobId || job.url.match(/\/jobs\/view\/(\d+)/)?.[1]);

  if (!clicked) {
    // Direct navigation fallback
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  await page.waitForTimeout(3000);

  // Get title/company from detail panel
  const meta = await page.evaluate(() => ({
    title: document.querySelector('.job-details-jobs-unified-top-card__job-title, h1[class*="title"]')?.textContent?.trim(),
    company: document.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.textContent?.trim(),
  }));

  // Find Easy Apply button
  const eaBtn = await page.$('button.jobs-apply-button[aria-label*="Easy Apply"]');
  if (!eaBtn) return { status: 'no_easy_apply', meta };

  // Click Easy Apply
  await page.click('button.jobs-apply-button', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const modal = await page.$('.jobs-easy-apply-modal');
  if (!modal) return { status: 'no_modal', meta };

  // Step through modal
  let lastProgress = '-1';
  for (let step = 0; step < 12; step++) {
    const modalStillOpen = await page.$('.jobs-easy-apply-modal');
    if (!modalStillOpen) return { status: 'submitted', meta };

    const progress = await page.$eval('[role="progressbar"]',
      el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || String(el.style?.width || step)
    ).catch(() => String(step));

    // Fill form fields — returns unknown required fields
    const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

    // Honeypot?
    if (unknowns[0]?.honeypot) {
      await page.click('button[aria-label="Dismiss"]', { timeout: 3000 }).catch(() => {});
      return { status: 'skipped_honeypot', meta };
    }

    // Has unknown required fields?
    if (unknowns.length > 0) {
      // Return first unknown question for user to answer
      const question = unknowns[0];
      await page.click('button[aria-label="Dismiss"]', { timeout: 3000 }).catch(() => {});
      return { status: 'needs_answer', pending_question: question, meta };
    }

    await page.waitForTimeout(600);

    // Submit?
    const hasSubmit = await page.$('button[aria-label="Submit application"]');
    if (hasSubmit) {
      await page.click('button[aria-label="Submit application"]', { timeout: 5000 });
      await page.waitForTimeout(2500);
      return { status: 'submitted', meta };
    }

    // Stuck?
    if (progress === lastProgress && step > 2) {
      await page.click('button[aria-label="Dismiss"]', { timeout: 3000 }).catch(() => {});
      return { status: 'stuck', meta };
    }

    // Next/Continue?
    const hasNext = await page.$('button[aria-label="Continue to next step"]');
    if (hasNext) {
      await page.click('button[aria-label="Continue to next step"]', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      lastProgress = progress;
      continue;
    }

    // Review?
    const hasReview = await page.$('button[aria-label="Review your application"]');
    if (hasReview) {
      await page.click('button[aria-label="Review your application"]', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      lastProgress = progress;
      continue;
    }

    break;
  }

  await page.click('button[aria-label="Dismiss"]', { timeout: 3000 }).catch(() => {});
  return { status: 'incomplete', meta };
}
