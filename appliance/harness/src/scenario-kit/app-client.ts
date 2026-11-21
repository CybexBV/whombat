/**
 * The real `@whombat/client` session (whombat-app `packages/client/src/session`) as the scenarios use it
 * (IN-12): `createManagedConnector` (control ticket → relay WebSocket → `@whombat/secure-channel` Noise initiator
 * pinned to the appliance) under `createSecureSession` (session protocol v1). The module is loaded from the
 * whombat-app checkout the environment runs (`env.json` sources, i.e. the manifest's pinned commit), through the
 * vitest alias `@app-client/session`; nothing of the client is re-implemented here. The types below are the
 * subset the scenarios use (structural; checked at runtime by `assertClientShape`).
 */
// @ts-expect-error resolved by the vitest alias to the pinned whombat-app checkout
import * as clientModule from '@app-client/session';
import { generateIdentity, type Identity } from '@whombat/secure-channel';

export type DisconnectReason = string;
export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; attempt: number }
  | { status: 'open'; info: SessionInfo }
  | { status: 'reconnecting'; attempt: number; reason: DisconnectReason; retryAt: number }
  | { status: 'closed'; reason: DisconnectReason; detail?: string };

export interface SessionInfo {
  protocol: { major: number; minor: number };
  capabilities: readonly string[];
  appliance: { id: string; name: string | null };
  account: {
    id: string;
    name: string;
    principals: readonly { burrowId: string; principalId: string }[];
  } | null;
  endpointId: string | null;
  authzGeneration: number;
  clearCache: boolean;
  channel: 'app' | 'enroll';
}

export interface OperationResponse {
  status: number;
  body: unknown;
  requestId: string;
}

export interface CallOptions {
  requestId?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  onProgress?: (state: 'accepted' | 'executing') => void;
}

export interface SessionEvent {
  topic: string;
  event: unknown;
  at: string;
  cursor: string | null;
}

export interface ApplianceSession {
  state(): ConnectionState;
  onState(listener: (s: ConnectionState) => void): () => void;
  onNotice(listener: (n: { kind: string; [k: string]: unknown }) => void): () => void;
  connect(): void;
  reconnectNow(): void;
  close(reason?: DisconnectReason): void;
  supports(capability: string): boolean;
  call(
    endpoint: { id: string; method: string },
    input: { params: Record<string, unknown>; query: Record<string, unknown>; body: unknown },
    options?: CallOptions,
  ): Promise<OperationResponse>;
  invoke(
    op: string,
    input: unknown,
    options?: CallOptions & { mutating?: boolean },
  ): Promise<OperationResponse>;
  status(
    requestId: string,
    endpoint: { id: string; method: string },
  ): Promise<{ state: string; response?: OperationResponse }>;
  subscribe(
    topics: readonly string[],
    handlers: {
      onEvent(e: SessionEvent): void;
      onSnapshotRequired(info: { topics: string[]; reason: string }): void;
      onReady?(info: { resumed: boolean; denied: readonly { topic: string; reason: string }[] }): void;
    },
  ): { setTopics(t: readonly string[]): void; close(): void };
}

export interface RelaySocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // biome-ignore lint/suspicious/noExplicitAny: DOM/ws event shapes
  addEventListener(type: string, listener: (event: any) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: DOM/ws event shapes
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface ClientModule {
  createSecureSession(options: Record<string, unknown>): ApplianceSession;
  createManagedConnector(options: Record<string, unknown>): {
    connect(r: { class: string; signal: AbortSignal }): Promise<unknown>;
  };
  /** whombat-app ≥ 1.0 (contracts 1.0.0 CT-1250…CT-1252): the direct connection, straight to the box. */
  createDirectConnector?: (options: Record<string, unknown>) => {
    connect(r: { class: string; signal: AbortSignal }): Promise<unknown>;
  };
  secureChannelPort?: () => unknown;
  sessionOps: Record<string, (s: ApplianceSession, ...args: never[]) => Promise<unknown>>;
  TicketDeniedError: new (m: string) => Error;
  OperationError: new (...a: never[]) => Error & { code: string; status: number; details?: unknown };
}

const mod = clientModule as unknown as ClientModule;

// secureChannelPort lives in `session/secure-channel.ts` (a separate subpath); the alias maps it too.
// @ts-expect-error resolved by the vitest alias to the pinned whombat-app checkout
import * as secureChannelModule from '@app-client/secure-channel';

const port = (secureChannelModule as { secureChannelPort: () => unknown }).secureChannelPort;

export function assertClientShape(): void {
  for (const k of [
    'createSecureSession',
    'createManagedConnector',
    'sessionOps',
    'TicketDeniedError',
  ] as const)
    if (!(k in mod))
      throw new Error(
        `@whombat/client/session lacks ${k}: the pinned whombat-app commit does not match the harness`,
      );
  if (typeof port !== 'function') throw new Error('@whombat/client/secure-channel lacks secureChannelPort');
}

export const sessionOps = mod.sessionOps as unknown as {
  claim(
    s: ApplianceSession,
    input: {
      claimSecret: string;
      account: { name: string; email: string };
      endpoint: { label: string; platform: string };
    } & Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** The claim on the box's own page (contracts 1.1.0, CT-1302): the box's claim id for this device key. */
  claimLocalStart(
    s: ApplianceSession,
    input: { link?: string },
  ): Promise<{ claimId: string; expiresAt: string }>;
  recoveryKitRegister(s: ApplianceSession, recoveryPublicKey: string): Promise<Record<string, unknown>>;
  recoveryKitConfirm(
    s: ApplianceSession,
    input: { kitId: string; signature: string },
  ): Promise<Record<string, unknown>>;
  applianceStatus(s: ApplianceSession): Promise<Record<string, unknown>>;
  endpointsList(s: ApplianceSession): Promise<{ endpoints: Record<string, unknown>[] }>;
  endpointsRevoke(s: ApplianceSession, endpointId: string): Promise<Record<string, unknown>>;
  endpointsRename(
    s: ApplianceSession,
    input: { endpointId: string; label: string },
  ): Promise<Record<string, unknown>>;
  pairRequest(s: ApplianceSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  pairApprove(s: ApplianceSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  pairStatus(s: ApplianceSession, pairingId: string): Promise<Record<string, unknown>>;
  /** Contracts ≥ 0.5.2 (CT-46): which device a code belongs to; approval needs its fingerprint. */
  pairLookup(s: ApplianceSession, code: string): Promise<Record<string, unknown>>;
  /** Contracts ≥ 0.5.2 (CT-49): a notification tap's ref → the caller's own inbox item. */
  pushResolve(s: ApplianceSession, ref: string): Promise<Record<string, unknown>>;
  pushHandlesSet(s: ApplianceSession, handle: string): Promise<Record<string, unknown>>;
  /** Recovery ceremony (CT-45): a statement signed by the recovery key enrolls this endpoint as the kit's person. */
  recoveryEnroll(s: ApplianceSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Contracts ≥ 0.5.3 (CT-52): diagnostic bundles (downloads are export streams). */
  diagnosticsCreate(s: ApplianceSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  diagnosticsPreview(s: ApplianceSession, bundleId: string): Promise<Record<string, unknown>>;
  diagnosticsList(s: ApplianceSession): Promise<Record<string, unknown>>;
  diagnosticsDelete(s: ApplianceSession, bundleId: string): Promise<Record<string, unknown>>;
};

/** One skill an import preview found (`SkillImportItem`, the fields the scenarios read). */
export interface SkillImportItem {
  name: string;
  description: string;
  group: string;
  verdict: string;
  clash: string;
  selectable: boolean;
  selected: boolean;
  notes: string[];
}

/**
 * Contracts ≥ 0.113.0 (CT-817; app skill-store.md AP-4102): the client's Add skills from an archive over the session
 * (`session/skillArchive.ts`): hashed, staged (`skills.stage`), uploaded through the resumable upload stream (target
 * `skill-archive`) and previewed (`skills.importPreview {stagedArchiveId}`; since 0.125 an export op the client reads
 * through an export stream, CT-1217). Nothing is added until `skills.importCommit`. Packs and their import
 * (`packs.stage`, `pack-archive`) are gone (Whombat skill-store.md SST-09).
 */
export const skillImports = mod as unknown as {
  importSkillArchive(
    s: ApplianceSession,
    burrow: string,
    source: { name: string; type: string; size: number; read(o: number, n: number): Promise<Uint8Array> },
  ): Promise<{
    status: string;
    data?: { importId: string; source: string; items: SkillImportItem[]; notes: string[]; expiresAt: string };
  }>;
};

/** An export stream (`openResource({kind: 'export', op, input})`), read whole. */
export async function readExport(
  s: ApplianceSession,
  op: string,
  input: unknown,
): Promise<{ bytes: Uint8Array; meta: Record<string, unknown> }> {
  const r = await (
    s as unknown as {
      openResource(
        ref: unknown,
      ): Promise<{ meta: Record<string, unknown>; chunks: AsyncIterable<Uint8Array> }>;
    }
  ).openResource({ kind: 'export', op, input });
  const parts: Uint8Array[] = [];
  for await (const c of r.chunks) parts.push(c);
  return { bytes: new Uint8Array(Buffer.concat(parts)), meta: r.meta };
}
export const OperationError = mod.OperationError;
export const TicketDeniedError = mod.TicketDeniedError;

export interface Ticket {
  ticket: string;
  relayUrl: string;
}

export interface ClientOptions {
  /** Control-issued tickets (or a hostile source); called per connection. */
  tickets: (r: { channel: 'app' | 'enroll'; class: 'interactive' | 'bulk' }) => Promise<Ticket>;
  identity: Identity;
  /** Pin: full PeerId or claim-card fingerprint. */
  appliance: { peerId: string } | { fingerprint: string };
  channel: 'app' | 'enroll';
  expect?: 'app' | 'any';
  /** Wraps each relay socket (to kill it mid-stream, count bytes, …). */
  onSocket?: (s: RelaySocket) => void;
  build?: string;
  /** `hello.client.buildNumber` (contracts ≥ 0.5.3, CT-53); absent counts as 0. */
  buildNumber?: number;
  platform?: 'web' | 'android' | 'ios' | 'desktop' | 'cli';
  deadlineMs?: number;
  backoff?: { baseMs?: number; maxMs?: number };
  statusPollMs?: number;
  /** `hello.cachedAccountId` + `cachedAuthzGeneration` (CT-47); default: the previous connection's welcome. */
  cached?: () => { accountId: string; authzGeneration: number } | undefined;
}

export function newEndpointIdentity(): Promise<Identity> {
  return generateIdentity();
}

/** A real secure session (Node's global WebSocket, like a browser). */
export function openSession(o: ClientOptions): ApplianceSession {
  assertClientShape();
  const connector = mod.createManagedConnector({
    tickets: o.tickets,
    secure: port(),
    identity: async () => o.identity,
    appliance: o.appliance,
    channel: o.channel,
    socket: (url: string, protocol: string) => {
      const s = new WebSocket(url, protocol) as unknown as RelaySocket;
      o.onSocket?.(s);
      return s;
    },
    dialTimeoutMs: 10_000,
  });
  const session = mod.createSecureSession({
    connector,
    client: {
      build: o.build ?? 'whombat-integration-harness',
      platform: o.platform ?? 'cli',
      ...(o.buildNumber !== undefined ? { buildNumber: o.buildNumber } : {}),
    },
    expect: o.expect ?? (o.channel === 'enroll' ? 'any' : 'app'),
    ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}),
    ...(o.backoff ? { backoff: o.backoff } : {}),
    ...(o.statusPollMs ? { statusPollMs: o.statusPollMs } : {}),
    ...(o.cached ? { cached: o.cached } : {}),
  });
  return session;
}

/** Whether the pinned whombat-app has the direct connector (whombat-app ≥ 1.0). */
export function hasDirectConnector(): boolean {
  return typeof mod.createDirectConnector === 'function';
}

export interface DirectClientOptions {
  /** The box's direct socket: `ws://127.0.0.1:<port>/v1/direct` on the dev stack (IN-419, `directSocketUrl`). */
  url: string;
  identity: Identity;
  /** Pin: the box's full PeerId. */
  appliance: { peerId: string };
  /** `app` (default): only an app-channel session counts as open; `any`: the enrollment channel too. */
  expect?: 'app' | 'any';
  /** Wraps each direct socket (to count, kill, …). */
  onSocket?: (s: RelaySocket) => void;
  build?: string;
  platform?: 'web' | 'android' | 'ios' | 'desktop' | 'cli';
  deadlineMs?: number;
  backoff?: { baseMs?: number; maxMs?: number };
}

/**
 * A real secure session over the direct connection (Whombat HE-50; the client's `createDirectConnector`): a WebSocket
 * straight to the box's direct listener, `hello` → `welcome`, then the same Noise XX pinned to the box and the same
 * session frames as through the relay. No ticket, no control, no relay: the box admits by the endpoint's key.
 */
export function openDirectSession(o: DirectClientOptions): ApplianceSession {
  assertClientShape();
  if (!mod.createDirectConnector)
    throw new Error(
      '@whombat/client/session lacks createDirectConnector: the pinned whombat-app is older than 1.0',
    );
  const web = o.url.replace(/^ws/, 'http').replace(/\/v1\/direct$/, '/');
  const connector = mod.createDirectConnector({
    routes: () => [{ way: 'lan', socket: o.url, web }],
    secure: port(),
    identity: async () => o.identity,
    appliance: o.appliance,
    socket: (url: string, protocol: string) => {
      const s = new WebSocket(url, protocol) as unknown as RelaySocket;
      o.onSocket?.(s);
      return s;
    },
    dialTimeoutMs: 5_000,
  });
  return mod.createSecureSession({
    connector,
    client: { build: o.build ?? 'whombat-integration-harness', platform: o.platform ?? 'cli' },
    expect: o.expect ?? 'app',
    ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}),
    ...(o.backoff ? { backoff: o.backoff } : {}),
  });
}

/** Resolves when the session is open (or rejects when it closes / times out). */
export function whenOpen(s: ApplianceSession, timeoutMs = 20_000): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const cur = s.state();
    if (cur.status === 'open') return resolve(cur.info);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`session not open after ${timeoutMs} ms (state ${JSON.stringify(s.state())})`));
    }, timeoutMs);
    const off = s.onState((st) => {
      if (st.status === 'open') {
        clearTimeout(timer);
        off();
        resolve(st.info);
      } else if (st.status === 'closed') {
        clearTimeout(timer);
        off();
        reject(
          Object.assign(new Error(`session closed: ${st.reason}${st.detail ? ` (${st.detail})` : ''}`), {
            reason: st.reason,
          }),
        );
      }
    });
    s.connect();
  });
}

/** Resolves with the terminal/next non-open state reason. */
export function whenState(
  s: ApplianceSession,
  pred: (st: ConnectionState) => boolean,
  timeoutMs = 20_000,
): Promise<ConnectionState> {
  return new Promise((resolve, reject) => {
    if (pred(s.state())) return resolve(s.state());
    const timer = setTimeout(() => {
      off();
      reject(new Error(`state not reached after ${timeoutMs} ms (now ${JSON.stringify(s.state())})`));
    }, timeoutMs);
    const off = s.onState((st) => {
      if (pred(st)) {
        clearTimeout(timer);
        off();
        resolve(st);
      }
    });
  });
}
