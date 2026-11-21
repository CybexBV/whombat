/**
 * The cloud session at start (AP-920…AP-922). The app used to show a spinner until control answered `auth.session`
 * (no timeout; offline it ended at “Couldn’t reach Whombat”, so the burrow kept on the phone was never shown). Now the
 * last session seen signed in is kept in the secure store, and the signed-in app opens with it at once while control
 * is asked in the background: its session replaces the kept one, a definite signed-out (no token, or control refused
 * it) signs out, and no answer (offline, a timeout, control down) keeps what is shown. Without a kept session the
 * spinner gives way to “Couldn’t reach Whombat” after `SESSION_CHECK_TIMEOUT_MS`; an answer after that still counts.
 *
 * What is kept is what the screens show: the account (id, email, name) and its organizations (id, name) — never
 * the token or anything secret. The token sits next to it in the same keystore; the kept session admits nothing by
 * itself (a Whombat needs this phone's key and its enrollment there, the relay needs control's ticket), and sign-out,
 * a definite signed-out and deleting the account forget it.
 *
 * Pure: the secure store and the answer are passed in.
 */
import type { ControlOrg, ControlSession } from '@whombat/client/managed';
import type { SecretStore } from './keys';

export const CLOUD_SESSION_KEY = 'whombat.cloud-session';
/** Without a kept session, the spinner waits this long for control before saying it couldn't reach it. */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;
/** expo-secure-store's limit for one value (iOS): a larger session isn't kept. */
const MAX_CHARS = 2048;

/** Only what the screens show: the account and its organizations, field by field. */
export function keptSession(s: ControlSession): ControlSession {
  return {
    account: { accountId: s.account.accountId, email: s.account.email, name: s.account.name },
    orgs: s.orgs.map((o) => ({ orgId: o.orgId, name: o.name })),
  };
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A kept session as it was written; anything else (another format, damaged) is none. */
export function parseKeptSession(raw: string | null): ControlSession | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const s = v as Partial<ControlSession> | null;
  const a = s?.account;
  if (!a || !text(a.accountId) || !text(a.email) || !(a.name === null || typeof a.name === 'string'))
    return null;
  if (!Array.isArray(s?.orgs)) return null;
  const orgs: ControlOrg[] = [];
  for (const o of s.orgs as Partial<ControlOrg>[]) {
    if (!o || !text(o.orgId) || typeof o.name !== 'string') return null;
    orgs.push({ orgId: o.orgId, name: o.name });
  }
  return { account: { accountId: a.accountId, email: a.email, name: a.name }, orgs };
}

export interface CloudSessionStore {
  /** The kept session, or null (none, or the keystore refused). */
  get(): Promise<ControlSession | null>;
  /** Keeps this session for the next start (written only when it changed). */
  set(session: ControlSession): Promise<void>;
  clear(): Promise<void>;
}

/** The kept session in the secure store. Never fails: a keystore that refuses keeps nothing. */
export function cloudSessionStore(store: SecretStore): CloudSessionStore {
  /** What the store holds as far as this run knows; undefined: not known. */
  let held: string | null | undefined;
  const clear = async () => {
    if (held === null) return;
    held = null;
    await store.remove(CLOUD_SESSION_KEY).catch(() => {
      held = undefined;
    });
  };
  return {
    async get() {
      const raw = await store.get(CLOUD_SESSION_KEY).catch(() => undefined);
      if (raw === undefined) return null;
      held = raw;
      return parseKeptSession(raw);
    },
    async set(session) {
      const json = JSON.stringify(keptSession(session));
      if (json === held) return;
      if (json.length > MAX_CHARS) return clear();
      held = json;
      await store.set(CLOUD_SESSION_KEY, json).catch(() => {
        held = undefined;
      });
    },
    clear,
  };
}

/**
 * Waits for control's answer about the session: `answered` with it (also after the timeout), `unreachable` once when it
 * fails or takes longer than `timeoutMs`. Returns a function that stops listening.
 */
export function awaitSession(
  answer: Promise<ControlSession | null>,
  on: { answered(session: ControlSession | null): void; unreachable(): void },
  timeoutMs: number = SESSION_CHECK_TIMEOUT_MS,
): () => void {
  let live = true;
  let late = false;
  const unreachable = () => {
    if (!live || late) return;
    late = true;
    on.unreachable();
  };
  const timer = setTimeout(unreachable, timeoutMs);
  answer.then(
    (session) => {
      clearTimeout(timer);
      if (live) on.answered(session);
    },
    () => {
      clearTimeout(timer);
      unreachable();
    },
  );
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
