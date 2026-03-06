/**
 * session.mjs — Kernel Managed Auth session refresh
 * Call refreshSession() before creating a browser to ensure the profile is fresh
 */
import { createRequire } from 'module';
import {
  KERNEL_SDK_PATH, SESSION_REFRESH_POLL_TIMEOUT, SESSION_REFRESH_POLL_WAIT,
  SESSION_LOGIN_VERIFY_WAIT
} from './constants.mjs';
const require = createRequire(import.meta.url);

export async function refreshSession(platform, apiKey, connectionIds = {}) {
  const connectionId = connectionIds[platform];
  if (!connectionId) throw new Error(`No Kernel connection ID configured for platform: ${platform} — add it to settings.json under kernel.connection_ids`);

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
  console.log(`  ⏳ ${platform} session pending (status: ${loginResp.status}), polling...`);
  const start = Date.now();
  let pollCount = 0;
  while (Date.now() - start < SESSION_REFRESH_POLL_TIMEOUT) {
    await new Promise(r => setTimeout(r, SESSION_REFRESH_POLL_WAIT));
    pollCount++;
    const conn = await kernel.auth.connections.retrieve(connectionId);
    if (conn.status === 'SUCCESS') {
      console.log(`  ✅ ${platform} session refreshed (after ${pollCount} polls)`);
      return true;
    }
    if (['FAILED', 'EXPIRED', 'CANCELED'].includes(conn.status)) {
      console.warn(`  ⚠️  ${platform} session refresh failed: ${conn.status} (after ${pollCount} polls)`);
      return false;
    }
  }

  console.warn(`  ⚠️  ${platform} session refresh timed out`);
  return false;
}

/**
 * Verify login after browser connects — if not logged in, trigger refresh and retry
 */
export async function ensureLoggedIn(page, verifyFn, platform, apiKey, connectionIds = {}, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const loggedIn = await verifyFn(page);
    if (loggedIn) return true;

    if (attempt < maxAttempts) {
      console.warn(`  ⚠️  ${platform} not logged in (attempt ${attempt}), refreshing session...`);
      await refreshSession(platform, apiKey, connectionIds);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(SESSION_LOGIN_VERIFY_WAIT);
    }
  }
  return false;
}
