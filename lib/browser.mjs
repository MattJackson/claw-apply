/**
 * browser.mjs — Browser factory
 * Creates Kernel stealth browsers or falls back to local Playwright
 */
import { LOCAL_USER_AGENT, KERNEL_SDK_PATH, DEFAULT_PLAYWRIGHT_PATH } from './constants.mjs';

// Use configured playwright path or fall back to npm global
let _chromium;
async function getChromium(playwrightPath) {
  if (_chromium) return _chromium;
  const paths = [
    playwrightPath,
    DEFAULT_PLAYWRIGHT_PATH,
    'playwright'
  ].filter(Boolean);
  for (const p of paths) {
    try { const m = await import(p); _chromium = m.chromium; return _chromium; } catch {}
  }
  throw new Error('Playwright not found — install with: npm install -g playwright');
}

export async function createBrowser(settings, profileKey) {
  const { provider, playwright_path } = settings.browser || {};
  const kernelConfig = settings.kernel || {};

  const pwPath = settings.browser?.playwright_path;

  if (provider === 'local') {
    return createLocalBrowser(pwPath);
  }

  // Default: Kernel
  try {
    return await createKernelBrowser(kernelConfig, profileKey, pwPath);
  } catch (e) {
    console.warn(`[browser] Kernel failed (${e.message}), falling back to local`);
    return createLocalBrowser(pwPath);
  }
}

async function createKernelBrowser(kernelConfig, profileKey, playwrightPath) {
  let Kernel;
  try {
    const mod = await import(KERNEL_SDK_PATH);
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
  const pw = await getChromium(playwrightPath);
  const browser = await pw.connectOverCDP(kb.cdp_ws_url);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();

  return { browser, page, type: 'kernel' };
}

async function createLocalBrowser(playwrightPath) {
  const chromium = await getChromium(playwrightPath);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: LOCAL_USER_AGENT });
  const page = await ctx.newPage();
  return { browser, page, type: 'local' };
}
