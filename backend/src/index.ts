import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const cfg = loadConfig();
const { app } = await buildServer(cfg);
await app.listen({ host: cfg.HOST, port: cfg.PORT });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().then(() => process.exit(0)); });
