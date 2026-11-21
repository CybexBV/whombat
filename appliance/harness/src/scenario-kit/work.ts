/**
 * Workspace operations of slice B through the session (the `api.*` contract operations, allowlisted by the
 * appliance): the Whombat's one burrow and its one agent (the scripted Hermes; Whombat one-agent.md OA-01), the caller's
 * Chat with it (OA-04), a task message, an automation that asks a person for approval, and an event collector over
 * session subscriptions (cursors, duplicate detection).
 */
import { AUTOMATION_DEFINITION_VERSION } from '@whombat/core/domain';
import type { ApplianceSession, CallOptions, OperationResponse, SessionEvent } from './app-client.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export class CallFailed extends Error {
  readonly response: OperationResponse;
  constructor(op: string, r: OperationResponse) {
    super(`${op}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    this.response = r;
  }
}

export async function api<T = Record<string, unknown>>(
  s: ApplianceSession,
  id: string,
  method: Method,
  input: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown } = {},
  options: CallOptions & { expect?: number[] } = {},
): Promise<T> {
  const r = await s.call(
    { id, method },
    { params: input.params ?? {}, query: input.query ?? {}, body: input.body },
    options,
  );
  const ok = options.expect ?? [200, 201];
  if (!ok.includes(r.status)) throw new CallFailed(id, r);
  return r.body as T;
}

/** The Whombat's one agent (OA-01), the fields the scenarios read. */
export interface Agent {
  id: string;
  handle: string;
  name: string;
  runtime?: { provider?: string; credentialSource?: unknown };
}

export interface Workspace {
  burrowId: string;
  slug: string;
  agent: Agent;
  /** The caller's Chat with the agent (OA-04): threaded, private to them; every message in it reaches the agent. */
  conversationId: string;
  mePrincipalId: string;
}

/** The agent (`agent.get`, contracts 0.123.0: one agent, no handle in the path). */
export async function theAgent(s: ApplianceSession, slug: string): Promise<Agent> {
  return (await api<{ agent: Agent }>(s, 'agent.get', 'GET', { params: { burrow: slug } })).agent;
}

/** The caller's Chat with the agent (`chats.list`, the `chat` room). */
export async function chatOf(s: ApplianceSession, slug: string): Promise<string> {
  const { chats } = await api<{ chats: { id: string; default: boolean; room?: string }[] }>(
    s,
    'chats.list',
    'GET',
    { params: { burrow: slug } },
  );
  const chat = chats.find((c) => c.room === 'chat') ?? chats.find((c) => c.default);
  if (!chat) throw new Error(`no Chat with the agent in ${slug}: ${JSON.stringify(chats).slice(0, 300)}`);
  return chat.id;
}

/**
 * This Whombat's burrow with its agent (OA-01: an appliance holds one burrow, so every scenario shares it): the
 * caller's, else made now (named `name`) and onboarded. `provider` puts the agent on that provider (“Set up your AI”).
 */
export async function ensureWorkspace(
  s: ApplianceSession,
  name: string,
  options: { provider?: 'claude' | 'codex' } = {},
): Promise<Workspace> {
  const me = await api<{
    memberships: { burrowId: string; burrowSlug: string; principalId: string }[];
  }>(s, 'me.get', 'GET');
  let mine = me.memberships[0];
  if (!mine) {
    const created = await api<{ burrow: { id: string; slug: string }; me: { id: string } }>(
      s,
      'burrows.create',
      'POST',
      { body: { name } },
    );
    mine = { burrowId: created.burrow.id, burrowSlug: created.burrow.slug, principalId: created.me.id };
  }
  const slug = mine.burrowSlug;
  // Setup left halfway (an earlier run stopped after making the burrow): finish it.
  const onboarding = await api<{ completedAt: string | null }>(s, 'onboarding.get', 'GET', {
    params: { burrow: slug },
  });
  if (!onboarding.completedAt)
    await api(s, 'onboarding.complete', 'POST', {
      params: { burrow: slug },
      body: options.provider ? { provider: options.provider } : {},
    });
  let agent = await theAgent(s, slug);
  if (options.provider && agent.runtime?.provider !== options.provider) {
    await api(s, 'agent.update', 'PATCH', {
      params: { burrow: slug },
      body: { runtime: { provider: options.provider } },
    });
    agent = await theAgent(s, slug);
  }
  return {
    burrowId: mine.burrowId,
    slug,
    agent: { id: agent.id, handle: agent.handle, name: agent.name, runtime: agent.runtime },
    conversationId: await chatOf(s, slug),
    mePrincipalId: mine.principalId,
  };
}

/** A message as `messages.list` and `messages.thread` answer it, the fields the scenarios read. */
export interface ThreadMessage {
  id: string;
  text: string;
  author?: { id: string };
  authorId?: string;
  createdAt?: string;
}

/**
 * The agent's replies to a top-level message: in a person's Chat it answers in the message's thread (Whombat
 * chat-channel.md CHT-02, one-agent.md OA-04).
 */
export async function repliesTo(
  s: ApplianceSession,
  slug: string,
  messageId: string,
  agentId: string,
): Promise<ThreadMessage[]> {
  const thread = await api<{ replies: ThreadMessage[] }>(s, 'messages.thread', 'GET', {
    params: { burrow: slug, messageId },
  });
  return thread.replies.filter((m) => (m.author?.id ?? m.authorId) === agentId);
}

/* Events ------------------------------------------------------------------------------------------------ */

export interface Collected {
  events: SessionEvent[];
  snapshots: { topics: string[]; reason: string }[];
  readies: { resumed: boolean; denied: readonly { topic: string; reason: string }[] }[];
  /** Durable events whose cursor was delivered more than once. */
  duplicateCursors(): string[];
  /** message.created events per message id (a message delivered twice is a duplicate). */
  duplicateMessages(): string[];
  messages(): {
    id: string;
    text: string;
    authorId: string;
    conversationId: string;
    threadRootId?: string | null;
  }[];
  waitFor<T>(
    pred: (e: SessionEvent) => T | null | undefined | false,
    timeoutMs?: number,
    label?: string,
  ): Promise<T>;
  close(): void;
}

export function collect(s: ApplianceSession, topics: string[]): Collected {
  const events: SessionEvent[] = [];
  const snapshots: Collected['snapshots'] = [];
  const readies: Collected['readies'] = [];
  const waiters = new Set<() => void>();
  const sub = s.subscribe(topics, {
    onEvent(e) {
      events.push(e);
      for (const w of [...waiters]) w();
    },
    onSnapshotRequired(info) {
      snapshots.push(info);
      for (const w of [...waiters]) w();
    },
    onReady(info) {
      readies.push(info);
    },
  });
  const msg = (e: SessionEvent) => {
    const ev = e.event as { type?: string; message?: Record<string, unknown> };
    return ev.type === 'message.created' ? ev.message : null;
  };
  return {
    events,
    snapshots,
    readies,
    duplicateCursors() {
      const seen = new Map<string, number>();
      for (const e of events)
        if (e.cursor) seen.set(`${e.topic}@${e.cursor}`, (seen.get(`${e.topic}@${e.cursor}`) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    },
    duplicateMessages() {
      const seen = new Map<string, number>();
      for (const e of events) {
        const m = msg(e);
        if (m) seen.set(String(m.id), (seen.get(String(m.id)) ?? 0) + 1);
      }
      return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    },
    messages() {
      return events
        .map(msg)
        .filter((m): m is Record<string, unknown> => !!m)
        .map((m) => ({
          id: String(m.id),
          text: String(m.text ?? ''),
          authorId: String((m.author as { id?: string } | undefined)?.id ?? m.authorId ?? ''),
          conversationId: String(m.conversationId ?? ''),
          threadRootId: (m.threadRootId as string | null | undefined) ?? null,
        }));
    },
    waitFor<T>(pred: (e: SessionEvent) => T | null | undefined | false, timeoutMs = 30_000, label = 'event') {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          for (const e of events) {
            const v = pred(e);
            if (v) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(v);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `${label}: not seen within ${timeoutMs} ms (${events.length} events: ${events.map((e) => (e.event as { type: string }).type).join(', ')})`,
            ),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: () => sub.close(),
  };
}

export const eventType = (e: SessionEvent) => (e.event as { type?: string }).type ?? '';

/* Automation with an approval --------------------------------------------------------------------------- */

export interface ApprovalAutomation {
  id: string;
}

/**
 * A manual automation in the caller's Chat: ask the agent (scripted: a deterministic reply; no agent named, OA-15), ask
 * the person to approve, then post the result. Imported, then published with the reviewed draft hash.
 */
export async function createApprovalAutomation(
  s: ApplianceSession,
  w: Workspace,
  marker: string,
): Promise<ApprovalAutomation> {
  const definition = {
    version: AUTOMATION_DEFINITION_VERSION,
    conversationId: w.conversationId,
    triggers: [{ kind: 'manual' }],
    steps: [
      {
        id: 'ask',
        kind: 'dispatch_agent',
        prompt: `Summarize the release notes for ${marker}.`,
      },
      {
        id: 'approve',
        kind: 'request_approval',
        title: `Publish the summary for ${marker}`,
        details: `Posts the agent's summary for ${marker} in the Chat.`,
      },
      { id: 'post', kind: 'post_message', text: `Approved and published: ${marker}` },
    ],
  };
  const created = await api<{ automation: { id: string } }>(s, 'automations.create', 'POST', {
    params: { burrow: w.slug },
    body: {
      name: `Harness ${marker}`.slice(0, 80),
      source: {
        kind: 'import',
        file: { whombat: 'automation', name: `Harness ${marker}`.slice(0, 80), description: '', definition },
      },
    },
  });
  const detail = await api<{ automation: { id: string; draftHash?: string | null }; problems?: unknown }>(
    s,
    'automations.get',
    'GET',
    { params: { burrow: w.slug, id: created.automation.id } },
  );
  const hash = detail.automation.draftHash;
  if (!hash)
    throw new Error(`automation draft has no hash (problems: ${JSON.stringify(detail).slice(0, 600)})`);
  await api(s, 'automations.publish', 'POST', {
    params: { burrow: w.slug, id: created.automation.id },
    body: { enable: true, definitionHash: hash },
  });
  return { id: created.automation.id };
}
