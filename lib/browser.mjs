/**
 * browser.mjs — Browser factory
 * Creates Kernel stealth browsers for all operations
 */
import { KERNEL_SDK_PATH, DEFAULT_PLAYWRIGHT_PATH } from './constants.mjs';

let _chromium;
async function getChromium(playwrightPath) {
  if (_chromium) return _chromium;
  const paths = [playwrightPath, DEFAULT_PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  for (const p of paths) {
    try { const m = await import(p); _chromium = m.chromium; return _chromium; } catch {}
  }
  throw new Error('Playwright not found — install with: npm install -g playwright');
}

export async function createBrowser(settings, profileKey) {
  const kernelConfig = settings.kernel || {};
  const playwrightPath = settings.browser?.playwright_path;
  const apiKey = process.env.KERNEL_API_KEY || settings.kernel_api_key;

  if (!apiKey) throw new Error('KERNEL_API_KEY not set');

  let Kernel;
  try {
    const mod = await import(KERNEL_SDK_PATH);
    Kernel = mod.default;
  } catch {
    throw new Error('Kernel SDK not installed — run: npm install @onkernel/sdk');
  }

  const kernel = new Kernel({ apiKey });

  const profileName = profileKey ? kernelConfig.profiles?.[profileKey] : null;
  if (profileKey && !profileName) throw new Error(`No Kernel profile configured for "${profileKey}"`);

  const opts = { stealth: true };
  if (profileName) opts.profile = { name: profileName };
  if (kernelConfig.proxy_id) opts.proxy = { id: kernelConfig.proxy_id };

  let kb;
  try {
    kb = await kernel.browsers.create(opts);
  } catch (e) {
    throw new Error(`Kernel browser creation failed: ${e.message}`);
  }
  const pw = await getChromium(playwrightPath);
  let browser;
  try {
    browser = await pw.connectOverCDP(kb.cdp_ws_url);
  } catch (e) {
    throw new Error(`CDP connection failed (browser ${kb.id}): ${e.message}`);
  }
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();

  return { browser, page, type: 'kernel', kernel, kernelBrowserId: kb.id };
}
