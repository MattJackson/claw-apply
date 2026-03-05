/**
 * browser.mjs — Browser factory
 * Creates Kernel stealth browsers or falls back to local Playwright
 */
import { chromium } from 'playwright';

export async function createBrowser(settings, profileKey) {
  const { provider, playwright_path } = settings.browser || {};
  const kernelConfig = settings.kernel || {};

  if (provider === 'local') {
    return createLocalBrowser();
  }

  // Default: Kernel
  try {
    return await createKernelBrowser(kernelConfig, profileKey);
  } catch (e) {
    console.warn(`[browser] Kernel failed (${e.message}), falling back to local`);
    return createLocalBrowser();
  }
}

async function createKernelBrowser(kernelConfig, profileKey) {
  // Dynamic import so it doesn't crash if not installed
  let Kernel;
  try {
    const mod = await import('@onkernel/sdk');
    Kernel = mod.default;
  } catch {
    throw new Error('Kernel SDK not installed — run: npm install @onkernel/sdk');
  }

  if (!process.env.KERNEL_API_KEY) throw new Error('KERNEL_API_KEY not set');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });

  const profileName = kernelConfig.profiles?.[profileKey];
  if (!profileName) throw new Error(`No Kernel profile configured for "${profileKey}"`);

  const opts = { stealth: true, profile: { name: profileName } };
  if (kernelConfig.proxy_id) opts.proxy = { id: kernelConfig.proxy_id };

  const kb = await kernel.browsers.create(opts);

  // Use system playwright or configured path
  let pw = chromium;
  if (kernelConfig.playwright_path) {
    const mod = await import(kernelConfig.playwright_path);
    pw = mod.chromium;
  }

  const browser = await pw.connectOverCDP(kb.cdp_ws_url);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();

  return { browser, page, type: 'kernel' };
}

async function createLocalBrowser() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  return { browser, page, type: 'local' };
}
