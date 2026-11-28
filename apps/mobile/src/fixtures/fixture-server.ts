/**
 * The fixture world for the mobile app: `@whombat/fixtures`' `createFixtureFetch()` (the mock burrow over
 * the real REST contract) plus what the mobile screens need on top of it, so the app runs — and is
 * screenshotted — without a server:
 *
 * - `notifications.inbox`: Mara's inbox from the mobile mock (`NOTIFICATIONS`, in the mock's order), with
 *   the live approval on needs-you rows.
 * - The mobile mock's moment for approval #12 (`Whombat Mobile.dc.html` is later in the storyline than
 *   the desktop's 11:22: checks green on 7be20f, Waffle approved at 11:38). Approving shows
 *   "APPROVED · DEPLOYING" with Undo, declining "DECLINED", undo returns to pending — the mock's states.
 *   The approval is swapped into every response that embeds it (cards, inbox).
 * - A realtime stand-in: the agent, woken by a message, "thinks" (typing event) and its reply arrives as a
 *   `message.created` event after `replyDelayMs`, like a turn against a real server.
 *
 * - Plans, observed activity and the work overview: `@whombat/client/work-fixtures`, as in the web's fixture mode.
 * - The agent's capabilities (AP-238; `./capabilities`): the shop's login in Mara's Vault.
 * - The Automations tab's rows (automations-tab.md AP-6312; `./automations`): three automations, switched in memory.
 * - Settings → Agent's parts (mobile-parity.md MQ-01; `./parity`): Neo's schedules and its always-allowed command, and
 *   the writes that change them; its notes, Mara's memory and what the agent runs on the Whombat (`services.*`) are
 *   `@whombat/fixtures`' own.
 * - The agent's skills (all-skills.md AP-2365; one-agent.md AP-4967): Neo's skill library,
 *   `@whombat/client/skill-library/fixtures`' world as the web's fixture mode has it — what Neo learned, added from
 *   Hermes's hub, Hermes's built-ins (one changed), off and removed skills — answering its reads and writes in memory
 *   (hermes-skills.md AP-5575).
 * - The person's prompts (prompts-phone.md; `./prompts`): the list and its writes in memory, T3 Code's projects, and
 *   using one, which posts the person's message in Chat as sending it would.
 *
 * Pure TypeScript over `fetch` / `Request` / `Response`, so it is unit-tested in Node.
 */
import type { EventFrame, Realtime, RealtimeStatus, ResyncSignal } from '@whombat/client';
import { createFakeProtected, type ProtectedFakeKind } from '@whombat/client/protected/fake';
import { createSkillLibraryWorld } from '@whombat/client/skill-library/fixtures';
import { createWorkFixtures } from '@whombat/client/work-fixtures';
import {
  type AnyEndpoint,
  API_ENDPOINTS,
  type Approval,
  type Bootstrap,
  INBOX_SECTIONS,
  type InboxFilter,
  type InboxItem,
  type InboxResponse,
  type Message,
  type MessagePage,
  matchPath,
  promptLine,
  type RealtimeEvent,
  type SendMessageResponse,
  type UsePromptBody,
} from '@whombat/core';
import type { VaultListResponse } from '@whombat/core/contracts';
import type { VaultEntryDetail } from '@whombat/core/vault';
import { AGENT, at, BURROW_ID, deployApproval, mara, NOTIFICATIONS } from '@whombat/fixtures';

import { assistantAgent, createAssistantFixtures } from './assistant';
import { createAutomationFixtures } from './automations';
import { createCapabilityFixtures } from './capabilities';
import { type CouncilSetupFixtureOptions, createCouncilSetupFixtures } from './councilSetups';
import type { DelegationFixtureStage } from './delegation';
import { createParityFixtures } from './parity';
import { createPromptFixtures, type PromptFixtureOptions } from './prompts';
import { withRichMessages } from './rich';
import { settleThread, startSettleSignals, withSettleMessages, withSettleRuns } from './settle';
import { createOwnVaultKeys } from './vaultOwnKeys';

const API_BASE = '/api/v1';
/** The skill library's endpoints (CT-415, CT-1410…CT-1415): the library and a skill, its writes, Hermes's hub. */
const SKILL_LIBRARY_PATH = /^\/burrows\/[^/]+\/skills\/(?:library|hub)(?:\/|$)/;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface FixtureServerOptions {
  /** `createFixtureFetch()` from `@whombat/fixtures/fetch`. */
  inner: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The app clock (the fixture world starts at 11:22 on 23 September 2026). */
  now: () => Date;
  /** How long the agent "thinks" before its reply arrives. */
  replyDelayMs?: number;
  /** Timer (tests pass a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Rich messages in PR #482's room (`rich.ts`); default `EXPO_PUBLIC_WHOMBAT_RICH=1`. */
  rich?: boolean;
  /** The settled-cards thread in PR #482's room (`settle.ts`, AP-730…AP-735); default `EXPO_PUBLIC_WHOMBAT_SETTLE=1`. */
  settle?: boolean;
  /** Repeats `fn` every `ms` until stopped (tests pass a fake); the settle world's thinking agent. */
  every?: (fn: () => void, ms: number) => () => void;
  /**
   * The one-Whombat world (`assistant.ts`, AP-1377): Home, Watch, Chat, servers, the heat pump's skill; on by default
   * (one-layout-android.md AP-2646), off only for tests of the contracts' fixtures underneath.
   */
  assistant?: boolean;
  /**
   * Add a server's extras in that world (`hostsSi.ts`, server-signin-mobile.md AP-1714): a server waiting for you
   * and the agent's card; default `EXPO_PUBLIC_WHOMBAT_SI=1`.
   */
  si?: boolean;
  /** Chat in that world (`chatChannel.ts`, chat-channel.md AP-2460); default on unless `EXPO_PUBLIC_WHOMBAT_CHAT=0`. */
  chat?: boolean;
  /** Tonight's server work in Chat (`chatChannel.ts`, AP-4306); default `EXPO_PUBLIC_WHOMBAT_TASKS=1`. */
  tasks?: boolean;
  /** Two one-time Find My watches in Chat (`chatChannel.ts`, findmy-watch.md); default `EXPO_PUBLIC_WHOMBAT_WATCHES=1`. */
  watches?: boolean;
  /** The sign-in cards in Chat (`chatChannel.ts`, AP-6680); default `EXPO_PUBLIC_WHOMBAT_SIGNIN=1`. */
  signIns?: boolean;
  /** Councils in Chat (`council.ts`, council.md); default `EXPO_PUBLIC_WHOMBAT_COUNCIL=1`. */
  councils?: boolean;
  /**
   * A delegation in Chat at this stage (`delegation.ts`, delegate.md); default `EXPO_PUBLIC_WHOMBAT_DELEGATION`
   * (`offer`, `working` or `done`), none when unset; null: none.
   */
  delegation?: DelegationFixtureStage | null;
  /** Software work in Chat's threads, with T3 Code's jobs (`code.ts`); default `EXPO_PUBLIC_WHOMBAT_CODE=1`. */
  code?: boolean;
  /** The service pages listed on Home (`thingPages.ts`, AP-4660); default `EXPO_PUBLIC_WHOMBAT_SERVICES=1`. */
  services?: boolean;
  /** A model on the burrow's network (`localModel.ts`, AP-5126); default `EXPO_PUBLIC_WHOMBAT_LOCAL_MODEL=1`. */
  localModel?: boolean;
  /** Web search with a Brave Search key (`webSearch.ts`); default `EXPO_PUBLIC_WHOMBAT_WEB_SEARCH=1`. */
  webSearch?: boolean;
  /** Looks Neo looked into (`looks.ts`, AP-5925); default `EXPO_PUBLIC_WHOMBAT_LOOKS=1`. */
  looks?: boolean;
  /**
   * Settings → Neo → Council (`councilSetups.ts`): Mara's council with T3 Code's choices by default;
   * `EXPO_PUBLIC_WHOMBAT_COUNCIL_SETUPS=none` starts with none set, `not_connected` or `unreachable` without the choices.
   */
  councilSetups?: Omit<CouncilSetupFixtureOptions, 'now'>;
  /**
   * The person's prompts (`prompts.ts`): Whombat's starters and one of Mara's, T3 Code ready by default;
   * `EXPO_PUBLIC_WHOMBAT_PROMPTS=not_connected` or `unreachable` without its projects, `older` a Whombat from before them.
   */
  prompts?: Omit<PromptFixtureOptions, 'now'>;
  /**
   * What's protected (`@whombat/client/protected/fake`, backup-trust.md): `tested` by default, so the demo shows pve-02's
   * restore tests on with their results on the machines' pages; `calm` starts them off.
   */
  protected?: ProtectedFakeKind;
}

/** The prompts' world from `EXPO_PUBLIC_WHOMBAT_PROMPTS` (not_connected, unreachable, older). */
function promptsFromEnv(): Omit<PromptFixtureOptions, 'now'> {
  const asked = process.env.EXPO_PUBLIC_WHOMBAT_PROMPTS;
  if (asked === 'older') return { older: true };
  if (asked === 'not_connected' || asked === 'unreachable') return { t3: asked };
  return {};
}

/** The council's world from `EXPO_PUBLIC_WHOMBAT_COUNCIL_SETUPS` (none, not_connected, unreachable). */
function councilSetupsFromEnv(): Omit<CouncilSetupFixtureOptions, 'now'> {
  const asked = process.env.EXPO_PUBLIC_WHOMBAT_COUNCIL_SETUPS;
  if (asked === 'none') return { empty: true };
  if (asked === 'not_connected' || asked === 'unreachable') return { t3: asked };
  return {};
}

export interface FixtureServer {
  fetch: FetchFn;
  realtime: Realtime;
}

/** Approval #12 at the mobile mock's moment: checks green on 7be20f, Waffle approved, a person pending. */
export function mobileMomentApproval(): Approval {
  const base = deployApproval();
  return {
    ...base,
    conditions: base.conditions.map((c) => {
      if (c.kind === 'checks_pass') {
        return { ...c, met: true, headSha: '7be20f7', state: 'passed', passed: 41, total: 41, fixing: false };
      }
      if (c.kind === 'review_approved')
        return { ...c, met: true, reviewState: 'approved', reviewedAt: at('11:38') };
      return c;
    }),
  };
}

/** The endpoint a request hits; static segments win over params (`/audit/export` before `/audit/:id`). */
export function matchEndpoint(
  method: string,
  path: string,
): { endpoint: AnyEndpoint; params: Record<string, string> } | null {
  let best: { endpoint: AnyEndpoint; params: Record<string, string>; score: number } | null = null;
  for (const endpoint of API_ENDPOINTS) {
    if (endpoint.method !== method || endpoint.base !== API_BASE) continue;
    const params = matchPath(endpoint.path, path);
    if (!params) continue;
    const score = Object.keys(params).length;
    if (!best || score < best.score) best = { endpoint, params, score };
  }
  return best ? { endpoint: best.endpoint, params: best.params } : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Replace every embedded copy of `approval` (same id) in a JSON value. */
export function swapApproval(value: unknown, approval: Approval): unknown {
  if (Array.isArray(value)) return value.map((v) => swapApproval(v, approval));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (obj.id === approval.id && typeof obj.number === 'number' && Array.isArray(obj.conditions)) {
    return approval;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = swapApproval(v, approval);
  return out;
}

/** Apply `createdAt` overrides to every message (by id) in a JSON value. */
export function restamp(value: unknown, stamps: ReadonlyMap<string, string>): unknown {
  if (stamps.size === 0) return value;
  if (Array.isArray(value)) return value.map((v) => restamp(v, stamps));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = restamp(v, stamps);
  const stamp = typeof out.id === 'string' ? stamps.get(out.id) : undefined;
  if (stamp && typeof out.createdAt === 'string' && typeof out.conversationId === 'string')
    out.createdAt = stamp;
  return out;
}

const FILTER_KINDS: Record<InboxFilter, readonly string[]> = {
  all: ['needs_you', 'mention', 'agent_update'],
  needs_you: ['needs_you'],
  mentions: ['mention'],
  agents: ['agent_update'],
};

/** Mara's inbox in the mock's order, for a filter chip. */
export function fixtureInbox(
  filter: InboxFilter,
  approval: Approval,
  readIds: ReadonlySet<string>,
): InboxResponse {
  const items: InboxItem[] = NOTIFICATIONS.filter((n) => n.principalId === mara.id).map((n) => ({
    ...n,
    readAt: readIds.has(n.id) ? at('11:22') : n.readAt,
    approval: n.approvalId === approval.id ? approval : null,
  }));
  const shown = new Set(FILTER_KINDS[filter]);
  return {
    sections: INBOX_SECTIONS.filter((s) => shown.has(s.kind)).map((s) => ({
      kind: s.kind,
      title: s.title,
      items: items.filter((i) => i.kind === s.kind),
    })),
    counts: {
      all: items.length,
      needs_you: items.filter((i) => i.kind === 'needs_you').length,
      mentions: items.filter((i) => i.kind === 'mention').length,
      agents: items.filter((i) => i.kind === 'agent_update').length,
    },
    unread: items.filter((i) => !i.readAt).length,
  };
}

type Listener = (event: RealtimeEvent, frame: EventFrame) => void;

class FixtureRealtime implements Realtime {
  private state: RealtimeStatus = 'idle';
  private held = new Map<string, number>();
  private listeners = new Set<Listener>();
  private typed = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: RealtimeStatus) => void>();
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  private setStatus(next: RealtimeStatus) {
    this.state = next;
    for (const l of this.statusListeners) l(next);
  }

  connect() {
    if (this.state === 'open') return;
    this.seq = 0;
    this.setStatus('open');
  }
  disconnect() {
    this.setStatus('closed');
  }
  reconnectNow() {
    this.connect();
  }
  status() {
    return this.state;
  }
  session() {
    return this.state === 'open' ? { burrowId: BURROW_ID, principalId: mara.id } : null;
  }
  subscribe(topics: string | readonly string[]) {
    const list = typeof topics === 'string' ? [topics] : [...topics];
    for (const t of list) this.held.set(t, (this.held.get(t) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const t of list) {
        const n = (this.held.get(t) ?? 1) - 1;
        if (n <= 0) this.held.delete(t);
        else this.held.set(t, n);
      }
    };
  }
  topics() {
    return [...this.held.keys()];
  }
  lastSeq() {
    return this.seq || undefined;
  }
  sendTyping() {
    return false;
  }
  setPresence() {}
  on<T extends RealtimeEvent['type']>(
    type: T,
    listener: (event: Extract<RealtimeEvent, { type: T }>, frame: EventFrame) => void,
  ) {
    const set = this.typed.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.typed.set(type, set);
    return () => {
      set.delete(listener as Listener);
    };
  }
  onEvent(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onStatus(listener: (s: RealtimeStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  onResync(_listener: (signal: ResyncSignal) => void) {
    return () => {};
  }
  onHello() {
    return () => {};
  }
  onError() {
    return () => {};
  }

  /** Deliver an event (only while connected, like a socket). */
  emit(topic: string, event: RealtimeEvent) {
    if (this.state !== 'open') return;
    this.seq += 1;
    const frame: EventFrame = {
      op: 'event',
      topic,
      event,
      seq: this.seq,
      eventId: null,
      at: this.now().toISOString(),
    };
    for (const l of this.listeners) l(event, frame);
    for (const l of this.typed.get(event.type) ?? []) l(event, frame);
  }
}

export function createFixtureServer(options: FixtureServerOptions): FixtureServer {
  const { inner, now } = options;
  const replyDelayMs = options.replyDelayMs ?? 1600;
  const rich = options.rich ?? process.env.EXPO_PUBLIC_WHOMBAT_RICH === '1';
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const realtime = new FixtureRealtime(now);
  const settle = options.settle ?? process.env.EXPO_PUBLIC_WHOMBAT_SETTLE === '1';
  if (settle)
    startSettleSignals(
      now,
      (topic, event) => realtime.emit(topic, event),
      options.every ??
        ((fn, ms) => {
          const timer = setInterval(fn, ms);
          return () => clearInterval(timer);
        }),
    );
  let approval = mobileMomentApproval();
  /** Agent replies that are still being "thought": hidden from lists until delivered. */
  const pending = new Set<string>();
  const readNotifications = new Set<string>();
  // Plans, activity and the work overview (contracts 0.12), shared with the web's fixture mode.
  const work = createWorkFixtures({ now });

  const parity = createParityFixtures();
  const automations = createAutomationFixtures();
  const councilSetups = createCouncilSetupFixtures({
    now,
    ...(options.councilSetups ?? councilSetupsFromEnv()),
  });
  const prompts = createPromptFixtures({ now, ...(options.prompts ?? promptsFromEnv()) });

  const assistant =
    (options.assistant ?? true)
      ? createAssistantFixtures({
          now,
          emit: (topic, event) => realtime.emit(topic, event),
          replyDelayMs,
          setTimer,
          ...(options.si !== undefined ? { si: options.si } : {}),
          ...(options.chat !== undefined ? { chat: options.chat } : {}),
          ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
          ...(options.watches !== undefined ? { watches: options.watches } : {}),
          ...(options.signIns !== undefined ? { signIns: options.signIns } : {}),
          ...(options.councils !== undefined ? { councils: options.councils } : {}),
          ...(options.delegation !== undefined ? { delegation: options.delegation } : {}),
          ...(options.code !== undefined ? { code: options.code } : {}),
          ...(options.services !== undefined ? { services: options.services } : {}),
          ...(options.localModel !== undefined ? { localModel: options.localModel } : {}),
          ...(options.webSearch !== undefined ? { webSearch: options.webSearch } : {}),
          ...(options.looks !== undefined ? { looks: options.looks } : {}),
        })
      : null;

  // Neo's skill library (AP-2365): the same world as the web's fixture mode, its times from this world's clock.
  const skillLibrary = createSkillLibraryWorld({ agentName: assistantAgent().name, now: now() });

  // The agent holds Mara's Vault entries (vault-self-serve.md VS-01, VS-02; AP-4035).
  const ownKeys = assistant ? createOwnVaultKeys(now, assistantAgent().name) : null;

  const capabilities = createCapabilityFixtures({ now });

  // What's protected and restore tests (backup-trust.md): the same world as the web's fixture mode.
  const protectedWorld = createFakeProtected({ kind: options.protected ?? 'tested', now: now().getTime() });

  async function forward(path: string, init: RequestInit | undefined): Promise<Response> {
    return inner(`http://fixtures.whombat.local${API_BASE}${path}`, init);
  }

  async function body<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  function decide(decision: 'approve' | 'decline'): Approval {
    if (approval.state !== 'pending') return approval;
    const decidedAt = now().toISOString();
    approval = {
      ...approval,
      state: decision === 'approve' ? 'approved' : 'declined',
      decidedById: mara.id,
      decidedAt,
      conditions: approval.conditions.map((c) =>
        c.kind === 'person_approves' ? { ...c, met: decision === 'approve' } : c,
      ),
    };
    return approval;
  }

  function undo(): Approval {
    if (approval.state === 'pending' || approval.executedAt !== null) return approval;
    approval = {
      ...approval,
      state: 'pending',
      decidedById: null,
      decidedAt: null,
      conditions: approval.conditions.map((c) => (c.kind === 'person_approves' ? { ...c, met: false } : c)),
    };
    return approval;
  }

  /**
   * `createdAt` overrides for messages sent in the app. The fixture world stamps new messages with its
   * 11:22 seed time, older than the DM's 14:0x history; the cache orders by time, so a new message would
   * land at the top. Stamps keep new messages after the conversation's latest one.
   */
  const stamps = new Map<string, string>();

  function stampAfter(latest: string | undefined): string {
    const t = Math.max(now().getTime(), latest ? Date.parse(latest) + 1000 : 0);
    return new Date(t).toISOString();
  }

  async function afterSend(burrow: string, conversationId: string, sent: SendMessageResponse) {
    const res = await forward(
      `/burrows/${burrow}/conversations/${conversationId}/messages?limit=100`,
      undefined,
    );
    const page = await body<MessagePage>(res);
    const index = page.messages.findIndex((m) => m.id === sent.message.id);
    const earlier = page.messages.slice(0, Math.max(0, index)).map((m) => stamps.get(m.id) ?? m.createdAt);
    const sentAt = stampAfter(earlier.sort().at(-1));
    stamps.set(sent.message.id, sentAt);

    // The agent woke (a dispatch): its replies after the sent message are "thought" first.
    if (sent.dispatches.length === 0) return;
    const replies = page.messages
      .slice(index + 1)
      .filter((m) => m.authorId === AGENT.id && m.threadRootId === sent.message.threadRootId);
    for (const reply of replies) {
      pending.add(reply.id);
      realtime.emit(`conv:${conversationId}`, {
        type: 'typing',
        conversationId,
        threadRootId: reply.threadRootId,
        principalId: reply.authorId,
        active: true,
        expiresAt: new Date(now().getTime() + replyDelayMs + 4000).toISOString(),
      });
      setTimer(() => {
        pending.delete(reply.id);
        stamps.set(reply.id, stampAfter(sentAt));
        const delivered = restamp(reply, stamps) as Message;
        realtime.emit(`conv:${conversationId}`, { type: 'message.created', message: delivered });
      }, replyDelayMs);
    }
  }

  /**
   * Every request, then the Vault as the one-Whombat world has it (`ownKeys`): whichever layer answered an entry or the
   * list, it is on for Neo.
   */
  async function handle(input: string, init?: RequestInit): Promise<Response> {
    if (!ownKeys) return answer(input, init);
    const url = new URL(input, 'http://fixtures.whombat.local');
    const path = url.pathname.slice(API_BASE.length) || '/';
    const matched = url.pathname.startsWith(API_BASE)
      ? matchEndpoint((init?.method ?? 'GET').toUpperCase(), path)
      : null;
    const id = matched?.endpoint.id;
    const params = matched?.params ?? {};
    if (id === 'vault.giveKey' || id === 'vault.takeKey') {
      const got = await handle(`${API_BASE}/burrows/${params.burrow}/vault/${params.entryId}`);
      if (!got.ok) return got;
      ownKeys.set(
        params.entryId ?? '',
        id === 'vault.giveKey'
          ? (JSON.parse(String(init?.body ?? '{}')) as { servers?: string[] | null; envName?: string })
          : null,
      );
      const { entry } = (await got.json()) as { entry: VaultEntryDetail };
      return json({ entry: ownKeys.entry(entry), eventId: null });
    }
    if (id === 'vault.setKeyEnvName') {
      const got = await handle(`${API_BASE}/burrows/${params.burrow}/vault/${params.entryId}`);
      if (!got.ok) return got;
      const { entry } = (await got.json()) as { entry: VaultEntryDetail };
      if (entry.kind !== 'http')
        return json(
          { error: { code: 'validation_failed', message: 'Only an API’s value goes in a variable.' } },
          400,
        );
      ownKeys.setEnvName(entry, (JSON.parse(String(init?.body ?? '{}')) as { envName: string }).envName);
      return json({ entry: ownKeys.entry(entry), eventId: null });
    }
    const res = await answer(input, init);
    if (!res.ok || (id !== 'vault.get' && id !== 'vault.list')) return res;
    if (id === 'vault.get') {
      const got = (await res.json()) as { entry: VaultEntryDetail };
      return json({ ...got, entry: ownKeys.entry(got.entry) }, res.status);
    }
    const list = (await res.json()) as VaultListResponse;
    return json({ ...list, entries: list.entries.map(ownKeys.summary) }, res.status);
  }

  /**
   * Using a prompt (`prompts.use`): the person's message “Find what’s broken · Fusebox” is posted in their Chat as a new
   * thread or a reply, as the server does, and the prompt remembers where it ran.
   */
  async function answerPromptUse(params: Record<string, string>, init?: RequestInit): Promise<Response> {
    const prompt = prompts.get(params.promptId ?? '');
    if (!prompt) return json({ error: { code: 'not_found', message: 'That prompt is gone.' } }, 404);
    const b = JSON.parse(String(init?.body ?? '{}')) as UsePromptBody;
    const sent = await handle(
      `${API_BASE}/burrows/${params.burrow}/conversations/${b.conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: promptLine(prompt.title, b.project.title),
          ...(b.rootId ? { threadRootId: b.rootId } : {}),
        }),
      },
    );
    if (!sent.ok) return sent;
    const { message } = (await sent.json()) as SendMessageResponse;
    prompts.ran(prompt.id, b.project);
    return json({ messageId: message.id, rootId: message.threadRootId ?? message.id }, 201);
  }

  async function answer(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input, 'http://fixtures.whombat.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    const full = url.pathname;
    if (!full.startsWith(API_BASE)) return inner(input, init);
    const path = full.slice(API_BASE.length) || '/';
    const search = url.search;
    const matched = matchEndpoint(method, path);
    const id = matched?.endpoint.id;
    const params = matched?.params ?? {};

    if (id === 'notifications.inbox') {
      const filter = (url.searchParams.get('filter') ?? 'all') as InboxFilter;
      return json(fixtureInbox(filter in FILTER_KINDS ? filter : 'all', approval, readNotifications));
    }
    if (id === 'notifications.markRead') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { ids?: string[]; all?: boolean };
      for (const n of NOTIFICATIONS)
        if (payload.all || payload.ids?.includes(n.id)) readNotifications.add(n.id);
      return json({ unread: fixtureInbox('all', approval, readNotifications).unread });
    }
    if (id?.startsWith('approvals.') && Number(params.number) === approval.number) {
      if (id === 'approvals.get') return json({ approval, eventId: null });
      if (id === 'approvals.decide') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { decision: 'approve' | 'decline' };
        const next = decide(payload.decision);
        realtime.emit(`burrow:${BURROW_ID}`, { type: 'approval.updated', approval: next });
        return json({ approval: next, eventId: null });
      }
      if (id === 'approvals.undo') {
        if (approval.executedAt !== null) {
          return json({ error: { code: 'conflict', message: 'Already executed' } }, 409);
        }
        const next = undo();
        realtime.emit(`burrow:${BURROW_ID}`, { type: 'approval.updated', approval: next });
        return json({ approval: next, eventId: null });
      }
    }

    // The library's endpoints (CT-415), answered by the web fixture mode's world, which matches them itself.
    if (SKILL_LIBRARY_PATH.test(path)) {
      const library = await skillLibrary.handle(new Request(url.toString(), init));
      if (library) return library;
    }

    const oneAnswer = assistant ? await assistant.handle(id, params, init, url) : null;
    if (oneAnswer) return oneAnswer;

    const parityAnswer = parity.handle(id, params);
    if (parityAnswer) return parityAnswer;

    const automationAnswer = automations.handle(id, params, init, url.toString());
    if (automationAnswer) return automationAnswer;

    const councilAnswer = councilSetups.handle(id, init);
    if (councilAnswer) return councilAnswer;

    const promptAnswer = prompts.handle(id, params, init);
    if (promptAnswer) return promptAnswer;
    if (id === 'prompts.use') return answerPromptUse(params, init);

    if (settle && id === 'runs.list') {
      // The demo world has no run list of its own: the settle world's live runs, for the reply rows (AP-735).
      const status = url.searchParams.get('status');
      return json(withSettleRuns({ runs: [] }, status));
    }
    if (settle && id === 'messages.thread') {
      const view = settleThread(params.messageId ?? '');
      if (view) return json(view);
    }

    const capability = capabilities.handle(id, params, typeof init?.body === 'string' ? init.body : null);
    if (capability) return capability;

    const protectedAnswer = id
      ? protectedWorld.call(id, { params, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      : null;
    if (protectedAnswer) return json(protectedAnswer.body, protectedAnswer.status);

    if (id?.startsWith('plans.') || id === 'activity.list' || id === 'work.overview') {
      const supervised = await work.handle(new Request(url.toString(), init));
      if (supervised) return supervised;
    }

    const res = await forward(`${path}${search}`, init);
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res;
    let data = (await res.json()) as unknown;

    if (id === 'messages.send' && res.ok) {
      await afterSend(params.burrow ?? '', params.conversationId ?? '', data as SendMessageResponse);
    }
    if (id === 'messages.list' && res.ok && pending.size > 0) {
      const page = data as MessagePage;
      data = { ...page, messages: page.messages.filter((m) => !pending.has(m.id)) };
    }
    if (rich && id === 'messages.list' && res.ok && !url.searchParams.has('before'))
      data = withRichMessages(params.conversationId ?? '', data as MessagePage);
    if (assistant && id === 'conversations.bootstrap' && res.ok)
      data = assistant.bootstrap(data as Bootstrap);
    if (settle && id === 'messages.list' && res.ok && !url.searchParams.has('before'))
      data = withSettleMessages(params.conversationId ?? '', data as MessagePage);
    if (res.ok) data = capabilities.after(id, data);
    if (id === 'hosts.getGuest' && res.ok) {
      const result = protectedWorld.guestResult(
        params.serverId ?? '',
        decodeURIComponent(params.guestId ?? ''),
      );
      if (result) data = { ...(data as object), restoreTest: result };
    }
    if (assistant && res.ok) data = assistant.after(id, data);
    return json(restamp(swapApproval(data, approval), stamps), res.status);
  }

  return { fetch: handle, realtime };
}
