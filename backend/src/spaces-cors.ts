// Sets the CORS rules on the Spaces bucket so pages on other origins (the packages inside the shells, the web app)
// can fetch public files through the CDN: narrator clips are fetched as bytes for decoding and caching, and /tts
// redirects there. Every file in the bucket is public already, so GET and HEAD from any origin is the whole rule.
// One-time, idempotent:  DOTENV_CONFIG_PATH=/opt/duckling/.env node dist/spaces-cors.js
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const s3 = new S3Client({ endpoint: cfg.SPACES_ENDPOINT, region: cfg.SPACES_REGION, forcePathStyle: false, credentials: { accessKeyId: cfg.SPACES_KEY, secretAccessKey: cfg.SPACES_SECRET } });
await s3.send(new PutBucketCorsCommand({
  Bucket: cfg.SPACES_BUCKET,
  CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 86400 }] },
}));
const now = await s3.send(new GetBucketCorsCommand({ Bucket: cfg.SPACES_BUCKET }));
console.log(`CORS on ${cfg.SPACES_BUCKET}:`, JSON.stringify(now.CORSRules));
