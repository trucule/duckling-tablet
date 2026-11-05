// File storage for app packages, voice clips and request attachments.
// 's3' is DigitalOcean Spaces (S3-compatible) served through its CDN; 'local' is a folder for development and tests.
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Config } from './config.js';

export interface Storage {
  put(key: string, body: Buffer, contentType: string, isPublic?: boolean): Promise<void>;
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

function safeKey(key: string): string {
  const k = normalize(key).replace(/\\/g, '/');
  if (k.startsWith('..') || k.startsWith('/')) throw new Error(`Bad storage key: ${key}`);
  return k;
}

export class LocalStorage implements Storage {
  constructor(private dir: string, private baseUrl: string) {}
  private path(key: string) { return join(this.dir, safeKey(key)); }
  async put(key: string, body: Buffer) { const p = this.path(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); }
  async exists(key: string) { return existsSync(this.path(key)); }
  async get(key: string) { const p = this.path(key); return existsSync(p) ? readFileSync(p) : null; }
  async delete(key: string) { rmSync(this.path(key), { force: true }); }
  publicUrl(key: string) { return `${this.baseUrl}/files/${safeKey(key)}`; }
}

export class SpacesStorage implements Storage {
  private s3: S3Client;
  constructor(private cfg: Config) {
    this.s3 = new S3Client({
      endpoint: cfg.SPACES_ENDPOINT, region: cfg.SPACES_REGION, forcePathStyle: false,
      credentials: { accessKeyId: cfg.SPACES_KEY, secretAccessKey: cfg.SPACES_SECRET },
    });
  }
  async put(key: string, body: Buffer, contentType: string, isPublic = true) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.cfg.SPACES_BUCKET, Key: safeKey(key), Body: body, ContentType: contentType,
      ACL: isPublic ? 'public-read' : 'private', CacheControl: isPublic ? 'public, max-age=31536000, immutable' : 'private',
    }));
  }
  async exists(key: string) {
    try { await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.SPACES_BUCKET, Key: safeKey(key) })); return true; }
    catch { return false; }
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.SPACES_BUCKET, Key: safeKey(key) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch { return null; }
  }
  async delete(key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.SPACES_BUCKET, Key: safeKey(key) })); }
  publicUrl(key: string) { return `${this.cfg.CDN_URL.replace(/\/$/, '')}/${safeKey(key)}`; }
}

export function makeStorage(cfg: Config): Storage {
  return cfg.STORAGE === 's3' ? new SpacesStorage(cfg) : new LocalStorage(cfg.LOCAL_STORAGE_DIR, cfg.PUBLIC_URL);
}
