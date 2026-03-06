/**
 * queue.mjs — Job queue management
 * Handles jobs_queue.json read/write/update
 * Uses in-memory cache to avoid redundant disk I/O within a run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = `${__dir}/../data/jobs_queue.json`;
const LOG_PATH = `${__dir}/../data/applications_log.json`;

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

// --- In-memory caches (populated on first read, invalidated on write) ---
let _queueCache = null;
let _logCache = null;

export function loadQueue() {
  if (_queueCache) return _queueCache;
  ensureDir(QUEUE_PATH);
  _queueCache = existsSync(QUEUE_PATH) ? JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) : [];
  return _queueCache;
}

export function saveQueue(jobs) {
  ensureDir(QUEUE_PATH);
  writeFileSync(QUEUE_PATH, JSON.stringify(jobs, null, 2));
  _queueCache = jobs;
}

function loadLog() {
  if (_logCache) return _logCache;
  ensureDir(LOG_PATH);
  _logCache = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, 'utf8')) : [];
  return _logCache;
}

function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  _logCache = log;
}

export function appendLog(entry) {
  const log = loadLog();
  log.push({ ...entry, logged_at: new Date().toISOString() });
  saveLog(log);
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

export function addJobs(newJobs) {
  const queue = loadQueue();
  const existingIds = new Set(queue.map(j => j.id));
  const existingUrls = new Set(queue.map(j => j.url));
  let added = 0;

  for (const job of newJobs) {
    if (existingIds.has(job.id) || existingUrls.has(job.url)) continue;
    queue.push({
      ...job,
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
