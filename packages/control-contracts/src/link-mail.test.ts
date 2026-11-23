/**
 * Email through Whombat Link (4.15): what a box may hand control in `mail.send`, and which members each kind needs.
 */
import { describe, expect, it } from 'vitest';
import { LinkMail, linkMailComplete } from './device/link.js';
import { DEVICE_OPS } from './device/ops.js';

const ref = 'r3fXk2pQ9vLm0aZt';

describe('mail.send', () => {
  it('takes a count or a notice, and never a recipient', () => {
    const body = DEVICE_OPS['mail.send'].body;
    expect(body.safeParse({ kind: 'waiting', ref, count: 2, cadence: 'daily' }).success).toBe(true);
    expect(
      body.safeParse({ kind: 'notice', ref, title: 'Recovery kit saved', body: 'Keep it safe.' }).success,
    ).toBe(true);
    expect(
      body.safeParse({ kind: 'waiting', ref, count: 2, cadence: 'daily', to: 'a@example.com' }).success,
    ).toBe(false);
  });

  it('knows which members each kind needs', () => {
    const mail = (v: unknown) => LinkMail.parse(v);
    expect(linkMailComplete(mail({ kind: 'waiting', ref, count: 2, cadence: 'hourly', path: '/home' }))).toBe(
      true,
    );
    expect(linkMailComplete(mail({ kind: 'waiting', ref, count: 2 }))).toBe(false);
    expect(linkMailComplete(mail({ kind: 'waiting', ref, count: 2, cadence: 'daily', title: 'Hi' }))).toBe(
      false,
    );
    expect(
      linkMailComplete(mail({ kind: 'notice', ref, title: 'Hi', body: 'There', path: '/settings' })),
    ).toBe(true);
    expect(linkMailComplete(mail({ kind: 'notice', ref, title: 'Hi' }))).toBe(false);
    expect(linkMailComplete(mail({ kind: 'notice', ref, title: 'Hi', body: 'There', count: 1 }))).toBe(false);
  });
});
