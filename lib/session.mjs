/**
 * session.mjs — Kernel Managed Auth session management
 * Checks auth status before browser creation, triggers re-auth when needed.
 *
 * Flow:
 * 1. Check connection status via SDK
 * 2. If AUTHENTICATED → good to go
 * 3. If NEEDS_AUTH + can_reauth → trigger login(), poll until done
 * 4. If NEEDS_AUTH + !can_reauth → return false (caller should alert + skip)
 */
import { createRequire } from 'module';
import {
  KERNEL_SDK_PATH, SESSION_REFRESH_POLL_TIMEOUT, SESSION_REFRESH_POLL_WAIT,
} from './constants.mjs';
const require = createRequire(import.meta.url);

function getKernel(apiKey) {
  const Kernel = require(KERNEL_SDK_PATH);
  return new Kernel({ apiKey });
}

/**
 * Check auth connection status and re-auth if needed.
 * Returns { ok: true } or { ok: false, reason: string }
 */
export async function ensureAuth(platform, apiKey, connectionIds = {}) {
  const connectionId = connectionIds[platform];
  if (!connectionId) {
    return { ok: false, reason: `no connection ID configured for ${platform}` };
  }

  const kernel = getKernel(apiKey);

  // Check current status
  let conn;
  try {
    conn = await kernel.auth.connections.retrieve(connectionId);
  } catch (e) {
    return { ok: false, reason: `connection ${connectionId} not found: ${e.message}` };
  }

  if (conn.status === 'AUTHENTICATED') {
    return { ok: true };
  }

  // NEEDS_AUTH — can we auto re-auth?
  if (!conn.can_reauth) {
    return { ok: false, reason: `${platform} needs manual re-login (can_reauth=false). Go to Kernel dashboard or run: kernel auth connections login ${connectionId}` };
  }

  // Trigger re-auth with stored credentials
  console.log(`  🔄 ${platform} session expired — re-authenticating...`);
  try {
    await kernel.auth.connections.login(connectionId);
  } catch (e) {
    return { ok: false, reason: `re-auth login() failed: ${e.message}` };
  }

  // Poll until complete
  const start = Date.now();
  while (Date.now() - start < SESSION_REFRESH_POLL_TIMEOUT) {
    await new Promise(r => setTimeout(r, SESSION_REFRESH_POLL_WAIT));
    try {
      conn = await kernel.auth.connections.retrieve(connectionId);
    } catch (e) {
      return { ok: false, reason: `polling failed: ${e.message}` };
    }

    if (conn.status === 'AUTHENTICATED') {
      console.log(`  ✅ ${platform} re-authenticated`);
      return { ok: true };
    }

    if (conn.flow_status === 'FAILED') {
      return { ok: false, reason: `re-auth failed: ${conn.error_message || conn.error_code || 'unknown'}` };
    }
    if (conn.flow_status === 'EXPIRED' || conn.flow_status === 'CANCELED') {
      return { ok: false, reason: `re-auth ${conn.flow_status.toLowerCase()}` };
    }
  }

  return { ok: false, reason: `re-auth timed out after ${SESSION_REFRESH_POLL_TIMEOUT / 1000}s` };
}
