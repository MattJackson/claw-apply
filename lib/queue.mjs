/**
 * queue.mjs — Job queue management
 * Handles jobs_queue.json read/write/update
 *
 * Storage is pluggable via settings.storage:
 *   { type: "local" }  — reads/writes to local disk (default)
 *   { type: "s3", bucket: "...", region: "..." } — S3 is primary store
 *
 * In-memory cache avoids redundant I/O within a run.
 * Call initStorage() once at startup before any queue operations.
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { initStorage as _initStorage, loadJSON, saveJSON, storageType } from './storage.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = `${__dir}/../data/jobs_queue.json`;
const LOG_PATH = `${__dir}/../data/applications_log.json`;
const UPDATES_PATH = `${__dir}/../data/queue_updates.jsonl`;

/**
 * Load and validate a JSON config file.
 * Uses the storage layer (S3 or disk) when initialized.
 * Falls back to direct disk read for bootstrap (settings.json loaded before initQueue).
 */
export async function loadConfig(filePath) {
  const resolved = resolve(filePath);

  // If storage is initialized, use the storage layer
  if (_initialized) {
    const data = await loadJSON(resolved, null);
    if (data === null) {
      throw new Error(`Config file not found: ${resolved}\nCopy the matching .example.json and fill in your values.`);
    }
    return data;
  }

  // Bootstrap fallback (settings.json loaded before initQueue)
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

// --- In-memory caches (populated on first read, invalidated on write) ---
let _queueCache = null;
let _logCache = null;
let _initialized = false;

/**
 * Initialize storage. Must be called (and awaited) once at startup
 * before any queue operations.
 */
export async function initQueue(settings) {
  _initStorage(settings);

  // Load queue and log from primary storage (S3 or local)
  _queueCache = await loadJSON(QUEUE_PATH, []);
  _logCache = await loadJSON(LOG_PATH, []);

  // Apply any pending sidecar updates (local-only mechanism)
  if (applyPendingUpdates(_queueCache)) {
    await saveQueue(_queueCache);
  }

  _initialized = true;
  const type = storageType();
  console.log(`📦 Storage: ${type}${type === 's3' ? ` (${settings.storage.bucket})` : ''} — ${_queueCache.length} jobs loaded`);
}

/**
 * Apply pending updates from the sidecar JSONL file.
 * Secondary processes (e.g. standalone classifier) write updates here
 * instead of modifying jobs_queue.json directly, avoiding write conflicts.
 */
function applyPendingUpdates(queue) {
  if (!existsSync(UPDATES_PATH)) return false;

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

/**
 * Get the in-memory queue. Must call initQueue() first.
 */
export function loadQueue() {
  if (!_initialized) {
    // Fallback for code that hasn't been updated to call initQueue yet
    ensureDir(QUEUE_PATH);
    if (!_queueCache) {
      _queueCache = existsSync(QUEUE_PATH) ? JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) : [];
      if (!Array.isArray(_queueCache)) _queueCache = [];
    }
  }
  return _queueCache;
}

/**
 * Force a fresh read from storage + apply pending updates.
 * Call this between iterations in long-running processes.
 */
export async function reloadQueue() {
  _queueCache = await loadJSON(QUEUE_PATH, []);
  if (applyPendingUpdates(_queueCache)) {
    await saveQueue(_queueCache);
  }
  return _queueCache;
}

/**
 * Save the queue to primary storage.
 */
export async function saveQueue(jobs) {
  if (!Array.isArray(jobs)) {
    throw new Error(`saveQueue: expected array, got ${typeof jobs} — refusing to write corrupt data`);
  }
  await saveJSON(QUEUE_PATH, jobs);
  _queueCache = jobs;
}

async function loadLog() {
  if (_logCache) return _logCache;
  _logCache = await loadJSON(LOG_PATH, []);
  return _logCache;
}

async function saveLog(log) {
  if (!Array.isArray(log)) {
    throw new Error(`saveLog: expected array, got ${typeof log} — refusing to write corrupt data`);
  }
  await saveJSON(LOG_PATH, log);
  _logCache = log;
}

export async function appendLog(entry) {
  const log = await loadLog();
  log.push({ ...entry, logged_at: new Date().toISOString() });
  await saveLog(log);
}

/**
 * After AI filtering, deduplicate jobs that exist on multiple tracks.
 */
export async function dedupeAfterFilter() {
  _queueCache = null;
  const queue = await loadJSON(QUEUE_PATH, []);
  _queueCache = queue;

  const byUrl = {};
  for (const job of queue) {
    if (!job.url) continue;
    if (!byUrl[job.url]) byUrl[job.url] = [];
    byUrl[job.url].push(job);
  }

  let deduped = 0;
  for (const jobs of Object.values(byUrl)) {
    if (jobs.length < 2) continue;
    if (jobs.some(j => j.filter_score == null && j.status !== 'filtered')) continue;

    jobs.sort((a, b) => {
      const sa = a.filter_score ?? -1;
      const sb = b.filter_score ?? -1;
      if (sb !== sa) return sb - sa;
      if (a.status === 'new' && b.status !== 'new') return -1;
      return 1;
    });
    for (const loser of jobs.slice(1)) {
      loser.status = 'duplicate';
      loser.status_updated_at = new Date().toISOString();
      deduped++;
    }
  }

  if (deduped > 0) await saveQueue(queue);
  return deduped;
}

export async function isAlreadyApplied(jobId) {
  const log = await loadLog();
  return log.some(e => e.id === jobId && e.status === 'applied');
}

export function getJobsByStatus(status) {
  const queue = loadQueue();
  if (Array.isArray(status)) return queue.filter(j => status.includes(j.status));
  return queue.filter(j => j.status === status);
}

export async function updateJobStatus(id, status, extra = {}) {
  const queue = loadQueue();
  const idx = queue.findIndex(j => j.id === id);
  if (idx === -1) return;
  queue[idx] = {
    ...queue[idx],
    ...extra,
    status,
    status_updated_at: new Date().toISOString(),
  };
  await saveQueue(queue);
  return queue[idx];
}

/**
 * Write a pending update to the sidecar JSONL file.
 * Use this from secondary processes instead of calling updateJobStatus directly.
 */
export function writePendingUpdate(id, fields) {
  ensureDir(UPDATES_PATH);
  appendFileSync(UPDATES_PATH, JSON.stringify({ id, ...fields }) + '\n');
}

export async function addJobs(newJobs) {
  // Reload fresh to avoid clobbering concurrent writes
  _queueCache = await loadJSON(QUEUE_PATH, []);
  const queue = _queueCache;

  const existingKeys = new Set(queue.map(j => `${j.track || 'ae'}::${j.id}`));
  let added = 0;

  for (const job of newJobs) {
    const track = job.track || 'ae';
    const key = `${track}::${job.id}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

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

  await saveQueue(queue);
  return added;
}
