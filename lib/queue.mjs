/**
 * queue.mjs — Job queue management
 * Handles jobs_queue.json read/write/update
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = `${__dir}/../data/jobs_queue.json`;
const LOG_PATH = `${__dir}/../data/applications_log.json`;

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadQueue() {
  ensureDir(QUEUE_PATH);
  return existsSync(QUEUE_PATH) ? JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) : [];
}

export function saveQueue(jobs) {
  ensureDir(QUEUE_PATH);
  writeFileSync(QUEUE_PATH, JSON.stringify(jobs, null, 2));
}

export function loadLog() {
  ensureDir(LOG_PATH);
  return existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, 'utf8')) : [];
}

export function appendLog(entry) {
  const log = loadLog();
  log.push({ ...entry, logged_at: new Date().toISOString() });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
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

export function makeJobId(platform, url) {
  const match = url.match(/\/(\d{8,})/);
  const id = match ? match[1] : Math.random().toString(36).slice(2, 10);
  return `${platform}_${id}`;
}
