// Sends parent sign-in links. Without SMTP settings the message is logged instead; loadConfig refuses that in
// production, so a sign-in link never reaches the journal there.
import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer { send(to: string, subject: string, text: string): Promise<void>; }

export function makeMailer(cfg: Config, log: (msg: string) => void): Mailer {
  if (!cfg.SMTP_HOST) return { async send(to, subject, text) { log(`[mail to ${to}] ${subject}\n${text}`); } };
  // Short timeouts: a blocked port (DigitalOcean blocks outbound 25, 465 and 587; 2525 is open) must fail the request
  // in seconds, not hang it.
  const t = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465, requireTLS: cfg.SMTP_PORT !== 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
  });
  return { async send(to, subject, text) { await t.sendMail({ from: cfg.MAIL_FROM, to, subject, text }); } };
}
