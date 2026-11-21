import type { DoneTodayItem, LookResearch, NeedsYouItem } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { homeStatus, type StatusInput, statusText } from './greeting';

const TZ = 'Europe/Amsterdam';
const local = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00+01:00`).toISOString();

const quiet = { needsYou: 0, working: 0, problems: 0 };

const failed: Pick<NeedsYouItem, 'kind' | 'severity' | 'title' | 'research'> = {
  kind: 'alert',
  severity: 'bad',
  title: 'The disk array on blackbox has failed',
};
const approval: Pick<NeedsYouItem, 'kind' | 'severity' | 'title' | 'research'> = {
  kind: 'approval',
  severity: 'bad',
  title: 'Restart arnica-prod-nest-01 on pve-02?',
};
const research = (state: LookResearch['state'], title?: string): LookResearch => ({
  key: 'server:blackbox',
  state,
  ...(title ? { title } : {}),
  at: local('09:00'),
});
const working = { title: 'Adding your Daikin heat pump', state: 'working', default: false } as const;

const done = (id: string, at: string, over: Partial<DoneTodayItem> = {}): DoneTodayItem => ({
  id,
  text: `Task ${id}`,
  at: local(at),
  ...over,
});

const say = (input: StatusInput) => {
  const status = homeStatus(input, { timeZone: TZ });
  return {
    text: statusText(status.parts),
    tone: status.tone,
    strong: status.parts.find((p) => p.strong)?.text,
  };
};

describe('the status sentence (status-line.md)', () => {
  it('names the worst problem first, never “everything is running” above it', () => {
    const s = say({ summary: { needsYou: 3, working: 1, problems: 4 }, needsYou: [approval, failed] });
    expect(s.tone).toBe('bad');
    expect(s.strong).toBe('The disk array on blackbox has failed.');
    expect(s.text).toContain('2 other things need you');
    expect(s.text).not.toMatch(/running|All good/);
  });

  it('leads to the Inbox item it names', () => {
    const status = homeStatus({
      summary: { ...quiet, needsYou: 2 },
      needsYou: [approval, { ...failed, id: 'hosts.alert:12' }],
    });
    expect(status.itemId).toBe('hosts.alert:12');
    expect(homeStatus({ summary: { ...quiet, needsYou: 1 }, needsYou: [approval] }).itemId).toBeUndefined();
  });

  it('says what the assistant does about it, in its own words once it found out', () => {
    expect(
      say({ summary: { ...quiet, needsYou: 1 }, needsYou: [{ ...failed, research: research('looking') }] })
        .text,
    ).toBe('The disk array on blackbox has failed. I’m looking into it.');
    const found = say({
      summary: { ...quiet, needsYou: 2 },
      needsYou: [{ ...failed, research: research('found', 'Both parity drives dropped out') }],
    });
    expect(found.strong).toBe('Both parity drives dropped out.');
    expect(found.text).toContain('1 other thing needs you');
    expect(
      say({
        summary: { ...quiet, needsYou: 1 },
        needsYou: [{ ...failed, research: research('fixing', 'Swapping') }],
      }).text,
    ).toContain('I’m fixing it.');
  });

  it('leaves out a fixed problem and asks: neither is the worst problem', () => {
    const s = say({
      summary: { ...quiet, needsYou: 2 },
      needsYou: [approval, { ...failed, research: research('fixed', 'The array works again') }],
    });
    expect(s).toMatchObject({ tone: 'warn', strong: '2 things need you' });
  });

  it('says what is offline or broken when no item names it', () => {
    expect(say({ summary: quiet, things: [{ name: 'pve-01', status: 'offline' }] })).toMatchObject({
      tone: 'bad',
      text: 'pve-01 is offline.',
    });
    expect(
      say({
        summary: { ...quiet, needsYou: 2 },
        things: [
          { name: 'blackbox', status: 'bad' },
          { name: 'pve-02', status: 'warn' },
        ],
      }).text,
    ).toBe('Something’s wrong with blackbox. 2 things need you.');
    expect(
      say({
        summary: quiet,
        things: [
          { name: 'a', status: 'bad' },
          { name: 'b', status: 'bad' },
        ],
      }).strong,
    ).toBe('Something’s wrong with 2 things.');
  });

  it('counts what needs you with what the assistant is on', () => {
    expect(say({ summary: { ...quiet, needsYou: 2 }, chats: [working] })).toMatchObject({
      tone: 'warn',
      strong: '2 things need you',
      text: '2 things need you, and I’m adding your Daikin heat pump.',
    });
    expect(say({ summary: { ...quiet, needsYou: 1 } }).text).toBe('1 thing needs you.');
  });

  it('keeps an eye on open problems nobody has to decide, without saying all good', () => {
    expect(say({ summary: { ...quiet, problems: 2, worst: 'warn' } })).toMatchObject({
      tone: 'warn',
      text: 'Nothing needs you. I’m keeping an eye on 2 things.',
    });
  });

  it('is all good with what it fixed overnight or today and what it is doing', () => {
    expect(say({ summary: quiet })).toMatchObject({ tone: 'ok', text: 'All good. Nothing needs you.' });
    expect(
      say({ summary: quiet, doneToday: [done('a', '03:10', { fixed: true }), done('b', '10:00')] }).text,
    ).toBe('All good. I fixed 1 thing overnight.');
    expect(
      say({
        summary: quiet,
        chats: [working],
        doneToday: [done('a', '03:10', { fixed: true }), done('b', '11:00', { fixed: true })],
      }).text,
    ).toBe('All good. I fixed 2 things today. I’m adding your Daikin heat pump.');
    // Without a time zone it can't tell the night: “today”.
    expect(
      statusText(homeStatus({ summary: quiet, doneToday: [done('a', '03:10', { fixed: true })] }).parts),
    ).toContain('today');
  });
});
