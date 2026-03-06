/**
 * search_progress.mjs — Track which searches have completed
 * Enables resume on restart without re-running finished searches
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

let progressPath = null;
let progress = null;

export function initProgress(dataDir, lookbackDays) {
  progressPath = `${dataDir}/search_progress.json`;

  if (existsSync(progressPath)) {
    const saved = JSON.parse(readFileSync(progressPath, 'utf8'));
    // Only resume if same lookback window
    if (saved.lookback_days === lookbackDays) {
      progress = saved;
      const done = progress.completed.length;
      if (done > 0) {
        console.log(`🔁 Resuming — skipping already-completed: ${progress.completed.join(', ')}\n`);
      }
      return progress;
    }
    console.log(`🆕 New lookback window (${lookbackDays}d), starting fresh\n`);
  }

  // Fresh start
  progress = {
    lookback_days: lookbackDays,
    started_at: Date.now(),
    completed: [],
    pending: [],
  };
  save();
  return progress;
}

export function isCompleted(platform, track) {
  if (!progress) return false;
  return progress.completed.includes(`${platform}:${track}`);
}

export function markComplete(platform, track, stats) {
  if (!progress) return;
  const key = `${platform}:${track}`;
  progress.pending = progress.pending.filter(k => k !== key);
  if (!progress.completed.includes(key)) progress.completed.push(key);
  progress[`stats:${key}`] = { ...stats, completed_at: Date.now() };
  save();
}

export function clearProgress() {
  try { if (progressPath) unlinkSync(progressPath); } catch {}
  progress = null;
}

function save() {
  if (progressPath && progress) {
    writeFileSync(progressPath, JSON.stringify(progress, null, 2));
  }
}
