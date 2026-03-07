/**
 * storage.mjs — Pluggable data storage (local disk or S3)
 *
 * When type is "local": reads/writes go to local disk (default).
 * When type is "s3": S3 is the primary store. No local files for data.
 *   - Versioned bucket means every write is recoverable.
 *   - In-memory cache in queue.mjs handles read performance.
 *
 * Config in settings.json:
 *   storage: { type: "s3", bucket: "claw-apply-data", region: "us-west-2" }
 *   storage: { type: "local" }  (default)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename } from 'path';

let _s3Client = null;
let _config = { type: 'local' };

export function initStorage(settings) {
  _config = settings?.storage || { type: 'local' };
}

export function storageType() {
  return _config?.type || 'local';
}

function getS3Key(filePath) {
  return `data/${basename(filePath)}`;
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
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, body);
  const { renameSync } = await import('fs');
  renameSync(tmp, filePath);
}
