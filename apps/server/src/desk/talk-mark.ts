/**
 * The mark of a desk question (desk-display-talk.md DK-T05, DK-T13), apart from Talk itself so the context builder and
 * the notifications read it without loading Talk. The person's question carries the client id `desk:<talk>:v` (spoken)
 * or `:t` (typed): the turn it wakes gets `DispatchContext.desk`, and while the person reads the unlocked desk screen the
 * assistant's replies in that thread don't push to their phone.
 */
import type { DeskDispatchContext, DispatchContext, Message } from '@whombat/core';
import type { DeskTalkHost } from './talk';

const DESK_CLIENT_RE = /^desk:(dtk_[A-Za-z0-9_-]{1,40}):([vt])$/;

/**
 * The client id of a desk question (≤ 64): the talk and whether it was spoken. It marks the person's message for the turn
 * it wakes (`deskTurnOf`), as an Undo's does (home-redesign.md HR-03), and makes a retry of the same post one message.
 */
export function deskClientId(talkId: string, spoken: boolean): string {
  return `desk:${talkId}:${spoken ? 'v' : 't'}`;
}

/** The desk talk a question was asked in (by its client id, `desk:<talk>:v|t`), or null. */
export function deskTalkIdOf(clientId: string | null | undefined): string | null {
  return DESK_CLIENT_RE.exec(clientId ?? '')?.[1] ?? null;
}

/** Whether a message is a question asked at the desk screen (by its client id). */
export function isDeskQuestion(message: Pick<Message, 'clientId'>): boolean {
  return DESK_CLIENT_RE.test(message.clientId ?? '');
}

/** The server a desk question was asked about (DK-85): its id and its name as the screen showed it. */
export interface DeskTalkServer {
  id: string;
  name: string;
}

/** How many talks' servers are kept (memory only; a turn is claimed within moments of its question). */
const TALK_SERVERS_KEPT = 50;
const talkServers = new WeakMap<object, Map<string, DeskTalkServer>>();

/**
 * Keeps which server a desk question is about, by its talk (DK-85, DK-S89), for the turn it wakes: its context says so
 * to the assistant (`deskTurnOf`), never the chat. The latest `TALK_SERVERS_KEPT` per runtime; a restart forgets them,
 * and that turn then answers without it.
 */
export function rememberTalkServer(services: object, talkId: string, server: DeskTalkServer): void {
  let kept = talkServers.get(services);
  if (!kept) {
    kept = new Map();
    talkServers.set(services, kept);
  }
  kept.delete(talkId);
  kept.set(talkId, { id: server.id, name: server.name });
  for (const old of kept.keys()) {
    if (kept.size <= TALK_SERVERS_KEPT) break;
    kept.delete(old);
  }
}

/** The server a desk talk was asked about, or null. */
export function talkServerOf(services: object, talkId: string): DeskTalkServer | null {
  return talkServers.get(services)?.get(talkId) ?? null;
}

/**
 * `DispatchContext.desk` of a turn (DK-T05): the person's message that woke it was asked at the desk screen — spoken or
 * typed there — and, when they asked from a server's screen, which server (DK-85). Null for anything else.
 */
export function deskTurnOf(
  row: { trigger: string },
  trigger: Pick<Message, 'clientId'> | null,
  services?: object,
): DeskDispatchContext | null {
  if (!trigger || (row.trigger !== 'dm' && row.trigger !== 'mention')) return null;
  const m = DESK_CLIENT_RE.exec(trigger.clientId ?? '');
  if (!m) return null;
  const server = services && m[1] ? talkServerOf(services, m[1]) : null;
  return { spoken: m[2] === 'v', ...(server ? { server } : {}) };
}

/** `{desk}` for the dispatch context, or nothing (absent: not a desk question). */
export function deskContextPart(
  row: { trigger: string },
  trigger: Pick<Message, 'clientId'> | null,
  services?: object,
): Pick<DispatchContext, 'desk'> {
  const desk = deskTurnOf(row, trigger, services);
  return desk ? { desk } : {};
}

/* Who reads the screen now (DK-T13) -------------------------------------------------------------------------------- */

const screens = new WeakMap<object, Pick<DeskTalkHost, 'place' | 'unlocked'>>();

/**
 * The desk screen of these services (one per `Services`, set by `createDeskTalk`): who it is paired with and whether
 * it is unlocked. `null` takes it away again (only `expected`'s, when given).
 */
export function setDeskScreen(
  services: object,
  host: Pick<DeskTalkHost, 'place' | 'unlocked'> | null,
  expected?: Pick<DeskTalkHost, 'place' | 'unlocked'>,
): void {
  if (host) screens.set(services, host);
  else if (!expected || screens.get(services) === expected) screens.delete(services);
}

/** Whether this person reads the desk screen now: it is paired with them and unlocked. No screen, or no answer: no. */
export async function deskScreenShowsTo(services: object, personId: string): Promise<boolean> {
  const screen = screens.get(services);
  if (!screen) return false;
  try {
    const place = await screen.place();
    return place?.personId === personId && (await screen.unlocked());
  } catch {
    return false;
  }
}

/**
 * The person whose push a message holds back (DK-T13): the assistant's message in the thread of that person's own desk
 * question, while their desk screen is unlocked — they read it there. Null: the usual rules (also once the screen locks).
 */
export async function deskReaderOf(
  services: object,
  message: { authorKind: 'person' | 'agent'; root: Pick<Message, 'authorId' | 'clientId'> | null },
): Promise<string | null> {
  const root = message.root;
  if (message.authorKind !== 'agent' || !root || !isDeskQuestion(root)) return null;
  return (await deskScreenShowsTo(services, root.authorId)) ? root.authorId : null;
}
