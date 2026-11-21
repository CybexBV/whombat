/**
 * The box's network and Wi-Fi (docs/decisions/hardware-support.md HD-05…HD-07, HD-10; hardware-support-server.md
 * HD-S04…): the manager knows the cable, the Wi-Fi card iwd sees and whether the box reached Whombat in its last check,
 * and runs every change under its guard (a join the box can't reach Whombat on is undone after 2 minutes). The runtime
 * asks it for the person (`host.network`, `host.wifi.*`) and for the box's screen (`desk/network.ts`), and records each
 * change the manager accepted as one signed event in the appliance's audit chain — never the passphrase.
 *
 * Reads never throw: a manager that doesn't answer (2 s; a scan 15 s), answers 404 (before 0.102) or answers what the
 * contract doesn't allow is `unavailable`, logged at most once a minute. Changes throw `HostNetworkError`.
 *
 * Wi-Fi only and the cable again (network-move.md NM-01…NM-05; network-move-server.md) are a guarded change too
 * (`host.cable.set`): the servers are asked to move to the address the box keeps before the cable goes, and after the
 * cable is back (`ServerMoves`), and `host.network` says how far they got.
 */
import {
  CableSetRequest,
  MANAGER_PATHS,
  WifiForgetRequest,
  WifiJoinRequest,
} from '@whombat/control-contracts/local';
import {
  CABLE_ERROR_CODES,
  CABLE_ERROR_STATUS,
  type CableAuditPayload,
  type CableChange,
  type CableErrorCode,
  type HostCableSetInput,
  type HostNetwork,
  type HostNetworkOutput,
  type HostWifiForgetInput,
  type HostWifiJoinInput,
  type HostWifiScanOutput,
  type NetworkAuditPayload,
  type NetworkChange,
  networkChangeDone,
  ssidValid,
  WIFI_ERROR_CODES,
  WIFI_ERROR_STATUS,
  type WifiErrorCode,
} from '@whombat/protocol/session';
import { externalEffect } from '../commit/scope';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { ManagerWarnings, managerRefusedChange, withinMs } from './host-calls';
import { HOST_STATE_TIMEOUT_MS, HOST_WIFI_TIMEOUT_MS } from './manager-client';
import { ServerMoves } from './network-move-service';
import { ManagerCallError, type ManagerPort } from './ports';
import { SessionOpError } from './session-error';
import type { SessionPrincipal } from './trust';

/** HD-06: a join that leaves the box unable to reach Whombat (when it could before) is undone after 2 minutes. */
export const WIFI_CONFIRM_TIMEOUT_S = 120;

/** Who changes the Wi-Fi: the person in the app (their account and device), or someone at the box's screen. */
export type NetworkActor = { via: 'app'; accountId: string; endpointId: string | null } | { via: 'screen' };

export type HostNetworkRefusal = WifiErrorCode | CableErrorCode | 'unavailable';

/** Fallback words for a refusal; the app and the console make their own from the code (HD-11). */
const REFUSALS: Readonly<Record<HostNetworkRefusal, string>> = {
  no_wifi: 'This Whombat has no Wi-Fi.',
  busy: 'A network change is still running. Try again when it’s done.',
  in_use: 'Whombat needs this network: it has no other connection.',
  not_saved: 'That network isn’t saved.',
  invalid_passphrase: 'A Wi-Fi password has 8 to 63 characters.',
  not_connected: 'The Wi-Fi isn’t on a network yet.',
  no_cable: 'No cable is plugged in.',
  unchanged: 'It already uses that.',
  unavailable: 'Whombat couldn’t change the Wi-Fi just now. Try again in a moment.',
};

/** A change the manager refused or didn't answer: the session op and the desk socket answer with `code`. */
export class HostNetworkError extends Error {
  constructor(
    readonly code: HostNetworkRefusal,
    message = REFUSALS[code],
  ) {
    super(message);
    this.name = 'HostNetworkError';
  }
}

const isKnownCode = (code: string): code is WifiErrorCode | CableErrorCode =>
  (WIFI_ERROR_CODES as readonly string[]).includes(code) ||
  (CABLE_ERROR_CODES as readonly string[]).includes(code);

/** A manager's refusal as the session sees it: its own code, else `unavailable` (an older manager's 404 too). */
function refusalOf(err: unknown, what: 'wifi' | 'cable' = 'wifi'): HostNetworkError {
  if (err instanceof HostNetworkError) return err;
  if (err instanceof ManagerCallError && isKnownCode(err.code)) return new HostNetworkError(err.code);
  if (err instanceof ManagerCallError && err.status === 404)
    return new HostNetworkError(
      'unavailable',
      what === 'cable'
        ? 'This Whombat can’t switch its cable off yet. It needs an update.'
        : 'This Whombat can’t change its Wi-Fi yet. It needs an update.',
    );
  return new HostNetworkError('unavailable');
}

/**
 * One change the manager took, as the audit chain records it (`network.wifi_joined` / `network.wifi_forgotten`, and
 * `network.cable_set` for Wi-Fi only or the cable again).
 */
export type NetworkRecord = {
  actorAccountId: string | null;
  endpointId: string | null;
  at: Date;
} & (
  | { kind: 'join' | 'forget'; payload: NetworkAuditPayload }
  | { kind: 'cable'; payload: CableAuditPayload }
);

const RECORD_TYPES = {
  join: 'network.wifi_joined',
  forget: 'network.wifi_forgotten',
  cable: 'network.cable_set',
} as const;

/** Appends the record to the appliance's audit chain, in its own transaction (HD-S06). */
export function applianceNetworkRecorder(services: Services): (record: NetworkRecord) => Promise<void> {
  return (record) =>
    services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, services.custody, {
        type: RECORD_TYPES[record.kind],
        actorAccountId: record.actorAccountId,
        endpointId: record.endpointId,
        payload: record.payload,
        at: record.at,
      });
    });
}

export class HostNetworkService {
  readonly #stateWarnings: ManagerWarnings;
  readonly #scanWarnings: ManagerWarnings;
  readonly #changeWarnings: ManagerWarnings;
  readonly #record: (record: NetworkRecord) => Promise<void>;
  /** The servers following the box's address (network-move.md NM-05, NM-07). */
  readonly moves: ServerMoves;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    /** Where a change is recorded (the appliance chain; tests look). */
    record?: (record: NetworkRecord) => Promise<void>,
  ) {
    this.#record = record ?? applianceNetworkRecorder(services);
    this.moves = new ServerMoves(services, () => this.state());
    this.#stateWarnings = new ManagerWarnings(services, 'network state');
    this.#scanWarnings = new ManagerWarnings(services, 'wifi scan');
    this.#changeWarnings = new ManagerWarnings(services, 'wifi change');
  }

  /** The network now, or null when the manager doesn't tell. Never throws. */
  async state(): Promise<HostNetwork | null> {
    try {
      const answer = await withinMs(
        this.manager.networkState(),
        HOST_STATE_TIMEOUT_MS,
        MANAGER_PATHS.networkState,
      );
      return answer.network;
    } catch (err) {
      this.#stateWarnings.warn(err);
      return null;
    }
  }

  /** `host.network`: the network, and the servers following the box's address while they do (NM-07). */
  async read(): Promise<HostNetworkOutput> {
    const state = this.state();
    const [network, move] = await Promise.all([state, this.moves.progress(state).catch(() => null)]);
    const out: HostNetworkOutput = network ? { network } : { network: null, reason: 'unavailable' };
    if (move) out.move = move;
    return out;
  }

  /** The networks in reach; `no_wifi` when the box has no Wi-Fi card iwd can use. Never throws. */
  async scan(): Promise<HostWifiScanOutput> {
    try {
      const answer = await withinMs(this.manager.wifiScan(), HOST_WIFI_TIMEOUT_MS, MANAGER_PATHS.wifiScan);
      return { scan: answer.scan };
    } catch (err) {
      if (err instanceof ManagerCallError && err.code === 'no_wifi') return { scan: null, reason: 'no_wifi' };
      this.#scanWarnings.warn(err);
      return { scan: null, reason: 'unavailable' };
    }
  }

  /**
   * Joins a network under the guard (HD-06): answers the change as the manager started it, and records it. A wrong
   * password fails in the change (`failure: wrong_password`), not here.
   */
  async join(input: HostWifiJoinInput, by: NetworkActor): Promise<NetworkChange> {
    if (!ssidValid(input.ssid)) throw notAName();
    const body = WifiJoinRequest.safeParse({
      v: 1,
      ssid: input.ssid,
      ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      confirmTimeoutSec: WIFI_CONFIRM_TIMEOUT_S,
    });
    if (!body.success) throw invalidInput(body.error.issues);
    return this.#change('join', input.ssid, by, () => this.manager.wifiJoin(body.data));
  }

  /** Forgets a saved network (HD-06): `in_use` while the box has nothing else that works. */
  async forget(input: HostWifiForgetInput, by: NetworkActor): Promise<NetworkChange> {
    if (!ssidValid(input.ssid)) throw notAName();
    const body = WifiForgetRequest.safeParse({ v: 1, ssid: input.ssid });
    if (!body.success) throw invalidInput(body.error.issues);
    return this.#change('forget', input.ssid, by, () => this.manager.wifiForget(body.data));
  }

  /**
   * Wi-Fi only, or the cable again, under the guard (NM-01, NM-02). Wi-Fi only asks the servers to move to the Wi-Fi's
   * address first (NM-05; a hosts service that can't doesn't stop the switch); the cable again is followed until it is
   * done and then the servers are asked to move to the cable's address. Recorded as `network.cable_set`.
   */
  async cable(input: HostCableSetInput, by: NetworkActor & { via: 'app' }): Promise<CableChange> {
    const body = CableSetRequest.safeParse({
      v: 1,
      use: input.use,
      confirmTimeoutSec: WIFI_CONFIRM_TIMEOUT_S,
    });
    if (!body.success) throw new ApiError('bad_request', 'Choose Wi-Fi only or the cable.');
    const before = await this.state();
    // The servers move first (NM-05), unless the manager is sure to refuse: a change running, Wi-Fi only already on.
    const runs = (c: { phase: NetworkChange['phase'] } | null | undefined) =>
      !!c && !networkChangeDone(c.phase);
    const refused =
      before !== null && (before.wifiOnly === true || runs(before.change) || runs(before.cableChange));
    const asked = input.use === 'wifi' && !refused ? await this.moves.beforeWifiOnly(before) : null;
    let change: CableChange;
    try {
      // As a join (CS-01): not idempotent; a refusal or a socket nobody listens on did nothing.
      ({ change } = await externalEffect(
        'manager.network.cable',
        () =>
          withinMs(this.manager.networkCable(body.data), HOST_WIFI_TIMEOUT_MS, MANAGER_PATHS.networkCable),
        { refused: managerRefusedChange },
      ));
    } catch (err) {
      const refusal = refusalOf(err, 'cable');
      if (refusal.code === 'unavailable') this.#changeWarnings.warn(err);
      throw refusal;
    }
    await this.#audit({
      kind: 'cable',
      actorAccountId: by.accountId,
      endpointId: by.endpointId,
      payload: { use: input.use, by: 'person', via: 'app', changeId: change.id },
      at: this.services.clock(),
    });
    this.services.log.info(
      { use: input.use, changeId: change.id },
      'network: the manager took a cable change',
    );
    if (asked) await this.moves.record(asked).catch(() => undefined);
    if (input.use === 'cable') this.moves.followCable(change, before);
    return change;
  }

  async #change(
    kind: 'join' | 'forget',
    ssid: string,
    by: NetworkActor,
    call: () => Promise<{ change: NetworkChange }>,
  ): Promise<NetworkChange> {
    const path = kind === 'join' ? MANAGER_PATHS.wifiJoin : MANAGER_PATHS.wifiForget;
    let change: NetworkChange;
    try {
      // The manager changes the box's network (command-safety.md CS-01): not idempotent, so a session op that got here
      // is past cancelling; a refusal or a socket nobody listens on did nothing.
      ({ change } = await externalEffect(
        `manager.wifi.${kind}`,
        () => withinMs(call(), HOST_WIFI_TIMEOUT_MS, path),
        { refused: managerRefusedChange },
      ));
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal.code === 'unavailable') this.#changeWarnings.warn(err);
      throw refusal;
    }
    await this.#audit({
      kind,
      actorAccountId: by.via === 'app' ? by.accountId : null,
      endpointId: by.via === 'app' ? by.endpointId : null,
      payload: { ssid, via: by.via, changeId: change.id },
      at: this.services.clock(),
    });
    this.services.log.info({ kind, via: by.via, changeId: change.id }, 'wifi: the manager took a change');
    return change;
  }

  /** One signed `network.wifi_joined` / `network.wifi_forgotten` in the appliance chain (HD-S06). */
  async #audit(record: NetworkRecord): Promise<void> {
    try {
      await this.#record(record);
    } catch (err) {
      // The change runs whatever the log says; a lost entry is logged, not answered as a failed change.
      this.services.log.error(
        { err: String(err).slice(0, 200), kind: record.kind, changeId: record.payload.changeId },
        'wifi: the change wasn’t recorded in the audit log',
      );
    }
  }
}

/** A join or forget whose input the contract refuses: a passphrase that can't be one is `invalid_passphrase`. */
function invalidInput(issues: readonly { path: readonly PropertyKey[] }[]): Error {
  if (issues.some((i) => i.path[0] === 'passphrase')) return new HostNetworkError('invalid_passphrase');
  return notAName();
}

const notAName = () => new ApiError('bad_request', 'That isn’t a Wi-Fi network’s name.');

/* The session ops (§2.3): the person's devices -------------------------------------------------------------------- */

interface HostNetworkOpContext {
  principal: SessionPrincipal;
  network: HostNetworkService | undefined;
}

function appActorOf(c: HostNetworkOpContext): NetworkActor & { via: 'app' } {
  if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
  return { via: 'app', accountId: c.principal.account.id, endpointId: c.principal.endpoint?.id ?? null };
}

function changer(c: HostNetworkOpContext): { network: HostNetworkService; by: NetworkActor } {
  const by = appActorOf(c);
  if (!c.network)
    throw new SessionOpError('not_implemented', 'This Whombat has no network settings to change.');
  return { network: c.network, by };
}

/** A refusal as a session error: the generic code, the network's own in `details.code` (as `desk.*`'s, CT-525). */
function sessionRefusal(err: unknown): unknown {
  if (!(err instanceof HostNetworkError)) return err;
  if (err.code === 'unavailable') return new SessionOpError('unavailable', err.message);
  const status =
    (WIFI_ERROR_STATUS as Readonly<Record<string, (typeof WIFI_ERROR_STATUS)[WifiErrorCode]>>)[err.code] ??
    CABLE_ERROR_STATUS[err.code as CableErrorCode];
  return new SessionOpError(status, err.message, { code: err.code });
}

export async function hostNetworkOp(c: HostNetworkOpContext): Promise<HostNetworkOutput> {
  appActorOf(c);
  if (!c.network) return { network: null, reason: 'not_managed' };
  return c.network.read();
}

export async function hostWifiScanOp(c: HostNetworkOpContext): Promise<HostWifiScanOutput> {
  appActorOf(c);
  if (!c.network) return { scan: null, reason: 'not_managed' };
  return c.network.scan();
}

export async function hostWifiJoinOp(
  c: HostNetworkOpContext,
  input: HostWifiJoinInput,
): Promise<{ change: NetworkChange }> {
  const { network, by } = changer(c);
  try {
    return { change: await network.join(input, by) };
  } catch (err) {
    throw sessionRefusal(err);
  }
}

export async function hostWifiForgetOp(
  c: HostNetworkOpContext,
  input: HostWifiForgetInput,
): Promise<{ change: NetworkChange }> {
  const { network, by } = changer(c);
  try {
    return { change: await network.forget(input, by) };
  } catch (err) {
    throw sessionRefusal(err);
  }
}

export async function hostCableSetOp(
  c: HostNetworkOpContext,
  input: HostCableSetInput,
): Promise<{ change: CableChange }> {
  const by = appActorOf(c);
  if (!c.network)
    throw new SessionOpError('not_implemented', 'This Whombat has no network settings to change.');
  try {
    return { change: await c.network.cable(input, by) };
  } catch (err) {
    throw sessionRefusal(err);
  }
}
