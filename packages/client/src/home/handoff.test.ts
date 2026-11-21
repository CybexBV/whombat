import { describe, expect, it } from 'vitest';
import { handedOverThread, needsYouActionGoes, needsYouButtonGoes, threadToOpen } from './handoff';
import type { NeedsYouButton } from './needsYouList';

const button = (kind: NeedsYouButton['kind'], action?: NeedsYouButton['action']) => ({
  kind,
  ...(action ? { action } : {}),
});
const action = (kind: NonNullable<NeedsYouButton['action']>['kind']) =>
  ({ kind, label: 'x', style: 'primary' }) as NonNullable<NeedsYouButton['action']>;

describe('needsYouButtonGoes', () => {
  it('sends what hands work to the assistant to its thread', () => {
    for (const kind of ['fix', 'askFix', 'handle', 'talk'] as const)
      expect(needsYouButtonGoes(button(kind))).toBe('thread');
    // The yes to a proposal (“Yes, do it”) and “Look into it” start its turn.
    expect(needsYouButtonGoes(button('action', action('ask')))).toBe('thread');
    expect(needsYouButtonGoes(button('action', action('investigate')))).toBe('thread');
  });

  it('sends See it and an open to their page', () => {
    expect(needsYouButtonGoes(button('see'))).toBe('page');
    expect(needsYouButtonGoes(button('action', action('open')))).toBe('page');
  });

  it('keeps the person where they are for decisions and quiet buttons', () => {
    for (const kind of ['approve', 'approve_later', 'decline', 'snooze'] as const)
      expect(needsYouActionGoes({ kind })).toBe('stay');
    for (const kind of ['settle', 'snooze', 'stop', 'back'] as const)
      expect(needsYouButtonGoes(button(kind))).toBe('stay');
    expect(needsYouButtonGoes(button('action'))).toBe('stay');
  });
});

describe('handedOverThread', () => {
  it('is the look’s thread in Chat, when the answer names one', () => {
    expect(handedOverThread({ research: { threadRootId: 'msg_1' } })).toBe('/chat?thread=msg_1');
    expect(handedOverThread({ research: {} })).toBeNull();
    expect(handedOverThread(null)).toBeNull();
  });
});

describe('threadToOpen', () => {
  it('opens the thread unless the person is in it already', () => {
    expect(threadToOpen('/chat?thread=msg_1')).toBe('/chat?thread=msg_1');
    expect(threadToOpen('/chat?thread=msg_1', '/chat?thread=msg_2')).toBe('/chat?thread=msg_1');
    expect(threadToOpen('/chat?thread=msg_1', '/chat?thread=msg_1')).toBeNull();
    expect(threadToOpen('/chat?thread=msg_1', 'msg_1')).toBeNull();
    expect(threadToOpen(null, 'msg_1')).toBeNull();
  });
});
