/**
 * queue.mjs — Job queue management
 * Handles jobs_queue.json read/write/update
 * Uses in-memory cache to avoid redundant disk I/O within a run.
 * S3-backed: every write syncs to versioned S3 bucket (never lose data).
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { initStorage, backupToS3, loadJSONSafe } from './storage.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = `${__dir}/../data/jobs_queue.json`;
const LOG_PATH = `${__dir}/../data/applications_log.json`;
const UPDATES_PATH = `${__dir}/../data/queue_updates.jsonl`;

/**
 * Load and validate a JSON config file. Throws with a clear message on failure.
 */
export function loadConfig(filePath) {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nCopy the matching .example.json and fill in your values.`);
  }
  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read config file ${resolved}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${resolved}: ${e.message}`);
  }
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write — writes to a temp file then renames.
 * Prevents corruption if two processes write simultaneously or the process
 * crashes mid-write. rename() is atomic on POSIX filesystems.
 */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

// --- In-memory caches (populated on first read, invalidated on write) ---
let _queueCache = null;
let _logCache = null;

/**
 * Apply pending updates from the sidecar JSONL file.
 * Secondary processes (e.g. standalone classifier) write updates here
 * instead of modifying jobs_queue.json directly, avoiding write conflicts.
 *
 * Uses rename-then-read to avoid losing updates appended between read and delete.
 * Each line is JSON: { id, ...fields }
 */
function applyPendingUpdates(queue) {
  if (!existsSync(UPDATES_PATH)) return false;

  // Atomically claim the file by renaming it — new appends go to a fresh file
  const claimedPath = UPDATES_PATH + '.applying';
  try { renameSync(UPDATES_PATH, claimedPath); } catch { return false; }

  let lines;
  try {
    lines = readFileSync(claimedPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch { return false; }
  finally { try { unlinkSync(claimedPath); } catch {} }

  if (lines.length === 0) return false;

  const byId = new Map(queue.map((j, i) => [j.id, i]));
  let applied = 0;
  for (const line of lines) {
    try {
      const { id, ...fields } = JSON.parse(line);
      const idx = byId.get(id);
      if (idx == null) continue;
      queue[idx] = { ...queue[idx], ...fields, status_updated_at: new Date().toISOString() };
      applied++;
    } catch {}
  }

  return applied > 0;
}

export function loadQueue() {
  if (_queueCache) return _queueCache;
  ensureDir(QUEUE_PATH);

  let data = null;
  if (existsSync(QUEUE_PATH)) {
    try {
      const raw = readFileSync(QUEUE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error(`Expected array, got ${typeof parsed}`);
      data = parsed;
    } catch (err) {
      console.warn(`⚠️  Queue file corrupt: ${err.message} — will attempt S3 restore`);
    }
  }

  // S3 restore handled async at startup via initQueueFromS3() — for sync path, use empty array
  _queueCache = data || [];
  if (applyPendingUpdates(_queueCache)) {
    saveQueue(_queueCache);
  }
  return _queueCache;
}

/**
 * Async queue initialization with S3 fallback.
 * Call once at startup before processing jobs.
 */
export async function initQueueFromS3(settings) {
  initStorage(settings);

  // If local queue is missing or empty, try S3
  let needsRestore = false;
  if (!existsSync(QUEUE_PATH)) {
    needsRestore = true;
  } else {
    try {
      const raw = readFileSync(QUEUE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) needsRestore = true;
    } catch {
      needsRestore = true;
    }
  }

  if (needsRestore) {
    const restored = await loadJSONSafe(QUEUE_PATH, []);
    if (Array.isArray(restored) && restored.length > 0) {
      _queueCache = restored;
      console.log(`✅ Queue restored from S3: ${restored.length} jobs`);
    }
  }

  // Also ensure applications log is backed up
  if (existsSync(LOG_PATH)) {
    backupToS3(LOG_PATH);
  }
}

/**
 * Force a fresh read from disk + apply pending updates.
 * Call this between iterations in long-running processes to pick up
 * sidecar updates from secondary processes.
 */
export function reloadQueue() {
  _queueCache = null;
  return loadQueue();
}

export function saveQueue(jobs) {
  if (!Array.isArray(jobs)) {
    throw new Error(`saveQueue: expected array, got ${typeof jobs} — refusing to write corrupt data`);
  }
  ensureDir(QUEUE_PATH);
  atomicWriteJSON(QUEUE_PATH, jobs);
  _queueCache = jobs;
  backupToS3(QUEUE_PATH);
}

function loadLog() {
  if (_logCache) return _logCache;
  ensureDir(LOG_PATH);
  _logCache = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, 'utf8')) : [];
  return _logCache;
}

function saveLog(log) {
  if (!Array.isArray(log)) {
    throw new Error(`saveLog: expected array, got ${typeof log} — refusing to write corrupt data`);
  }
  ensureDir(LOG_PATH);
  atomicWriteJSON(LOG_PATH, log);
  _logCache = log;
  backupToS3(LOG_PATH);
}

export function appendLog(entry) {
  const log = loadLog();
  log.push({ ...entry, logged_at: new Date().toISOString() });
  saveLog(log);
}

/**
 * After AI filtering, deduplicate jobs that exist on multiple tracks.
 * For each group sharing the same original job URL, keep the highest-scoring copy.
 * Marks losers as status='duplicate'. Call this after collect completes.
 */
export function dedupeAfterFilter() {
  _queueCache = null;
  const queue = loadQueue();

  // Group by URL (canonical dedup key)
  const byUrl = {};
  for (const job of queue) {
    if (!job.url) continue;
    if (!byUrl[job.url]) byUrl[job.url] = [];
    byUrl[job.url].push(job);
  }

  let deduped = 0;
  for (const jobs of Object.values(byUrl)) {
    if (jobs.length < 2) continue;
    // Only dedup if ALL copies have been scored — skip groups with unscored members
    if (jobs.some(j => j.filter_score == null && j.status !== 'filtered')) continue;

    // Keep the one with highest filter_score; if tied, prefer 'new' over 'filtered'
    jobs.sort((a, b) => {
      const sa = a.filter_score ?? -1;
      const sb = b.filter_score ?? -1;
      if (sb !== sa) return sb - sa;
      if (a.status === 'new' && b.status !== 'new') return -1;
      return 1;
    });
    // Mark losers as duplicate
    for (const loser of jobs.slice(1)) {
      loser.status = 'duplicate';
      loser.status_updated_at = new Date().toISOString();
      deduped++;
    }
  }

  if (deduped > 0) saveQueue(queue);
  return deduped;
}

export function isAlreadyApplied(jobId) {
  const log = loadLog();
  return log.some(e => e.id === jobId && e.status === 'applied');
}

export function getJobsByStatus(status) {
  const queue = loadQueue();
  if (Array.isArray(status)) return queue.filter(j => status.includes(j.status));
  return queue.filter(j => j.status === status);
}

export function updateJobStatus(id, status, extra = {}) {
  const queue = loadQueue();
  const idx = queue.findIndex(j => j.id === id);
  if (idx === -1) return;
  queue[idx] = {
    ...queue[idx],
    ...extra,
    status,
    status_updated_at: new Date().toISOString(),
  };
  saveQueue(queue);
  return queue[idx];
}

/**
 * Write a pending update to the sidecar JSONL file.
 * Use this from secondary processes (standalone scripts) instead of
 * calling updateJobStatus/saveQueue directly. The primary process
 * (searcher/applier) will pick up these updates on next loadQueue().
 *
 * @param {string} id — job id
 * @param {object} fields — fields to merge (e.g. { status: 'new', apply_type: 'lever', apply_url: '...' })
 */
export function writePendingUpdate(id, fields) {
  ensureDir(UPDATES_PATH);
  appendFileSync(UPDATES_PATH, JSON.stringify({ id, ...fields }) + '\n');
}

export function addJobs(newJobs) {
  // Always read fresh from disk to avoid clobbering concurrent writes (e.g. filter scoring)
  _queueCache = null;
  const queue = loadQueue();

  // Dedup key: same job.id + same track = skip (duplicate search hit for same track)
  // Same job.id but different track = allow (will be deduped after AI filter, keeping best score)
  const existingKeys = new Set(queue.map(j => `${j.track || 'ae'}::${j.id}`));
  let added = 0;

  for (const job of newJobs) {
    const track = job.track || 'ae';
    const key = `${track}::${job.id}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // If this job.id already exists on a different track, give this copy a composite id
    // so filter batch custom_ids don't collide
    const idConflict = queue.some(j => j.id === job.id && (j.track || 'ae') !== track);
    const queueId = idConflict ? `${job.id}_${track}` : job.id;

    queue.push({
      ...job,
      id: queueId,
      original_id: job.id,
      status: 'new',
      found_at: new Date().toISOString(),
      status_updated_at: new Date().toISOString(),
      pending_question: null,
      applied_at: null,
      notes: null,
    });
    added++;
  }

  saveQueue(queue);
  return added;
}
