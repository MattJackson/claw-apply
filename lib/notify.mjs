/**
 * notify.mjs — Telegram notifications
 * Sends messages directly via Telegram Bot API
 */
import { TELEGRAM_API_BASE, NOTIFY_RATE_LIMIT_MS } from './constants.mjs';

let lastSentAt = 0;

/**
 * Send a Telegram message. Returns the message_id on success (useful for tracking replies).
 */
export async function sendTelegram(settings, message) {
  const { bot_token, telegram_user_id } = settings.notifications || {};
  if (!bot_token || !telegram_user_id) {
    console.log(`[notify] No Telegram config — would send: ${message.substring(0, 80)}`);
    return null;
  }

  // Rate limit to avoid Telegram API throttling
  const now = Date.now();
  const elapsed = now - lastSentAt;
  if (elapsed < NOTIFY_RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, NOTIFY_RATE_LIMIT_MS - elapsed));
  }

  const url = `${TELEGRAM_API_BASE}${bot_token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram_user_id,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    lastSentAt = Date.now();
    if (!res.ok) { console.error(`[notify] Telegram HTTP error: ${res.status}`); return null; }
    const data = await res.json();
    if (!data.ok) { console.error('[notify] Telegram error:', data.description); return null; }
    return data.result?.message_id || null;
  } catch (e) {
    console.error('[notify] Failed to send Telegram message:', e.message);
    return null;
  }
}

/**
 * Get updates from Telegram Bot API (long polling).
 * @param {string} botToken
 * @param {number} offset - Update ID offset (pass last_update_id + 1)
 * @param {number} timeout - Long poll timeout in seconds
 * @returns {Array} Array of update objects
 */
export async function getTelegramUpdates(botToken, offset = 0, timeout = 5) {
  const url = `${TELEGRAM_API_BASE}${botToken}/getUpdates`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.ok ? (data.result || []) : [];
  } catch {
    return [];
  }
}

/**
 * Reply to a specific Telegram message.
 */
export async function replyTelegram(botToken, chatId, replyToMessageId, text) {
  const url = `${TELEGRAM_API_BASE}${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        parse_mode: 'Markdown',
      }),
    });
  } catch { /* best effort */ }
}

export function formatSearchSummary(added, skipped, platforms) {
  if (added === 0) return `🔍 *Job Search Complete*\nNo new jobs found this run.`;
  return `🔍 *Job Search Complete*\n${added} new job${added !== 1 ? 's' : ''} added to queue (${skipped} already seen)\nPlatforms: ${platforms.join(', ')}`;
}

export function formatApplySummary(results) {
  const { submitted, failed, needs_answer, total,
          skipped_recruiter, skipped_external, skipped_no_apply,
          skipped_other, already_applied, atsCounts } = results;

  const lines = [
    `✅ *Apply Run Complete* — ${total} jobs processed`,
    ``,
    `📬 Applied: ${submitted}`,
    `⏭️  No apply button: ${skipped_no_apply || 0}`,
    `🚫 Recruiter-only: ${skipped_recruiter}`,
    `🔁 Already applied: ${already_applied || 0}`,
    `❌ Failed: ${failed}`,
    `💬 Needs your answer: ${needs_answer}`,
  ];

  if (skipped_other > 0) {
    lines.push(`⚠️  Other skips (honeypot/stuck/incomplete): ${skipped_other}`);
  }

  if (skipped_external > 0 && atsCounts) {
    const sorted = Object.entries(atsCounts).sort((a, b) => b[1] - a[1]);
    lines.push(``, `🌐 *External ATS — ${skipped_external} jobs* (saved for later):`);
    for (const [platform, count] of sorted) {
      lines.push(`  • ${platform}: ${count}`);
    }
  }

  if (needs_answer > 0) lines.push(``, `💬 Check Telegram — questions waiting for your answers`);

  return lines.join('\n');
}

export function formatUnknownQuestion(job, question) {
  return `❓ *Unknown question while applying*\n\n*Job:* ${job.title} @ ${job.company}\n*Question:* "${question}"\n\nWhat should I answer? (Reply and I'll save it for all future runs)`;
}
