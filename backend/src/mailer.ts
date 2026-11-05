// Sends parent sign-in links. Without SMTP settings the message is logged instead (development).
import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer { send(to: string, subject: string, text: string): Promise<void>; }

export function makeMailer(cfg: Config, log: (msg: string) => void): Mailer {
  if (!cfg.SMTP_HOST) return { async send(to, subject, text) { log(`[mail to ${to}] ${subject}\n${text}`); } };
  const t = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });
  return { async send(to, subject, text) { await t.sendMail({ from: cfg.MAIL_FROM, to, subject, text }); } };
}
