import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Storage } from './storage.js';
import type { Mailer } from './mailer.js';
import type { Synth } from './azure.js';
import type { CreateTicket } from './etducky.js';
import { now } from './util.js';

export interface Ctx {
  cfg: Config;
  db: DB;
  storage: Storage;
  mailer: Mailer;
  synth: Synth;
  createTicket: CreateTicket;
  audit(familyId: string | null, actor: string, action: string, detail?: unknown): void;
}

export function makeAudit(db: DB): Ctx['audit'] {
  const ins = db.prepare('INSERT INTO audit (family_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)');
  return (familyId, actor, action, detail = {}) => { ins.run(familyId, actor, action, JSON.stringify(detail), now()); };
}
