// Read-only support report, run on the droplet: which family each parent, device and store purchase belongs to, and
// what the family is entitled to. Purchase ids are shortened; nothing secret is printed.
//
//     cd /opt/duckling/src/backend && DOTENV_CONFIG_PATH=/opt/duckling/.env node dist/family-report.js [email ...]
//
// With email addresses, only the families of those parents; without, every family with a device seen in 30 days.
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { entitlementOf } from './entitlement.js';

const cfg = loadConfig();
const db = new Db({ appUrl: cfg.DATABASE_URL_APP, systemUrl: cfg.DATABASE_URL_SYSTEM, caCert: cfg.DATABASE_CA_CERT || undefined, appPoolSize: 1, systemPoolSize: 1 });
const emails = process.argv.slice(2).map((e) => e.toLowerCase());
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 16)}…${s.slice(-6)}` : s);
const day = (d: string | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '-');
try {
  await db.system(async (q) => {
    const fams = emails.length
      ? await q.all<{ family_id: string }>('SELECT DISTINCT family_id FROM parent WHERE lower(email) = ANY($1)', [emails])
      : await q.all<{ family_id: string }>(`SELECT DISTINCT family_id FROM device WHERE last_seen_at > now() - interval '30 days'`);
    if (!fams.length) console.log('No matching family.');
    for (const { family_id: id } of fams) {
      const parents = await q.all<{ email: string }>('SELECT email FROM parent WHERE family_id = $1 ORDER BY created_at', [id]);
      const fam = await q.one<{ created_at: string; stripe_customer_id: string | null; app_account_token: string }>('SELECT created_at, stripe_customer_id, app_account_token::text AS app_account_token FROM family WHERE id = $1', [id]);
      const ent = await entitlementOf(q, id);
      console.log(`\nFamily ${id} (created ${day(fam?.created_at ?? null)}) parents: ${parents.map((p) => p.email).join(', ') || '-'}`);
      console.log(`  entitlement: ${ent.status}${ent.source ? ` via ${ent.source}` : ''}, until ${day(ent.periodEnd)}${fam?.stripe_customer_id ? `, Stripe customer ${fam.stripe_customer_id}` : ''}, account token ${fam?.app_account_token.slice(0, 8)}…`);
      for (const p of await q.all<{ source: string; external_id: string; product_id: string; status: string; period_end: string | null; updated_at: string; raw: Record<string, unknown> }>('SELECT source, external_id, product_id, status, period_end, updated_at, raw FROM purchase WHERE family_id = $1 ORDER BY updated_at DESC', [id])) {
        const state = (p.raw.subscriptionState ?? p.raw.status ?? '') as string;
        console.log(`  purchase ${p.source} ${short(p.external_id)} ${p.product_id}: ${p.status} until ${day(p.period_end)} (${state || 'no state'}${p.raw.test ? ', test purchase' : ''}), updated ${day(p.updated_at)}`);
      }
      for (const d of await q.all<{ id: string; platform: string; name: string; state: string; shell_version: string | null; last_seen_at: string | null }>('SELECT id, platform, name, state, shell_version, last_seen_at FROM device WHERE family_id = $1 ORDER BY last_seen_at DESC NULLS LAST', [id]))
        console.log(`  device ${d.id} ${d.platform} "${d.name}" ${d.state}, shell ${d.shell_version ?? '-'}, last seen ${day(d.last_seen_at)}`);
    }
    // Store purchases from the last day, whichever family holds them: a purchase under an unexpected family shows here.
    const recent = await q.all<{ family_id: string; source: string; external_id: string; status: string; updated_at: string }>(`SELECT family_id, source, external_id, status, updated_at FROM purchase WHERE updated_at > now() - interval '1 day' ORDER BY updated_at DESC`);
    console.log(`\nPurchases updated in the last day: ${recent.length ? '' : 'none'}`);
    for (const r of recent) console.log(`  ${day(r.updated_at)} ${r.source} ${short(r.external_id)} ${r.status} -> family ${r.family_id}`);
  });
} finally { await db.close(); }
