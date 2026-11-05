import type { Config } from './config.js';
import type { Db, Q } from './db.js';
import type { Storage } from './storage.js';
import type { Mailer } from './mailer.js';
import type { Synth } from './azure.js';
import type { CreateTicket } from './etducky.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  storage: Storage;
  mailer: Mailer;
  synth: Synth;
  createTicket: CreateTicket;
}

// Writes an audit line inside the caller's transaction. A family transaction can only write its own family's lines;
// a null family (system events) needs a db.system() transaction.
export async function audit(q: Q, familyId: string | null, actor: string, action: string, detail: unknown = {}): Promise<void> {
  await q.run('INSERT INTO audit (family_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)', [familyId, actor, action, JSON.stringify(detail)]);
}
