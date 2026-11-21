import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import type { Logger } from '../services';
import { productionTestEnv } from '../test/env';
import { renderDigest } from './digest';
import { LOGO_CID } from './logo';
import { createMailer, inlineParts, type MailAttachment } from './mailer';
import { renderEmailHtml, sentBy } from './template';

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('renderEmailHtml', () => {
  it('lays out the label, title, button, code and footer, and escapes everything it is given', () => {
    const html = renderEmailHtml({
      label: 'Sign in',
      preheader: 'Your code is 482913.',
      title: 'Sign in to <Whombat>',
      blocks: [
        'Tom & Jerry’s "burrow"',
        { button: { href: 'https://acme.example/x?a=1&b="2"', label: 'Sign in' } },
        { code: '482913', caption: 'Or type this code' },
        { link: 'https://acme.example/x' },
      ],
      footer: ['Why you got this.'],
      sender: sentBy('https://acme.example:8443/'),
    });
    expect(html).toContain(`src="cid:${LOGO_CID}"`);
    expect(html).toContain('alt="Whombat"');
    expect(html).toContain('>Sign in</td>');
    expect(html).toContain('Sign in to &lt;Whombat&gt;');
    expect(html).toContain('Tom &amp; Jerry’s &quot;burrow&quot;');
    expect(html).toContain('href="https://acme.example/x?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('482913</td>');
    expect(html).toContain('Sent by the Whombat at acme.example:8443');
    expect(html).not.toContain('<Whombat>');
  });

  it('gives the notification email its items as links, quotes escaped', () => {
    const { html } = renderDigest({
      name: 'Priya',
      cadence: 'daily',
      openUrl: 'https://acme.example/hq',
      settingsUrl: 'https://acme.example/hq/settings?tab=notifications',
      items: [
        {
          kind: 'mention',
          actorName: 'Joris',
          where: '#billing',
          text: '<script>alert(1)</script>',
          url: 'https://acme.example/hq/c/billing',
          toYou: false,
        },
      ],
    });
    expect(html).toContain('Joris mentioned you in #billing');
    expect(html).toContain('href="https://acme.example/hq/c/billing"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Settings → Notifications');
  });
});

describe('the logo', () => {
  it('is attached inline exactly when the HTML shows it', async () => {
    const html = renderEmailHtml({ label: 'x', title: 'x', blocks: [] });
    expect(inlineParts({ to: 'a@b.test', subject: 's', text: 't' })).toEqual([]);
    const [part] = inlineParts({ to: 'a@b.test', subject: 's', text: 't', html });
    expect(part).toMatchObject({ cid: LOGO_CID, contentType: 'image/png' });
    expect(part?.content.subarray(1, 4).toString()).toBe('PNG');

    const sent: { attachments?: MailAttachment[] }[] = [];
    const mailer = createMailer(loadConfig(productionTestEnv()), () => quiet, {
      sendMail: async (m) => {
        sent.push(m);
      },
    });
    await mailer.send({ to: 'a@b.test', subject: 's', text: 't', html });
    await mailer.send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(sent.map((m) => m.attachments?.map((a) => a.cid))).toEqual([[LOGO_CID], undefined]);
  });
});
