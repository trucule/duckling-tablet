// Every incoming webhook (ET Ducky now; Stripe, Google and Apple later) records its event id in webhook_event inside
// the same duckling_system transaction as its effect. A redelivery hits the primary key and is skipped, so a
// webhook handler can be as simple as "apply the change" without being wrong twice.
import type { Q } from './db.js';

export type WebhookSource = 'etducky' | 'stripe' | 'google' | 'apple';

// True when this is the first time the event is seen; false for a duplicate (the caller then does nothing).
export async function firstDelivery(q: Q, source: WebhookSource, eventId: string): Promise<boolean> {
  const n = await q.run('INSERT INTO webhook_event (source, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [source, eventId]);
  return n === 1;
}
