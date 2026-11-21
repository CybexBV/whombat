import { describe, expect, it, vi } from 'vitest';
import { type AskViewCtx, askViewOf } from './askView';
import type { DeskAsk } from './desk';

const plex: DeskAsk = {
  number: 41,
  kind: 'approval',
  title: 'Restart Plex on blackbox?',
  at: '2026-10-20T12:31:00Z',
  where: 'blackbox',
  detail: 'Plex stopped answering.',
  facts: ['docker restart plex'],
  approveLabel: 'Restart Plex',
  onDesk: true,
  phoneReason: null,
  deny: true,
  choices: [{ scope: 'agent', label: 'Always allow Dusty to restart Plex' }],
};

const ctx = (over: Partial<AskViewCtx> = {}): AskViewCtx => ({
  unlocked: true,
  voice: true,
  busy: false,
  note: null,
  assistant: 'Dusty',
  decide: vi.fn(),
  withPin: vi.fn(),
  talk: vi.fn(),
  unlock: vi.fn(),
  ...over,
});

const labels = (v: ReturnType<typeof askViewOf>) => v?.buttons.map((b) => b.label);
const press = (v: ReturnType<typeof askViewOf>, key: string) =>
  v?.buttons.find((b) => b.key === key)?.onPress();

describe('a question in the pop-up (DK-151, CG-397)', () => {
  it('carries an approval’s words and its own answers, the wider choices behind the PIN', () => {
    const c = ctx();
    const v = askViewOf(plex, c);
    expect(v).toMatchObject({
      quote: 'Plex stopped answering.',
      facts: ['docker restart plex'],
      busy: false,
    });
    expect(labels(v)).toEqual(['Restart Plex', 'Always allow Dusty to restart Plex', 'Deny', 'Ask']);
    expect(v?.buttons[0]).toMatchObject({ primary: true });
    expect(v?.buttons[1]).toMatchObject({ lock: true });
    press(v, 'approve');
    press(v, 'agent');
    press(v, 'deny');
    expect(c.decide).toHaveBeenCalledWith(41, 'approve');
    expect(c.withPin).toHaveBeenCalledWith(41, 'agent');
    expect(c.decide).toHaveBeenCalledWith(41, 'deny');
  });

  it('shows nothing of a question while locked, only the unlock', () => {
    const c = ctx({ unlocked: false });
    const v = askViewOf(plex, c);
    expect(v?.quote).toBeUndefined();
    expect(v?.facts).toBeUndefined();
    expect(labels(v)).toEqual(['Unlock']);
    expect(v?.note?.icon).toBe('lock');
    press(v, 'unlock');
    expect(c.unlock).toHaveBeenCalled();
  });

  it('asks for the PIN first on a risky one, and says why', () => {
    const risky: DeskAsk = {
      ...plex,
      onDesk: false,
      approveWithPin: true,
      phoneReason: 'money',
      choices: [],
    };
    const c = ctx();
    const v = askViewOf(risky, c);
    expect(v?.buttons[0]).toMatchObject({ label: 'Restart Plex', primary: true, lock: true });
    expect(v?.note).toEqual({ text: 'It’s about money.', icon: 'lock' });
    press(v, 'approve');
    expect(c.withPin).toHaveBeenCalledWith(41, null);
    expect(labels(askViewOf(risky, ctx({ unlocked: false })))).toEqual(['Unlock']);
  });

  it('sends one only the phone may approve to the phone, with Deny where it may be denied', () => {
    const phone: DeskAsk = { ...plex, onDesk: false, phoneReason: 'outside', choices: [] };
    const v = askViewOf(phone, ctx());
    expect(labels(v)).toEqual(['Deny', 'Ask']);
    expect(v?.note?.icon).toBe('phone');
    expect(v?.note?.text).toContain('phone');
    const noDeny = askViewOf({ ...phone, deny: false }, ctx());
    expect(labels(noDeny)).toEqual([]);
    expect(noDeny?.note?.icon).toBe('phone');
  });

  it('answers a question in Talk, or on the phone without Talk’s voice', () => {
    const question: DeskAsk = { ...plex, kind: 'question', approveLabel: null, deny: false, choices: [] };
    const c = ctx();
    const v = askViewOf(question, c);
    expect(labels(v)).toEqual(['Answer']);
    press(v, 'answer');
    expect(c.talk).toHaveBeenCalledWith(question);
    const quiet = askViewOf(question, ctx({ voice: false }));
    expect(labels(quiet)).toEqual([]);
    expect(quiet?.note?.icon).toBe('phone');
  });

  it('names who asks, holds the buttons while an answer is on its way and says what went wrong', () => {
    const v = askViewOf(
      { ...plex, from: 'Mara' },
      ctx({ busy: true, note: 'This was answered somewhere else.' }),
    );
    expect(v).toMatchObject({
      from: 'Mara',
      busy: true,
      note: { text: 'This was answered somewhere else.' },
    });
  });

  it('gives no view for a question the page doesn’t have', () => {
    expect(askViewOf(undefined, ctx())).toBeNull();
  });
});
