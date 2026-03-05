/**
 * notify.mjs — Telegram notifications
 * Sends messages directly via Telegram Bot API
 */

export async function sendTelegram(settings, message) {
  const { bot_token, telegram_user_id } = settings.notifications;
  if (!bot_token || !telegram_user_id) {
    console.log(`[notify] No Telegram config — would send: ${message.substring(0, 80)}`);
    return;
  }

  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
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
    const data = await res.json();
    if (!data.ok) console.error('[notify] Telegram error:', data.description);
  } catch (e) {
    console.error('[notify] Failed to send Telegram message:', e.message);
  }
}

export function formatSearchSummary(added, skipped, platforms) {
  if (added === 0) return `🔍 *Job Search Complete*\nNo new jobs found this run.`;
  return `🔍 *Job Search Complete*\n${added} new job${added !== 1 ? 's' : ''} added to queue (${skipped} already seen)\nPlatforms: ${platforms.join(', ')}`;
}

export function formatApplySummary(results) {
  const { submitted, failed, needs_answer, total,
          skipped_recruiter, skipped_external, skipped_no_easy_apply } = results;
  const lines = [
    `✅ *Apply Run Complete*`,
    `Applied: ${submitted} | Failed: ${failed} | Needs answer: ${needs_answer}`,
    `Skipped: ${skipped_recruiter} recruiter-only | ${skipped_external} external ATS | ${skipped_no_easy_apply} no Easy Apply`,
    `Total processed: ${total}`,
  ];
  if (needs_answer > 0) lines.push(`\n💬 Check messages — I sent questions that need your answers`);
  if (skipped_external > 0) lines.push(`\n🔜 ${skipped_external} external ATS jobs saved for when Greenhouse/Lever support lands`);
  return lines.join('\n');
}

export function formatUnknownQuestion(job, question) {
  return `❓ *Unknown question while applying*\n\n*Job:* ${job.title} @ ${job.company}\n*Question:* "${question}"\n\nWhat should I answer? (Reply and I'll save it for all future runs)`;
}
