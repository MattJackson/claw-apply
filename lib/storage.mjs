/**
 * storage.mjs — Pluggable data storage (local disk or S3)
 *
 * When type is "local": reads/writes go to local disk (default).
 * When type is "s3": S3 is the primary store.
 *   - Versioned bucket means every write is recoverable.
 *   - In-memory cache in queue.mjs handles read performance.
 *
 * Config in settings.json:
 *   storage: { type: "s3", bucket: "claw-apply-data", region: "us-west-2" }
 *   storage: { type: "local" }  (default)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { basename, dirname } from 'path';
import { tmpdir } from 'os';
import { join } from 'path';

let _s3Client = null;
let _config = { type: 'local' };

export function initStorage(settings) {
  _config = settings?.storage || { type: 'local' };
}

export function storageType() {
  return _config?.type || 'local';
}

function getS3Key(filePath) {
  // Extract relative path from project root (e.g. config/foo.json or data/bar.json)
  const projectRoot = dirname(dirname(import.meta.url.replace('file://', '')));
  const abs = filePath.startsWith('/') ? filePath : join(projectRoot, filePath);
  if (abs.startsWith(projectRoot)) {
    const rel = abs.slice(projectRoot.length + 1);
    return rel;
  }
  // Fallback: use last two path segments (e.g. data/jobs_queue.json)
  const parts = filePath.split('/');
  return parts.slice(-2).join('/');
}

async function getS3Client() {
  if (_s3Client) return _s3Client;
  const { S3Client: Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  _s3Client = {
    client: new Client({ region: _config.region || 'us-west-2' }),
    PutObjectCommand,
    GetObjectCommand,
  };
  return _s3Client;
}

/**
 * Load JSON data. Source depends on storage type.
 */
export async function loadJSON(filePath, defaultValue = []) {
  if (_config.type === 's3') {
    try {
      const s3 = await getS3Client();
      const response = await s3.client.send(new s3.GetObjectCommand({
        Bucket: _config.bucket,
        Key: getS3Key(filePath),
      }));
      const body = await response.Body.transformToString();
      const parsed = JSON.parse(body);
      if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
        throw new Error(`Expected array, got ${typeof parsed}`);
      }
      return parsed;
    } catch (err) {
      if (err.name === 'NoSuchKey') return defaultValue;
      if (err.$metadata?.httpStatusCode === 404) return defaultValue;
      console.warn(`⚠️  S3 load failed for ${basename(filePath)}: ${err.message}`);
      return defaultValue;
    }
  }

  // Local storage
  if (!existsSync(filePath)) return defaultValue;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
      throw new Error(`Expected array, got ${typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`⚠️  Local ${basename(filePath)} is corrupt: ${err.message}`);
    return defaultValue;
  }
}

/**
 * Save JSON data. Destination depends on storage type.
 * Validates data before writing to prevent corruption.
 */
export async function saveJSON(filePath, data) {
  if (typeof data === 'string' || data === null || data === undefined) {
    throw new Error(`Refusing to save ${typeof data} to ${basename(filePath)} — data corruption prevented`);
  }

  const body = JSON.stringify(data, null, 2);

  if (_config.type === 's3') {
    const s3 = await getS3Client();
    await s3.client.send(new s3.PutObjectCommand({
      Bucket: _config.bucket,
      Key: getS3Key(filePath),
      Body: body,
      ContentType: 'application/json',
    }));
    return;
  }

  // Local storage — atomic write
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, body);
  const { renameSync } = await import('fs');
  renameSync(tmp, filePath);
}

/**
 * Load a binary file (e.g. resume PDF) from storage.
 * For S3: downloads to a temp file and returns the local path.
 * For local: returns the path as-is (must already exist).
 *
 * @param {string} s3Key — S3 key (e.g. "config/Matthew_Jackson_Resume.pdf")
 * @param {string} localPath — local file path (used as-is for local storage)
 * @returns {string} — local file path (may be temp file for S3)
 */
export async function ensureLocalFile(s3Key, localPath) {
  if (_config.type !== 's3') {
    return localPath;
  }

  // If the file already exists locally (cached from previous download), use it
  const tempPath = join(tmpdir(), basename(s3Key));
  if (existsSync(tempPath)) return tempPath;

  try {
    const s3 = await getS3Client();
    const response = await s3.client.send(new s3.GetObjectCommand({
      Bucket: _config.bucket,
      Key: s3Key,
    }));
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    writeFileSync(tempPath, Buffer.concat(chunks));
    console.log(`📄 Downloaded ${basename(s3Key)} from S3 (${chunks.reduce((s, c) => s + c.length, 0)} bytes)`);
    return tempPath;
  } catch (err) {
    console.warn(`⚠️  Failed to download ${s3Key} from S3: ${err.message}`);
    // Fall back to local path if it exists
    if (existsSync(localPath)) return localPath;
    throw new Error(`File not found: ${s3Key} (S3) or ${localPath} (local)`);
  }
}
