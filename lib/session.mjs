/**
 * session.mjs — Kernel Managed Auth session refresh
 * Call refreshSession() before creating a browser to ensure the profile is fresh
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const KERNEL_SDK_PATH = '/home/ubuntu/.openclaw/workspace/node_modules/@onkernel/sdk/index.js';

const CONNECTION_IDS = {
  linkedin:  'REDACTED_CONNECTION_ID_LINKEDIN',
  wellfound: 'REDACTED_CONNECTION_ID_WELLFOUND',
};

export async function refreshSession(platform, apiKey) {
  const connectionId = CONNECTION_IDS[platform];
  if (!connectionId) throw new Error(`No connection ID for platform: ${platform}`);

  const Kernel = require(KERNEL_SDK_PATH);
  const kernel = new Kernel({ apiKey });

  console.log(`  🔄 Refreshing ${platform} session...`);

  // Trigger re-auth (uses stored credentials automatically)
  const loginResp = await kernel.auth.connections.login(connectionId);
  
  if (loginResp.status === 'SUCCESS') {
    console.log(`  ✅ ${platform} session refreshed`);
    return true;
  }

  // If not immediately successful, poll for up to 30s
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await new Promise(r => setTimeout(r, 2000));
    const conn = await kernel.auth.connections.retrieve(connectionId);
    if (conn.status === 'SUCCESS') {
      console.log(`  ✅ ${platform} session refreshed`);
      return true;
    }
    if (['FAILED', 'EXPIRED', 'CANCELED'].includes(conn.status)) {
      console.warn(`  ⚠️  ${platform} session refresh failed: ${conn.status}`);
      return false;
    }
  }

  console.warn(`  ⚠️  ${platform} session refresh timed out`);
  return false;
}

/**
 * Verify login after browser connects — if not logged in, trigger refresh and retry
 */
export async function ensureLoggedIn(page, verifyFn, platform, apiKey, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const loggedIn = await verifyFn(page);
    if (loggedIn) return true;

    if (attempt < maxAttempts) {
      console.warn(`  ⚠️  ${platform} not logged in (attempt ${attempt}), refreshing session...`);
      await refreshSession(platform, apiKey);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
  }
  return false;
}
