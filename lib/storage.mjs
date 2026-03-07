/**
 * storage.mjs — S3-backed data storage
 *
 * Local files remain the primary read/write path (fast).
 * Every write syncs to S3 asynchronously (versioned bucket — never lose data).
 * On load, if local file is missing or corrupt, auto-restores from S3.
 *
 * Config in settings.json:
 *   storage: { type: "s3", bucket: "claw-apply-data", region: "us-west-2" }
 *   or
 *   storage: { type: "local" }  (default, no backup)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename } from 'path';

let _s3Client = null;
let _config = null;

/**
 * Initialize storage with settings. Call once at startup.
 */
export function initStorage(settings) {
  _config = settings?.storage || { type: 'local' };
}

function getS3Key(filePath) {
  return `data/${basename(filePath)}`;
}

async function getS3Client() {
  if (_s3Client) return _s3Client;
  if (!_config || _config.type !== 's3') return null;

  try {
    const { S3Client: Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
    _s3Client = {
      client: new Client({ region: _config.region || 'us-west-2' }),
      PutObjectCommand,
      GetObjectCommand,
    };
    return _s3Client;
  } catch {
    console.warn('⚠️  @aws-sdk/client-s3 not installed — S3 backup disabled');
    return null;
  }
}

/**
 * Upload a local file to S3 (async, non-blocking).
 * Versioned bucket keeps every revision.
 */
export function backupToS3(filePath) {
  if (!_config || _config.type !== 's3') return;

  // Fire and forget — don't block the caller
  _doBackup(filePath).catch(err => {
    console.warn(`⚠️  S3 backup failed for ${basename(filePath)}: ${err.message}`);
  });
}

async function _doBackup(filePath) {
  const s3 = await getS3Client();
  if (!s3) return;

  const body = readFileSync(filePath, 'utf8');

  // Safety: don't upload obviously corrupt data
  if (body.length < 3) {
    console.warn(`⚠️  Refusing to backup ${basename(filePath)} — file too small (${body.length} bytes)`);
    return;
  }

  await s3.client.send(new s3.PutObjectCommand({
    Bucket: _config.bucket,
    Key: getS3Key(filePath),
    Body: body,
    ContentType: 'application/json',
  }));
}

/**
 * Restore a file from S3 to local disk.
 * Returns true if restored, false if no S3 copy exists.
 */
export async function restoreFromS3(filePath) {
  if (!_config || _config.type !== 's3') return false;

  const s3 = await getS3Client();
  if (!s3) return false;

  try {
    const response = await s3.client.send(new s3.GetObjectCommand({
      Bucket: _config.bucket,
      Key: getS3Key(filePath),
    }));
    const body = await response.Body.transformToString();

    // Validate it's real JSON before writing
    JSON.parse(body);
    writeFileSync(filePath, body);
    console.log(`✅ Restored ${basename(filePath)} from S3 (${body.length} bytes)`);
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey') return false;
    console.warn(`⚠️  S3 restore failed for ${basename(filePath)}: ${err.message}`);
    return false;
  }
}

/**
 * Safe JSON file loader with S3 fallback.
 * If local file is missing or corrupt, tries S3 restore.
 */
export async function loadJSONSafe(filePath, defaultValue = []) {
  // Try local first
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Validate it's the expected type (array for queue/log)
      if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
        throw new Error(`Expected array, got ${typeof parsed}`);
      }
      return parsed;
    } catch (err) {
      console.warn(`⚠️  Local ${basename(filePath)} is corrupt: ${err.message}`);
      console.warn(`    Attempting S3 restore...`);
    }
  }

  // Local missing or corrupt — try S3
  const restored = await restoreFromS3(filePath);
  if (restored) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  return defaultValue;
}

/**
 * Safe JSON file writer with validation + S3 backup.
 * Validates data type before writing to prevent corruption.
 */
export function saveJSONSafe(filePath, data) {
  // Validate: never write non-object/non-array data to queue/log files
  if (typeof data === 'string') {
    throw new Error(`Refusing to save string to ${basename(filePath)} — data corruption prevented`);
  }
  if (data === null || data === undefined) {
    throw new Error(`Refusing to save ${data} to ${basename(filePath)} — data corruption prevented`);
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  backupToS3(filePath);
}
