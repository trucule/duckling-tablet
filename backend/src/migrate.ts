// Applies pending migrations as duckling_system. deploy.ps1 runs this before restarting the service:
//   node dist/migrate.js
import { loadConfig } from './config.js';
import { Db, migrate } from './db.js';

const cfg = loadConfig();
const db = new Db({ appUrl: cfg.DATABASE_URL_APP, systemUrl: cfg.DATABASE_URL_SYSTEM, caCert: cfg.DATABASE_CA_CERT || undefined, appPoolSize: 1, systemPoolSize: 1 });
try {
  const applied = await migrate(db.systemPool, (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');
} finally {
  await db.close();
}
