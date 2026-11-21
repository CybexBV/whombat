/**
 * The app's menus as iOS draws them (ios-message-menu.md AP-6260…AP-6263; ios-native.md): a message's, a settled
 * thread's, a file's, a conversation's and a notice line's — their rows, groups and picks.
 */
import type { NeedsYouButton } from '@whombat/client';
import { QUICK_REACTIONS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { FileAction } from './files';
import type { MessageActionKind, MessageMenu } from './messageActions';
import {
  conversationMenu,
  fileMenu,
  inboxMoreMenu,
  MORE_REACTIONS,
  nativeMenuSpec,
  parseConversationPick,
  parseNativeMenuPick,
  parseQuietPick,
  parseSettledPick,
  quietLineMenu,
  settledThreadMenu,
} from './nativeMenu';
import { notifyOptions } from './notify';
import { quickReactions } from './reactions';

const menuOf = (kinds: MessageActionKind[], react = true): MessageMenu => ({
  react,
  actions: kinds.map((kind) => ({
    kind,
    label: kind,
    destructive: kind === 'delete',
    accessibilityHint: '',
  })),
});

describe('the iOS message menu', () => {
  it('groups the actions — the thread, copying, changing, deleting — with symbols and Delete red', () => {
    const spec = nativeMenuSpec(
      menuOf(['settle', 'reply_thread', 'copy_text', 'copy_link', 'edit', 'pin', 'delete']),
      null,
      null,
    );
    expect(spec.sections.map((s) => s.map((i) => i.id))).toEqual([
      ['settle', 'reply_thread'],
      ['copy_text', 'copy_link'],
      ['edit', 'pin'],
      ['delete'],
    ]);
    const all = spec.sections.flat();
    expect(all.filter((i) => i.destructive).map((i) => i.id)).toEqual(['delete']);
    expect(all.find((i) => i.id === 'copy_text')?.icon).toBe('doc.on.doc');
    expect(all.every((i) => i.icon && !i.disabled)).toBe(true);
  });

  it('puts the quick reactions in its row, the viewer’s own marked, then More reactions', () => {
    const quick = quickReactions([
      { value: QUICK_REACTIONS[0] ?? '', count: 2, mine: true, principalIds: [] },
    ]);
    const spec = nativeMenuSpec(menuOf(['copy_text']), quick, 'Claude · Opus');
    expect(spec.reactions?.map((r) => r.value)).toEqual([...QUICK_REACTIONS]);
    const [first, second] = spec.reactions ?? [];
    expect(first).toMatchObject({ mine: true, label: expect.stringContaining('Take back') });
    expect(second).toMatchObject({ mine: false, label: expect.stringContaining('React with') });
    expect(spec.more?.title).toBe(MORE_REACTIONS);
    // What answered an agent's reply is the menu's title.
    expect(spec.title).toBe('Claude · Opus');
  });

  it('has no reactions on a message that takes none, and no title without a detail', () => {
    const spec = nativeMenuSpec(menuOf(['reply_thread'], false), quickReactions([]), '');
    expect(spec).toMatchObject({ reactions: null, more: null, title: null });
  });

  it('reads back every pick it offers, and nothing else', () => {
    const spec = nativeMenuSpec(menuOf(['open_again', 'unpin', 'delete']), quickReactions([]), null);
    const ids = [...(spec.reactions ?? []), spec.more, ...spec.sections.flat()].map((i) => i?.id ?? '');
    expect(ids.map(parseNativeMenuPick)).toEqual([
      ...QUICK_REACTIONS.map((value) => ({ kind: 'react', value })),
      { kind: 'more' },
      { kind: 'action', action: 'open_again' },
      { kind: 'action', action: 'unpin' },
      { kind: 'action', action: 'delete' },
    ]);
    expect(parseNativeMenuPick('react:')).toBeNull();
    expect(parseNativeMenuPick('forward')).toBeNull();
  });
});

describe('the other iOS menus', () => {
  it('offers a settled thread Open again and Reply in thread, and Copy link only where it has an address', () => {
    expect(settledThreadMenu(true).sections.map((s) => s.map((i) => i.id))).toEqual([
      ['open_again', 'reply_thread'],
      ['copy_link'],
    ]);
    expect(
      settledThreadMenu(false)
        .sections.flat()
        .map((i) => i.id),
    ).toEqual(['open_again', 'reply_thread']);
    for (const item of settledThreadMenu(true).sections.flat())
      expect(parseSettledPick(item.id)).toBe(item.id);
    expect(parseSettledPick('delete')).toBeNull();
  });

  it('puts a file’s name on top and its actions in groups, Remove red and last', () => {
    const action = (kind: FileAction['kind']): FileAction => ({
      kind,
      label: kind,
      destructive: kind === 'remove',
      accessibilityHint: '',
    });
    const spec = fileMenu('plan.pdf', [
      action('download'),
      action('rename'),
      action('move'),
      action('remove'),
    ]);
    expect(spec.title).toBe('plan.pdf');
    expect(spec.sections.map((s) => s.map((i) => i.id))).toEqual([
      ['download'],
      ['rename', 'move'],
      ['remove'],
    ]);
    expect(
      spec.sections
        .flat()
        .filter((i) => i.destructive)
        .map((i) => i.id),
    ).toEqual(['remove']);
    expect(spec.reactions).toBeNull();
  });

  it('puts a conversation’s notification levels one level down, the current one ticked and named', () => {
    const spec = conversationMenu(notifyOptions({ kind: 'dm', notify: 'mentions' }), [
      { key: 'pins', label: 'Pinned messages' },
      { key: 'files', label: 'Files' },
    ]);
    const notify = spec.sections[0]?.[0];
    expect(notify?.subtitle).toBe('Mentions');
    const levels = notify?.children?.flat() ?? [];
    expect(levels.map((i) => [i.id, i.checked])).toEqual([
      ['notify:all', false],
      ['notify:mentions', true],
      ['notify:none', false],
    ]);
    expect(levels.every((i) => !!i.subtitle)).toBe(true);
    expect(spec.sections[1]?.map((i) => i.id)).toEqual(['pins', 'files']);
    expect(parseConversationPick('notify:none')).toEqual({ kind: 'notify', level: 'none' });
    expect(parseConversationPick('files')).toEqual({ kind: 'link', key: 'files' });
    expect(parseConversationPick('notify')).toBeNull();
    expect(parseConversationPick('notify:loud')).toBeNull();
  });

  it('offers a notice line Ignore and Snooze, then Stop watching, with what they mean under them', () => {
    const spec = quietLineMenu(
      {
        ref: { check: 'offline', subject: null } as never,
        label: 'More for Hallway AP is offline',
        ignore: { label: 'Ignore', words: 'Until it’s back online.' },
        snooze: { label: 'Remind me tomorrow' },
        stop: { label: 'Stop watching Hallway AP', words: 'No warnings about it.' },
      },
      'Hallway AP is offline',
    );
    expect(spec.title).toBe('Hallway AP is offline');
    expect(spec.sections.map((s) => s.map((i) => i.id))).toEqual([['ignore', 'snooze'], ['stop']]);
    expect(spec.sections.flat().map((i) => i.subtitle ?? null)).toEqual([
      'Until it’s back online.',
      null,
      'No warnings about it.',
    ]);
    for (const item of spec.sections.flat()) expect(parseQuietPick(item.id)).toBe(item.id);
  });
});

describe('an Inbox row’s More (inbox.md IBX-04)', () => {
  it('groups handing over and talking, then Remind me tomorrow, then Stop watching, each with its symbol', () => {
    const b = (kind: NeedsYouButton['kind']): NeedsYouButton => ({
      id: kind,
      kind,
      label: kind,
      look: 'quiet',
      more: true,
    });
    const spec = inboxMoreMenu([b('handle'), b('talk'), b('snooze'), b('stop')], 'pve-02');
    expect(spec.title).toBe('pve-02');
    expect(spec.sections.map((s) => s.map((i) => i.id))).toEqual([['handle', 'talk'], ['snooze'], ['stop']]);
    expect(spec.sections.flat().every((i) => typeof i.icon === 'string' && i.icon.length > 0)).toBe(true);
    // Only what the row has: an approval's More is Talk alone.
    expect(inboxMoreMenu([b('talk')]).sections).toHaveLength(1);
  });
});
