/**
 * Looks the assistant looked into, in fixture mode (Whombat look-research.md LR-01…LR-12; contracts 3.5; app
 * look-research-web.md AP-5909), over the one-Whombat world, its thing pages and Chat:
 *
 * - **Home Assistant**: found, with the step it offers (“Restart Zigbee”). Pressing it (`looks.fix`) posts Mara's
 *   go-ahead in the look's thread and reads `fixing`; a read 4 s later finds it fixed (“Zigbee works again”), with
 *   Neo's word on it in the thread. Its page carries the same research.
 * - **UniFi**: found, without a step: only Mara can do it (the hallway access point lost its power or cable).
 * - **pve-02** running warm: Neo is looking into it.
 * - **pve-01**: Neo's plan for everything there (handle-it.md), waiting for Go ahead, as a card in its thread and on
 *   its page (`looks.get`). Go ahead reads `fixing`; a read 4 s later finds it done. *Ask Neo to handle these* on any
 *   other thing (`looks.handle`) reads `looking`, and a read 4 s later finds a plan for it.
 *
 * Each look is a Needs you item and a thread of Mara's Chat that Neo started (LR-04), listed among the Chat's threads
 * and opened by Ask Neo. Ignore and Remind me tomorrow take the item off Home as they do the world's own. Off unless
 * `looks` (`VITE_FIXTURE_LOOKS=1`, or `localStorage['whombat:fixture-looks']` for the visual suite), so Home and Chat
 * stay as the mocks draw them otherwise.
 */
import { localAt } from '@whombat/client';
import {
  type ChatThread,
  type HomeOverview,
  type HomeRef,
  type LookPlanView,
  type LookResearch,
  type Message,
  type NeedsYouItem,
  needsYouCount,
  needsYouGroupOf,
  type ThingPage,
} from '@whombat/core';
import { burrow, mara } from '@whombat/fixtures';
import { DEFAULT_CHAT_ID, WHOMBAT_ID } from './oneFixtures';

const API = '/api/v1';
const B = `${API}/burrows/${burrow.slug}`;
const TZ = 'Europe/Amsterdam';

/** The flag the visual suite sets before the page loads. */
export const LOOKS_FIXTURE_KEY = 'whombat:fixture-looks';

/** Whether the looks are seeded: the option, else the env or the visual suite's flag. */
export function looksSeeded(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  if (import.meta.env.VITE_FIXTURE_LOOKS === '1') return true;
  return typeof localStorage !== 'undefined' && localStorage.getItem(LOOKS_FIXTURE_KEY) === '1';
}

export const HA_LOOK = 'connection:con_home-assistant';
export const UNIFI_LOOK = 'connection:con_unifi';
export const PVE_LOOK = 'server:pve-02';
export const HA_LOOK_THREAD = 'msg_look-home-assistant';
export const UNIFI_LOOK_THREAD = 'msg_look-unifi';
export const PVE_LOOK_THREAD = 'msg_look-pve-02';
export const PLAN_LOOK = 'server:pve-01';
export const PLAN_LOOK_THREAD = 'msg_look-pve-01';
export const PLAN_LOOK_CARD = 'msg_look-pve-01-plan';
/** A server that was just added, and Neo's care plan for it (care-plan.md). */
export const CARE_LOOK = 'care:server:pve-03';
export const CARE_LOOK_THREAD = 'msg_care-pve-03';
export const CARE_LOOK_CARD = 'msg_care-pve-03-plan';

/** The plan Neo offers on a thing it was handed, with the defaults it chose. */
const PLAN_STEPS = [
  'Add the 6 machines to a nightly backup at 02:00, keeping a week',
  'Install the 1 update tonight at 03:00',
  'Restart nginx',
];

/** Whombat's defaults for pve-03, a Proxmox server with four machines and a Backup Server (care-plan.md). */
const CARE_STEPS = [
  'Back up all 4 machines every night at 02:00 to pbs-01, keeping a week',
  'Install system updates on Sundays at 03:00 and restart if needed',
  'Tell you when apps have updates',
];

/** How long the step takes before a read finds it fixed. */
const FIX_MS = 4000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function message(over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>): Message {
  return {
    conversationId: DEFAULT_CHAT_ID as Message['conversationId'],
    editedAt: null,
    text: '',
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...over,
  };
}

export interface LookFixtures {
  /** Answers what it owns, and adds its looks to what the world answers (`next`). */
  fetch(req: Request, next: (req: Request) => Promise<Response>): Promise<Response>;
}

export function createLookFixtures(options: { now?: () => number } = {}): LookFixtures {
  const clock = options.now ?? (() => Date.now());
  const made = clock();
  const at = (hhmm: string) => localAt(made, TZ, hhmm, 0);
  const person = mara.id as Message['authorId'];
  const bot = WHOMBAT_ID as Message['authorId'];
  const thread = (rootId: string) => ({
    conversationId: DEFAULT_CHAT_ID as LookResearch['conversationId'],
    threadRootId: rootId as LookResearch['threadRootId'],
  });
  let seq = 0;

  const research = new Map<string, LookResearch>([
    [
      HA_LOOK,
      {
        key: HA_LOOK,
        state: 'found',
        title: 'Zigbee stopped working in Home Assistant',
        summary:
          'After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.',
        fix: 'Restart Zigbee',
        ...thread(HA_LOOK_THREAD),
        at: at('07:14'),
      },
    ],
    [
      UNIFI_LOOK,
      {
        key: UNIFI_LOOK,
        state: 'found',
        title: 'The hallway access point is offline',
        summary:
          'It doesn’t answer, not to UniFi and not on the network, so the Wi-Fi upstairs is weaker. It probably lost power or its cable; I can’t fix that from here. I’ll tell you when it’s back.',
        ...thread(UNIFI_LOOK_THREAD),
        at: at('08:31'),
      },
    ],
    [PVE_LOOK, { key: PVE_LOOK, state: 'looking', ...thread(PVE_LOOK_THREAD), at: at('10:58') }],
    [
      PLAN_LOOK,
      {
        key: PLAN_LOOK,
        state: 'found',
        title: 'pve-01 isn’t backed up, and nginx stopped',
        summary:
          'None of its six machines has a backup plan, one update is waiting and nginx stopped this morning. I can sort all of it out.',
        plan: PLAN_STEPS,
        ...thread(PLAN_LOOK_THREAD),
        at: at('09:40'),
      },
    ],
    [
      CARE_LOOK,
      {
        key: CARE_LOOK,
        state: 'found',
        title: 'pve-03 runs 4 machines',
        summary: 'Nothing on it is backed up yet, and its updates wait for someone to install them.',
        plan: CARE_STEPS,
        ...thread(CARE_LOOK_THREAD),
        at: at('11:06'),
      },
    ],
  ]);
  /** Each plan card's research, by the card's research id. */
  const planCards = new Map<string, string>([
    ['lkr_fixture-pve-01', PLAN_LOOK],
    ['lkr_fixture-pve-03', CARE_LOOK],
  ]);
  /** The quiet hours for changes (care-plan.md): the default until moved. */
  let quietHours = { window: { start: '03:00', end: '05:00' }, timeZone: TZ, default: true };
  /** When a thing was handed to Neo, by look. */
  const handedSince = new Map<string, number>();
  // `server:pve-01` and a care plan's `care:server:pve-03` are named by their last part.
  const nameOf = (key: string) => key.split(':').at(-1) ?? key;
  /** When the step was pressed, by look. */
  const fixingSince = new Map<string, number>();

  const items: NeedsYouItem[] = [
    {
      id: 'ny_look-home-assistant',
      ref: { kind: 'connection', id: 'con_home-assistant' },
      kind: 'connection',
      severity: 'warn',
      nature: 'problem',
      title: 'Home Assistant needs a look',
      body: '2 integrations stopped loading.',
      at: at('07:12'),
      subject: { kind: 'connection', id: 'con_home-assistant', name: 'Home Assistant' },
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
      ],
    },
    {
      id: 'ny_look-unifi',
      ref: { kind: 'connection', id: 'con_unifi' },
      kind: 'connection',
      severity: 'warn',
      nature: 'problem',
      title: 'Hallway AP is offline',
      body: 'UniFi lost it at 08:29.',
      at: at('08:29'),
      subject: { kind: 'connection', id: 'con_unifi', name: 'UniFi' },
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
      ],
    },
    {
      id: 'ny_look-pve-02',
      ref: { kind: 'alert', id: 'alt_pve-02-warm' },
      kind: 'alert',
      severity: 'warn',
      nature: 'problem',
      title: 'pve-02 is running warm',
      body: 'Its processor has been at 86 °C for 20 minutes.',
      at: at('10:55'),
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
      actions: [
        { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
      ],
    },
  ];
  const keyOf: Record<string, string> = {
    'ny_look-home-assistant': HA_LOOK,
    'ny_look-unifi': UNIFI_LOOK,
    'ny_look-pve-02': PVE_LOOK,
  };
  /** Items taken off Home (ignored or snoozed), by id. */
  const gone = new Set<string>();

  /** Each look's thread: Neo's plain first line, and what it found (LR-04, LR-05). */
  let messages: Message[] = [
    message({
      id: HA_LOOK_THREAD as Message['id'],
      authorId: bot,
      createdAt: at('07:12'),
      text: 'Home Assistant needs a look. I’m looking into it.',
      subject: { kind: 'connection', id: 'con_home-assistant', name: 'Home Assistant' },
    }),
    message({
      id: 'msg_look-home-assistant-1' as Message['id'],
      authorId: bot,
      createdAt: at('07:14'),
      threadRootId: HA_LOOK_THREAD as Message['id'],
      text: 'Zigbee didn’t start again after this morning’s update, so the hallway lights and motion sensors don’t respond. Restarting Zigbee usually fixes this. Shall I?',
    }),
    message({
      id: UNIFI_LOOK_THREAD as Message['id'],
      authorId: bot,
      createdAt: at('08:29'),
      text: 'UniFi needs a look. I’m looking into it.',
      subject: { kind: 'connection', id: 'con_unifi', name: 'UniFi' },
    }),
    message({
      id: 'msg_look-unifi-1' as Message['id'],
      authorId: bot,
      createdAt: at('08:31'),
      threadRootId: UNIFI_LOOK_THREAD as Message['id'],
      text: 'The hallway access point doesn’t answer, not to UniFi and not on the network. It probably lost power or its cable, which I can’t fix from here. I’ll tell you when it’s back.',
    }),
    message({
      id: PVE_LOOK_THREAD as Message['id'],
      authorId: bot,
      createdAt: at('10:58'),
      text: 'pve-02 is running warm. I’m looking into it.',
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
    }),
    message({
      id: PLAN_LOOK_THREAD as Message['id'],
      authorId: bot,
      createdAt: at('09:31'),
      text: 'pve-01 needs a look. I’m looking into it.',
      subject: { kind: 'server', id: 'pve-01', name: 'pve-01' },
    }),
    message({
      id: PLAN_LOOK_CARD as Message['id'],
      authorId: bot,
      createdAt: at('09:40'),
      threadRootId: PLAN_LOOK_THREAD as Message['id'],
      text: 'pve-01 isn’t backed up, and nginx stopped.',
      card: { kind: 'look_plan', researchId: 'lkr_fixture-pve-01', plan: null },
    }),
    message({
      id: CARE_LOOK_THREAD as Message['id'],
      authorId: bot,
      createdAt: at('11:04'),
      text: 'pve-03 is ready. I’m working out how to look after it.',
      subject: { kind: 'server', id: 'pve-03', name: 'pve-03' },
    }),
    message({
      id: CARE_LOOK_CARD as Message['id'],
      authorId: bot,
      createdAt: at('11:06'),
      threadRootId: CARE_LOOK_THREAD as Message['id'],
      text: 'pve-03 runs 4 machines.',
      card: { kind: 'look_plan', researchId: 'lkr_fixture-pve-03', plan: null },
    }),
    message({
      id: 'msg_care-pve-03-1' as Message['id'],
      authorId: bot,
      createdAt: at('11:06'),
      threadRootId: CARE_LOOK_THREAD as Message['id'],
      text: 'Nothing on pve-03 is backed up yet. Say go ahead and I’ll set up its backups and updates.',
    }),
    message({
      id: 'msg_look-pve-01-1' as Message['id'],
      authorId: bot,
      createdAt: at('09:41'),
      threadRootId: PLAN_LOOK_THREAD as Message['id'],
      text: 'None of pve-01’s machines is backed up, an update is waiting and nginx stopped. Say go ahead and I’ll take care of it.',
    }),
  ];

  /** A plan card as it reads now, from its research. */
  function planView(key: string): LookPlanView | null {
    const r = research.get(key);
    if (!r?.plan) return null;
    const state =
      r.state === 'found'
        ? 'waiting'
        : r.state === 'fixing'
          ? 'doing'
          : r.state === 'fixed'
            ? 'done'
            : 'gone';
    return {
      name: nameOf(key),
      state,
      steps: r.plan,
      title: r.title ?? null,
      summary: r.summary ?? null,
      research: r,
      at: r.at,
      ...(key.startsWith('care:') ? { care: true } : {}),
    };
  }
  /** A message as a client reads it now: a plan card resolved from its research. */
  function live(m: Message): Message {
    if (m.card?.kind !== 'look_plan') return m;
    const key = planCards.get(m.card.researchId);
    return { ...m, card: { ...m.card, plan: key ? planView(key) : null } };
  }

  /** A look pressed long enough ago is fixed, and Neo says so in its thread; a thing handed to Neo gets a plan. */
  function settle() {
    for (const [key, since] of handedSince) {
      if (clock() - since < FIX_MS) continue;
      handedSince.delete(key);
      const r = research.get(key);
      if (r?.state !== 'looking') continue;
      const found = new Date(since + FIX_MS).toISOString();
      const id = `lkr_fixture-${++seq}`;
      planCards.set(id, key);
      research.set(key, {
        ...r,
        state: 'found',
        title: `${nameOf(key)} has a few things to sort out`,
        summary: 'Two things need doing there. I picked the usual settings; say go ahead and I’ll do both.',
        plan: [
          'Restart what stopped and check it stays up',
          'Back it up every night at 02:00, keeping a week',
        ],
        at: found,
      });
      if (r.threadRootId)
        messages = [
          ...messages,
          message({
            id: `msg_look-${++seq}` as Message['id'],
            authorId: bot,
            createdAt: found,
            threadRootId: r.threadRootId,
            text: `${nameOf(key)} has a few things to sort out.`,
            card: { kind: 'look_plan', researchId: id, plan: null },
          }),
        ];
    }
    for (const [key, since] of fixingSince) {
      if (clock() - since < FIX_MS) continue;
      fixingSince.delete(key);
      const r = research.get(key);
      if (r?.state !== 'fixing') continue;
      const done = new Date(since + FIX_MS).toISOString();
      if (r.plan) {
        research.set(key, {
          ...r,
          state: 'fixed',
          title: `${nameOf(key)} is looked after`,
          summary: 'I did all of it and checked it works. The first backup runs tonight.',
          at: done,
        });
        continue;
      }
      research.set(key, {
        ...r,
        state: 'fixed',
        title: 'Zigbee works again',
        summary: 'I restarted Zigbee; the hallway lights and sensors answer again.',
        at: done,
      });
      if (r.threadRootId)
        messages = [
          ...messages,
          message({
            id: `msg_look-${++seq}` as Message['id'],
            authorId: bot,
            createdAt: done,
            threadRootId: r.threadRootId,
            text: 'I restarted Zigbee and it works again: the hallway lights and sensors answer.',
          }),
        ];
    }
  }

  const roots = () => messages.filter((m) => !m.threadRootId);
  const repliesOf = (id: string) => messages.filter((m) => m.threadRootId === id).map(live);
  function withCounts(m: Message): Message {
    const replies = repliesOf(m.id);
    return replies.length
      ? {
          ...m,
          replyCount: replies.length,
          lastReplyAt: replies.at(-1)?.createdAt ?? null,
          threadParticipantIds: [...new Set(replies.map((r) => r.authorId).reverse())].slice(0, 3),
        }
      : m;
  }
  const isRoot = (id: string) => roots().some((m) => m.id === id);

  function shown(): NeedsYouItem[] {
    return items
      .filter((i) => !gone.has(i.id))
      .map((i) => {
        const r = research.get(keyOf[i.id] ?? '');
        return r ? { ...i, research: r } : i;
      });
  }

  const sameRef = (a: HomeRef, b: HomeRef) => a.kind === b.kind && a.id === b.id;

  async function read<T>(res: Response): Promise<T | null> {
    if (!res.ok) return null;
    return (await res.clone().json()) as T;
  }

  return {
    async fetch(req, next) {
      const url = new URL(req.url, 'http://fixtures.local');
      if (!url.pathname.startsWith(`${B}/`)) return next(req);
      const rest = url.pathname.slice(B.length);
      const route = `${req.method} ${rest}`;
      settle();

      if (route === 'POST /looks/fix') {
        const { key } = (await req.clone().json()) as { key: string };
        const r = research.get(key);
        if (r?.state !== 'found' || (!r.fix && !r.plan))
          return json({ error: { code: 'not_found', message: 'That look offers no step.' } }, 404);
        const { fix, ...without } = r;
        const now = clock();
        const fixing: LookResearch = { ...without, state: 'fixing', at: new Date(now).toISOString() };
        research.set(key, fixing);
        fixingSince.set(key, now);
        if (r.threadRootId)
          messages = [
            ...messages,
            message({
              id: `msg_look-${++seq}` as Message['id'],
              authorId: person,
              createdAt: new Date(now).toISOString(),
              threadRootId: r.threadRootId,
              text: fix ? `Go ahead: ${fix.charAt(0).toLowerCase()}${fix.slice(1)}.` : 'Go ahead.',
            }),
          ];
        return json({ research: fixing });
      }

      if (route === 'POST /looks/handle') {
        const { key } = (await req.clone().json()) as { key: string };
        const r = research.get(key);
        if (
          r &&
          (r.state === 'looking' || r.state === 'fixing' || (r.state === 'found' && (r.fix || r.plan)))
        )
          return json({ research: r });
        const now = clock();
        const root = r?.threadRootId ?? (`msg_look-${++seq}` as string);
        const [kind, id] = key.split(':') as [string, string];
        messages = [
          ...messages,
          message({
            id: (r?.threadRootId ? `msg_look-${++seq}` : root) as Message['id'],
            authorId: person,
            createdAt: new Date(now).toISOString(),
            threadRootId: r?.threadRootId ? (root as Message['threadRootId']) : null,
            text: `Please take care of what needs a look on ${nameOf(key)}.`,
            ...(r?.threadRootId
              ? {}
              : { subject: { kind: kind as 'server' | 'connection', id, name: nameOf(key) } }),
          }),
        ];
        const looking: LookResearch = {
          key,
          state: 'looking',
          ...thread(root),
          at: new Date(now).toISOString(),
        };
        research.set(key, looking);
        handedSince.set(key, now);
        return json({ research: looking });
      }

      if (route === 'GET /change-window') return json(quietHours);
      if (route === 'PUT /change-window') {
        const { window } = (await req.clone().json()) as { window: { start: string; end: string } };
        quietHours = { ...quietHours, window, default: false };
        return json(quietHours);
      }

      if (route === 'GET /looks/research') {
        return json({ research: research.get(url.searchParams.get('key') ?? '') ?? null });
      }

      if (route === 'POST /needs-you/snooze' || route === 'POST /needs-you/ignore') {
        const body = (await req.clone().json()) as { ref: HomeRef; ignored?: boolean; until?: string };
        const mine = items.find((i) => sameRef(i.ref, body.ref));
        if (mine) {
          if (body.ignored === false) gone.delete(mine.id);
          else gone.add(mine.id);
          return json(route.endsWith('snooze') ? { ref: body.ref, snoozedUntil: body.until } : body);
        }
        return next(req);
      }

      if (route === 'GET /home') {
        const res = await next(req);
        const home = await read<HomeOverview>(res);
        if (!home) return res;
        const mine = shown();
        // The one list (needs-you-list.md NYL-01): the looks' items too, and every item about a looked-into thing
        // with its research, in the group that gives it; one taken off is at the foot.
        const quieted = items
          .filter((i) => gone.has(i.id))
          .map((i) => ({ ...i, state: 'acknowledged' as const }));
        const list = [...(home.needsYouList ?? []), ...mine, ...quieted]
          .map((i) => {
            const r =
              i.subject && i.kind !== 'approval' && i.kind !== 'question'
                ? research.get(`${i.subject.kind}:${i.subject.id}`)
                : undefined;
            return r ? { ...i, research: r } : i;
          })
          .map((i) => ({ ...i, group: needsYouGroupOf(i) }));
        return json({
          ...home,
          needsYou: [...home.needsYou, ...mine],
          needsYouList: list,
          summary: { ...home.summary, needsYou: needsYouCount(list) },
        });
      }

      const page = /^\/things\/([^/]+)$/.exec(rest);
      const look = page ? research.get(decodeURIComponent(page[1] as string)) : undefined;
      if (page && look && req.method === 'GET') {
        const res = await next(req);
        const p = await read<ThingPage>(res);
        return p ? json({ ...p, research: look }) : res;
      }

      const threadOf = /^\/messages\/(msg_[A-Za-z0-9_-]+)\/thread$/.exec(rest);
      if (threadOf && req.method === 'GET' && isRoot(threadOf[1] as string)) {
        const root = roots().find((m) => m.id === threadOf[1]) as Message;
        return json({
          root: withCounts(root),
          replies: repliesOf(root.id),
          conversationId: DEFAULT_CHAT_ID,
          where: 'Chat',
          topic: null,
          more: null,
        });
      }
      const one = /^\/messages\/(msg_[A-Za-z0-9_-]+)$/.exec(rest);
      if (one && req.method === 'GET') {
        const m = messages.find((x) => x.id === one[1]);
        if (m) return json({ message: m.threadRootId ? live(m) : withCounts(m) });
      }

      // Ask in the thing's own thread (needs-you-list.md NYL-06): a reply in its look's thread when it has one.
      if (route === 'POST /chats') {
        const input = (await req.clone().json()) as {
          text: string;
          subject?: { kind: string; id: string };
          reuseThread?: boolean;
        };
        const root = input.reuseThread
          ? roots()
              .filter((m) => m.subject?.kind === input.subject?.kind && m.subject?.id === input.subject?.id)
              .at(-1)
          : undefined;
        if (root) {
          const reply = message({
            id: `msg_look-${++seq}` as Message['id'],
            authorId: person,
            createdAt: new Date(clock()).toISOString(),
            text: input.text,
            threadRootId: root.id as Message['threadRootId'],
          });
          messages = [...messages, reply];
          const res = await next(new Request(`http://fixtures.local${B}/conversations/${DEFAULT_CHAT_ID}`));
          const detail = await read<{ conversation: unknown }>(res);
          return json({ conversation: detail?.conversation, message: reply }, 201);
        }
        return next(req);
      }

      const chat = `/conversations/${DEFAULT_CHAT_ID}/messages`;
      if (rest === chat && req.method === 'POST') {
        const input = (await req.clone().json()) as {
          text: string;
          clientId?: string;
          threadRootId?: string;
        };
        if (input.threadRootId && isRoot(input.threadRootId)) {
          const m = message({
            id: `msg_look-${++seq}` as Message['id'],
            authorId: person,
            createdAt: new Date(clock()).toISOString(),
            text: input.text,
            clientId: input.clientId ?? null,
            threadRootId: input.threadRootId as Message['threadRootId'],
          });
          messages = [...messages, m];
          return json({ message: m, dispatches: [] }, 201);
        }
      }
      if (rest === chat && req.method === 'GET') {
        const res = await next(req);
        const list = await read<{ messages: Message[] }>(res);
        if (!list) return res;
        const all = [...list.messages, ...roots().map(withCounts)].sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );
        return json({ ...list, messages: all });
      }
      if (route === 'GET /chats/threads' && (url.searchParams.get('room') ?? 'chat') === 'chat') {
        const res = await next(req);
        const list = await read<{ threads: ChatThread[] }>(res);
        if (!list) return res;
        const kind = url.searchParams.get('subjectKind');
        const id = url.searchParams.get('subjectId');
        const mine = roots()
          .map(withCounts)
          .filter((m) => (!kind || m.subject?.kind === kind) && (!id || m.subject?.id === id))
          .map(
            (m): ChatThread => ({
              conversationId: DEFAULT_CHAT_ID as ChatThread['conversationId'],
              room: 'chat',
              rootId: m.id,
              authorId: m.authorId,
              text: m.text.slice(0, 200),
              subject: m.subject ?? null,
              createdAt: m.createdAt,
              replyCount: m.replyCount,
              lastAt: m.lastReplyAt ?? m.createdAt,
              working: [...research.values()].some(
                (r) => r.threadRootId === m.id && (r.state === 'looking' || r.state === 'fixing'),
              ),
              runtime: null,
            }),
          );
        const threads = [...list.threads, ...mine].sort(
          (a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt),
        );
        return json({ ...list, threads });
      }
      return next(req);
    },
  };
}
