/**
 * Email through Whombat Link with an older control: one that refuses the language (`locale`) still gets the choices and
 * the emails without it, isn't told it took the language, and gets it once it does.
 */
import { describe, expect, it } from 'vitest';
import { notifyLocaleChanged } from '../../i18n/locale';
import type { Services } from '../../services';
import { ManagerCallError, type ManagerPort } from '../ports';
import { LinkEmail, LOCALE_RETRY_MS, refusesLocale } from './mail';
import type { LinkService } from './service';

type Sent = Record<string, unknown>;

/** A box whose owner reads Dutch, with control behind a manager that refuses `locale` until `accepts` is set. */
function box(notifications = false) {
  let now = new Date('2026-11-27T10:00:00Z').getTime();
  // The stored choices, as `load` reads them.
  const row = { offline: true, notifications };
  const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) };
  const services = {
    db,
    config: { WHOMBAT_MASTER_KEY: 'test-master-key' },
    clock: () => new Date(now),
    log: { info: () => {}, warn: () => {} },
    boxMail: { availableNow: () => false },
    maintenance: { quarantined: false },
  } as unknown as Services;
  notifyLocaleChanged(services, 'acc_1', 'nl-NL');
  const control = { accepts: false, choices: [] as Sent[], mails: [] as Sent[] };
  const refuse = (path: string) =>
    new ManagerCallError(path, 502, 'control_refused', 'control: HTTP 400 unknown field "locale"');
  const manager = {
    async linkMailSet(input: Sent) {
      if ('locale' in input && !control.accepts) throw refuse('/link/mail');
      control.choices.push(input);
    },
    async mailSend(input: Sent) {
      if ('locale' in input && !control.accepts) throw refuse('/mail/send');
      control.mails.push(input);
    },
  } as unknown as ManagerPort;
  const link = { known: () => true, state: 'on', view: () => ({ enabled: true }) } as unknown as LinkService;
  const email = new LinkEmail(services, manager, link, async () => 'acc_1');
  return { email, control, later: (ms: number) => (now += ms) };
}

describe('email choices with an older control', () => {
  it('reads a refusal of the language as one, and nothing else', () => {
    expect(refusesLocale(new ManagerCallError('/x', 400, 'bad_request', ''))).toBe(true);
    expect(refusesLocale(new ManagerCallError('/x', 502, 'control_refused', ''))).toBe(true);
    expect(refusesLocale(new ManagerCallError('/x', 503, 'unavailable', ''))).toBe(false);
    expect(refusesLocale(new Error('x'))).toBe(false);
  });

  it('tells the choices without the language, not again each sweep, and with it once control takes it', async () => {
    const { email, control, later } = box();
    await email.tell();
    expect(control.choices).toEqual([{ offline: true, notifications: false }]);
    // The five-minute sweep: told already, and the language isn't asked for again yet.
    later(5 * 60_000);
    await email.tell();
    expect(control.choices).toHaveLength(1);
    // Control learns the language; after the wait the box asks with it once and it is taken.
    control.accepts = true;
    later(LOCALE_RETRY_MS);
    await email.tell();
    expect(control.choices.at(-1)).toEqual({ offline: true, notifications: false, locale: 'nl-NL' });
    later(5 * 60_000);
    await email.tell();
    expect(control.choices).toHaveLength(2);
  });

  it('asks with the language again at once when the owner changes it', async () => {
    const { email, control } = box();
    await email.tell();
    control.accepts = true;
    email.localeChanged();
    await email.tell();
    expect(control.choices.at(-1)).toMatchObject({ locale: 'nl-NL' });
  });

  it('sends a notice without the language when control refuses it, then with it once control takes it', async () => {
    const { email, control, later } = box(true);
    await email.load();
    const notice = { title: 'Iemand logde in', body: 'Een nieuw apparaat', path: '/settings' };
    expect(await email.notice('signin', notice)).toBe(true);
    expect(control.mails).toHaveLength(1);
    expect(control.mails[0]).not.toHaveProperty('locale');
    expect(control.mails[0]).toMatchObject({ kind: 'notice', title: 'Iemand logde in' });
    control.accepts = true;
    later(LOCALE_RETRY_MS);
    expect(await email.notice('signin', notice)).toBe(true);
    expect(control.mails[1]).toMatchObject({ locale: 'nl-NL' });
  });
});
