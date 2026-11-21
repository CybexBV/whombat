/**
 * Looks Neo looked into, in the demo world (Whombat look-research.md LR-01…LR-12; contracts 3.5;
 * look-research-mobile.md AP-5925), as the web's fixture mode has them (look-research-web.md AP-5909):
 *
 * - **Home Assistant**: found, with the step it offers (“Restart Zigbee”). Pressing it (`looks.fix`) posts Mara's
 *   go-ahead in the look's thread and reads `fixing`; `fixMs` later it is fixed (“Zigbee works again”), Neo says so in
 *   the thread and Home and the page read again (`home.changed`). Its page carries the same research.
 * - **UniFi**: found, without a step: only Mara can do it (the hallway access point lost its power or cable).
 * - **pve-02** running warm: Neo is looking into it.
 *
 * Each look is a Needs you item and a thread of Mara's Chat that Neo started (LR-04, `threads()` for the Chat's
 * fixtures), which Ask Neo opens. Ignore and Remind me tomorrow take an item off Home as they do the world's own. Off
 * unless `EXPO_PUBLIC_WHOMBAT_LOOKS=1`, so Home stays as the mocks draw it otherwise. Pure TypeScript.
 */
import type { ChatSubject, LookResearch, NeedsYouItem } from '@whombat/core';
import { at } from '@whombat/fixtures';

export const LOOK_KEYS = {
  ha: 'connection:con_ha',
  unifi: 'connection:con_unifi',
  pve: 'server:pve-02',
} as const;

/** The looks' threads in Mara's Chat. */
export const LOOK_ROOTS = {
  ha: 'msg_look-ha',
  unifi: 'msg_look-unifi',
  pve: 'msg_look-pve-02',
} as const;

/** How long the step takes before it is fixed. */
export const LOOK_FIX_MS = 4000;

const HA: ChatSubject = { kind: 'connection', id: 'con_ha', name: 'Home Assistant' };
const UNIFI: ChatSubject = { kind: 'connection', id: 'con_unifi', name: 'UniFi' };
const PVE: ChatSubject = { kind: 'server', id: 'pve-02', name: 'pve-02' };

/** A thread Neo started in Mara's Chat: its first line, its subject and what it said since (who, when, what). */
export interface LookThreadSeed {
  id: string;
  authorId: string;
  at: string;
  text: string;
  subject: ChatSubject;
  replies: [string, string, string][];
  /** Neo is working in it (the thread's `working`). */
  working: boolean;
}

export interface LookFixtureOptions {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** Mara's Chat, where each look has its thread. */
  chatId: string;
  assistantId: string;
  personId: string;
  /** A reply in a look's thread, out to the Chat (the Chat's fixtures). */
  reply: (rootId: string, authorId: string, text: string) => void;
  /** Whether Neo is working in a look's thread. */
  working: (rootId: string, on: boolean) => void;
  /** Home, its items and the pages changed (`home.changed`). */
  changed: () => void;
  fixMs?: number;
}

/** The looks' threads, for the Chat's fixtures to list before the world starts. */
export function lookThreads(assistantId: string): LookThreadSeed[] {
  return [
    {
      id: LOOK_ROOTS.ha,
      authorId: assistantId,
      at: at('07:12'),
      text: 'Home Assistant needs a look. I’m looking into it.',
      subject: HA,
      replies: [
        [
          assistantId,
          at('07:14'),
          'Zigbee didn’t start again after this morning’s update, so the hallway lights and motion sensors don’t respond. Restarting Zigbee usually fixes this. Shall I?',
        ],
      ],
      working: false,
    },
    {
      id: LOOK_ROOTS.unifi,
      authorId: assistantId,
      at: at('08:29'),
      text: 'UniFi needs a look. I’m looking into it.',
      subject: UNIFI,
      replies: [
        [
          assistantId,
          at('08:31'),
          'The hallway access point doesn’t answer, not to UniFi and not on the network. It probably lost power or its cable, which I can’t fix from here. I’ll tell you when it’s back.',
        ],
      ],
      working: false,
    },
    {
      id: LOOK_ROOTS.pve,
      authorId: assistantId,
      at: at('13:58'),
      text: 'pve-02 is running warm. I’m looking into it.',
      subject: PVE,
      replies: [],
      working: true,
    },
  ];
}

export function createLookFixtures(options: LookFixtureOptions) {
  const { now, chatId } = options;
  const fixMs = options.fixMs ?? LOOK_FIX_MS;
  const thread = (rootId: string) => ({
    conversationId: chatId as LookResearch['conversationId'],
    threadRootId: rootId as LookResearch['threadRootId'],
  });
  const research = new Map<string, LookResearch>([
    [
      LOOK_KEYS.ha,
      {
        key: LOOK_KEYS.ha,
        state: 'found',
        title: 'Zigbee stopped working in Home Assistant',
        summary:
          'After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.',
        fix: 'Restart Zigbee',
        ...thread(LOOK_ROOTS.ha),
        at: at('07:14'),
      },
    ],
    [
      LOOK_KEYS.unifi,
      {
        key: LOOK_KEYS.unifi,
        state: 'found',
        title: 'The hallway access point is offline',
        summary:
          'It doesn’t answer, not to UniFi and not on the network, so the Wi-Fi upstairs is weaker. It probably lost power or its cable; I can’t fix that from here. I’ll tell you when it’s back.',
        ...thread(LOOK_ROOTS.unifi),
        at: at('08:31'),
      },
    ],
    [LOOK_KEYS.pve, { key: LOOK_KEYS.pve, state: 'looking', ...thread(LOOK_ROOTS.pve), at: at('13:58') }],
  ]);

  const items: (NeedsYouItem & { key: string })[] = [
    {
      key: LOOK_KEYS.ha,
      id: 'ny_look-ha',
      ref: { kind: 'connection', id: 'con_ha' },
      kind: 'connection',
      severity: 'warn',
      nature: 'problem',
      title: 'Home Assistant needs a look',
      body: '2 integrations stopped loading.',
      at: at('07:12'),
      subject: HA,
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
      ],
    },
    {
      key: LOOK_KEYS.unifi,
      id: 'ny_look-unifi',
      ref: { kind: 'connection', id: 'con_unifi' },
      kind: 'connection',
      severity: 'warn',
      nature: 'problem',
      title: 'Hallway AP is offline',
      body: 'UniFi lost it at 08:29.',
      at: at('08:29'),
      subject: UNIFI,
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
      ],
    },
    {
      key: LOOK_KEYS.pve,
      id: 'ny_look-pve-02',
      ref: { kind: 'alert', id: 'al_pve-02-warm' },
      kind: 'alert',
      severity: 'warn',
      nature: 'problem',
      title: 'pve-02 is running warm',
      body: 'Its processor has been at 86 °C for 20 minutes.',
      at: at('13:45'),
      subject: PVE,
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
      ],
    },
  ];

  /** The step is taken: fixed, and Neo says so in the thread. */
  function fixed(key: string) {
    const r = research.get(key);
    if (r?.state !== 'fixing') return;
    options.working(r.threadRootId ?? '', false);
    research.set(key, {
      ...r,
      state: 'fixed',
      title: 'Zigbee works again',
      summary: 'I restarted Zigbee; the hallway lights and sensors answer again.',
      at: now().toISOString(),
    });
    if (r.threadRootId)
      options.reply(
        r.threadRootId,
        options.assistantId,
        'I restarted Zigbee and it works again: the hallway lights and sensors answer.',
      );
    options.changed();
  }

  return {
    /** The looks as Needs you items, each with its research. */
    items(): NeedsYouItem[] {
      return items.map(({ key, ...item }) => {
        const r = research.get(key);
        return r ? { ...item, research: r } : item;
      });
    },
    /** The research a thing's page carries (its id is the look's key), if any. */
    research(thingId: string): LookResearch | undefined {
      return research.get(thingId);
    },
    /**
     * `looks.fix`: only a found look with a step (else 404); posts Mara's go-ahead in its thread and reads `fixing`,
     * fixed after `fixMs`.
     */
    fix(key: string): { status: number; body: unknown } {
      const r = research.get(key);
      if (r?.state !== 'found' || !r.fix)
        return { status: 404, body: { error: { code: 'not_found', message: 'That look offers no step.' } } };
      const { fix, ...without } = r;
      const fixing: LookResearch = { ...without, state: 'fixing', at: now().toISOString() };
      research.set(key, fixing);
      if (r.threadRootId) {
        options.reply(
          r.threadRootId,
          options.personId,
          `Go ahead: ${fix.charAt(0).toLowerCase()}${fix.slice(1)}.`,
        );
        options.working(r.threadRootId, true);
      }
      options.changed();
      options.setTimer(() => fixed(key), fixMs);
      return { status: 200, body: { research: fixing } };
    },
  };
}
