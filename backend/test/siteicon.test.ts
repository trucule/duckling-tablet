import { describe, expect, it } from 'vitest';
import { iconLinks, isPublicAddress, httpsGet } from '../src/routes/siteicon.js';

describe('site icons', () => {
  it('ranks touch icons first, then larger icons', () => {
    const html = `<link rel="shortcut icon" href="/favicon.ico"><link rel="icon" sizes="32x32" href="//cdn.example.org/i32.png">
      <link href='/t.png' rel='apple-touch-icon'><link rel="icon" href="http://insecure.example.org/x.png" sizes="512x512"><link rel="stylesheet" href="/s.css">`;
    expect(iconLinks(html, 'https://example.org/a/')).toEqual(['https://example.org/t.png', 'https://cdn.example.org/i32.png', 'https://example.org/favicon.ico']);
  });

  it('only public addresses count', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'localhost'])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['8.8.8.8', '104.16.1.1', '2606:4700::1111']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses plain http, IP addresses and names that resolve inside the network', async () => {
    await expect(httpsGet('http://example.org/', 1000)).rejects.toThrow(/https/);
    await expect(httpsGet('https://127.0.0.1/', 1000)).rejects.toThrow(/host name/);
    await expect(httpsGet('https://localhost.localdomain.test/', 1000)).rejects.toThrow();
  });
});
