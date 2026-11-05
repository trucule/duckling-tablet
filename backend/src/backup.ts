// Nightly backup: a consistent SQLite snapshot uploaded to Spaces under backups/, keeping the last 30 days.
// Run with: node dist/backup.js (the systemd timer in deploy/ does this at 03:15 every night).
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const snap = join(tmpdir(), `duckling-${Date.now()}.db`);
const db = new Database(cfg.DATABASE_PATH, { readonly: true });
await db.backup(snap);
db.close();
const body = gzipSync(readFileSync(snap));
rmSync(snap, { force: true });

const s3 = new S3Client({ endpoint: cfg.SPACES_ENDPOINT, region: cfg.SPACES_REGION, credentials: { accessKeyId: cfg.SPACES_KEY, secretAccessKey: cfg.SPACES_SECRET } });
const key = `backups/duckling-${new Date().toISOString().replace(/[:.]/g, '-')}.db.gz`;
await s3.send(new PutObjectCommand({ Bucket: cfg.SPACES_BUCKET, Key: key, Body: body, ACL: 'private', ContentType: 'application/gzip' }));

const cutoff = Date.now() - 30 * 86_400_000;
const list = await s3.send(new ListObjectsV2Command({ Bucket: cfg.SPACES_BUCKET, Prefix: 'backups/' }));
const old = (list.Contents ?? []).filter((o) => o.LastModified && o.LastModified.getTime() < cutoff).map((o) => ({ Key: o.Key! }));
if (old.length) await s3.send(new DeleteObjectsCommand({ Bucket: cfg.SPACES_BUCKET, Delete: { Objects: old } }));
console.log(`backup ${key} (${body.length} bytes), removed ${old.length} old`);
