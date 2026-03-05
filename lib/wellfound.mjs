/**
 * wellfound.mjs — Wellfound search and apply
 */

export async function verifyLogin(page) {
  await page.goto('https://wellfound.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);
  const loggedIn = await page.evaluate(() =>
    document.body.innerText.includes('Applied') || document.body.innerText.includes('Open to offers')
  );
  return loggedIn;
}

export async function searchWellfound(page, search) {
  const jobs = [];

  for (const keyword of search.keywords) {
    const url = `https://wellfound.com/jobs?q=${encodeURIComponent(keyword)}&remote=true`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollBy(0, 3000));
    await page.waitForTimeout(2000);

    const found = await page.evaluate(({ track, excludes }) => {
      const seen = new Set();
      const results = [];

      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        const isJob = href.match(/wellfound\.com\/(jobs\/.{5,}|l\/.+)/) &&
                      !href.match(/\/(home|applications|messages|starred|on-demand|settings|profile|jobs\?)$/);
        if (!isJob) return;
        seen.add(href);

        const card = a.closest('[class*="job"]') || a.closest('[class*="card"]') || a.closest('div') || a.parentElement;
        const title = a.textContent?.trim().substring(0, 100) || '';
        const company = card?.querySelector('[class*="company"], [class*="startup"], h2')?.textContent?.trim() || '';

        // Exclusion filter
        const titleL = title.toLowerCase();
        const companyL = company.toLowerCase();
        for (const ex of excludes) {
          if (titleL.includes(ex.toLowerCase()) || companyL.includes(ex.toLowerCase())) return;
        }

        if (title.length > 3) {
          results.push({
            id: `wf_${href.split('/').pop().split('?')[0]}_${Math.random().toString(36).slice(2,6)}`,
            platform: 'wellfound',
            track,
            title,
            company,
            url: href,
          });
        }
      });

      return results.slice(0, 30);
    }, { track: search.track, excludes: search.exclude_keywords || [] });

    jobs.push(...found);
  }

  // Dedupe by URL
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.url)) return false; seen.add(j.url); return true; });
}

export async function applyWellfound(page, job, formFiller) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);

  const meta = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim(),
    company: document.querySelector('[class*="company"] h2, [class*="startup"] h2, h2')?.textContent?.trim(),
  }));

  const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply Now"), a:has-text("Apply Now")');
  if (!applyBtn) return { status: 'no_button', meta };

  await applyBtn.click();
  await page.waitForTimeout(2500);

  // Fill form
  const unknowns = await formFiller.fill(page, formFiller.profile.resume_path);

  if (unknowns[0]?.honeypot) return { status: 'skipped_honeypot', meta };
  if (unknowns.length > 0) return { status: 'needs_answer', pending_question: unknowns[0], meta };

  const submitBtn = await page.$('button[type="submit"]:not([disabled]), input[type="submit"]');
  if (!submitBtn) return { status: 'no_submit', meta };

  await submitBtn.click();
  await page.waitForTimeout(2000);

  return { status: 'submitted', meta };
}
