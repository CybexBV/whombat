import { readFileSync } from 'node:fs';
import { imapGuessSettings } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  type DiscoverDeps,
  discoverMail,
  ISPDB_URL,
  mailDomainOf,
  parseAutoconfig,
  settingsFromSrv,
} from './discover';

/** ISPDB answers recorded on 2026-10-19 (autoconfig.thunderbird.net/v1.1/<domain>). */
const recorded = (domain: string) =>
  readFileSync(new URL(`./fixtures/ispdb-${domain}.xml`, import.meta.url), 'utf8');

describe('autoconfig documents (CM-20)', () => {
  it('reads Gmail’s IMAP and SMTP servers', () => {
    expect(parseAutoconfig(recorded('gmail.com'), 'mara@gmail.com')).toEqual({
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
      username: null,
    });
  });

  it('takes implicit TLS before STARTTLS', () => {
    const s = parseAutoconfig(recorded('gmx.de'), 'bo@gmx.de');
    expect(s?.imap).toEqual({ host: 'imap.gmx.net', port: 993, security: 'tls' });
    expect(s?.smtp).toEqual({ host: 'mail.gmx.net', port: 465, security: 'tls' });
  });

  it('fills in the user name templates and leaves out plain-text servers', () => {
    const xml = `<clientConfig version="1.1"><emailProvider id="x">
      <!-- <incomingServer type="imap"><hostname>old.example.org</hostname></incomingServer> -->
      <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    expect(parseAutoconfig(xml, 'Jo.Smith@Example.org')).toEqual({
      imap: { host: 'imap.example.org', port: 143, security: 'starttls' },
      smtp: { host: 'smtp.example.org', port: 587, security: 'starttls' },
      username: 'Jo.Smith',
    });
  });

  it('signs in to both sides with the full address where one side wants it (iCloud, SG-18a)', () => {
    // Recorded on 2026-10-21: IMAP `%EMAILLOCALPART%`, SMTP `%EMAILADDRESS%`.
    expect(parseAutoconfig(recorded('icloud.com'), 'johnappleseed@icloud.com')).toEqual({
      imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
      username: null,
    });
    const both = (imap: string, smtp: string) =>
      parseAutoconfig(
        `<clientConfig><emailProvider id="x">
          <incomingServer type="imap"><hostname>imap.x.org</hostname><port>993</port><socketType>SSL</socketType><username>${imap}</username></incomingServer>
          <outgoingServer type="smtp"><hostname>smtp.x.org</hostname><port>465</port><socketType>SSL</socketType><username>${smtp}</username></outgoingServer>
        </emailProvider></clientConfig>`,
        'jo@x.org',
      )?.username;
    expect(both('%EMAILADDRESS%', '%EMAILLOCALPART%')).toBeNull();
    // Both sides agree on another name: kept.
    expect(both('%EMAILLOCALPART%', '%EMAILLOCALPART%')).toBe('jo');
  });

  it('answers null for a page that isn’t one, or without both sides', () => {
    expect(parseAutoconfig('<html><h1>404 Not Found</h1></html>', 'a@b.com')).toBeNull();
    expect(
      parseAutoconfig(
        '<clientConfig><incomingServer type="imap"><hostname>imap.b.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer></clientConfig>',
        'a@b.com',
      ),
    ).toBeNull();
  });
});

describe('SRV records (RFC 6186, 8314)', () => {
  it('prefers implicit TLS, and reads an empty target as not offered', () => {
    expect(
      settingsFromSrv({
        // Fastmail's answers, recorded on 2026-10-19.
        imaps: [{ name: 'imap.fastmail.com', port: 993, priority: 0, weight: 1 }],
        imap: [{ name: '', port: 0, priority: 0, weight: 0 }],
        submissions: [{ name: 'smtp.fastmail.com', port: 465, priority: 0, weight: 1 }],
        submission: [{ name: '', port: 0, priority: 0, weight: 0 }],
      }),
    ).toEqual({
      imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
      username: null,
    });
    expect(
      settingsFromSrv({
        imaps: [],
        imap: [{ name: 'mail.example.org.', port: 143, priority: 10, weight: 0 }],
        submissions: [],
        submission: [{ name: 'mail.example.org', port: 587, priority: 0, weight: 0 }],
      }),
    ).toEqual({
      imap: { host: 'mail.example.org', port: 143, security: 'starttls' },
      smtp: { host: 'mail.example.org', port: 587, security: 'starttls' },
      username: null,
    });
  });
});

/** Answers by URL and name; everything else is not found. */
function deps(answers: {
  pages?: Record<string, string>;
  mx?: Record<string, string[]>;
  srv?: Record<string, { name: string; port: number }[]>;
}): DiscoverDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async fetchText(url) {
      asked.push(url);
      return answers.pages?.[url] ?? null;
    },
    async mx(domain) {
      return (answers.mx?.[domain] ?? []).map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    async srv(name) {
      asked.push(name);
      const found = answers.srv?.[name];
      if (!found) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return found.map((r) => ({ ...r, priority: 0, weight: 1 }));
    },
  };
}

describe('discovery order (CM-20)', () => {
  it('uses the ISPDB first, sending only the domain', async () => {
    const d = deps({
      pages: { [`${ISPDB_URL}gmail.com`]: recorded('gmail.com') },
      mx: { 'gmail.com': ['gmail-smtp-in.l.google.com'] },
    });
    const found = await discoverMail('mara@gmail.com', d);
    expect(found.source).toBe('ispdb');
    expect(found.settings?.imap.host).toBe('imap.gmail.com');
    expect(found.mx).toEqual(['gmail-smtp-in.l.google.com']);
    expect(d.asked.some((u) => u.includes('mara'))).toBe(false);
  });

  it('then the domain’s own autoconfig', async () => {
    const own = `<clientConfig version="1.1"><emailProvider id="example.org">
      <incomingServer type="imap"><hostname>mail.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>mail.example.org</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    const found = await discoverMail(
      'jo@example.org',
      deps({ pages: { 'https://example.org/.well-known/autoconfig/mail/config-v1.1.xml': own } }),
    );
    expect(found).toMatchObject({ source: 'autoconfig', settings: { imap: { host: 'mail.example.org' } } });
  });

  it('then the ISPDB of the MX host’s domain: a domain at Fastmail', async () => {
    const found = await discoverMail(
      'jo@smith.example',
      deps({
        pages: { [`${ISPDB_URL}messagingengine.com`]: recorded('messagingengine.com') },
        mx: { 'smith.example': ['in1-smtp.messagingengine.com', 'in2-smtp.messagingengine.com'] },
      }),
    );
    expect(found.source).toBe('mx');
    expect(found.settings).toEqual({
      imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
      username: null,
    });
  });

  it('then SRV records, then a guess the person checks', async () => {
    const srv = await discoverMail(
      'jo@example.net',
      deps({
        srv: {
          '_imaps._tcp.example.net': [{ name: 'imap.example.net', port: 993 }],
          '_submission._tcp.example.net': [{ name: 'smtp.example.net', port: 587 }],
        },
      }),
    );
    expect(srv).toMatchObject({ source: 'srv', settings: { smtp: { port: 587, security: 'starttls' } } });
    const none = await discoverMail('jo@nothing.example', deps({}));
    expect(none).toEqual({ settings: imapGuessSettings('jo@nothing.example'), source: 'guess', mx: [] });
    expect(none.settings?.imap.host).toBe('imap.nothing.example');
  });

  it('finds nothing for an address without a usable domain', async () => {
    expect(await discoverMail('not-an-address', deps({}))).toEqual({ settings: null, source: null, mx: [] });
    expect(mailDomainOf('a@localhost')).toBeNull();
    expect(mailDomainOf('a@Bücher.example')).toBe('xn--bcher-kva.example');
  });
});
