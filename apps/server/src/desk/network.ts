/**
 * The desk socket's network routes (docs/decisions/hardware-support.md HD-07; hardware-support-server.md HD-S07): the
 * box's screen shows the network it uses and may choose Wi-Fi when that is safe — the box isn't claimed yet, it can't
 * reach Whombat right now, or the screen is unlocked (the desk PIN or the phone, DK-04). They work on an unpaired screen
 * too. The console server has no network and no manager access (CG-03): it asks here, and the runtime decides again.
 *
 *   GET  /v1/desk/network              → {v, network, mayChange, why?: 'locked'}
 *   POST /v1/desk/network/wifi/scan    {v} → {v, scan} · 409 no_wifi
 *   POST /v1/desk/network/wifi/join    {v, ssid, passphrase?, hidden?} → {v, change} · 409 locked · 409 busy ·
 *                                      400 invalid_passphrase
 *   POST /v1/desk/network/wifi/forget  {v, ssid} → {v, change} · 409 locked · 409 busy · 409 in_use · 404 not_saved
 *
 * Every manager failure is 503 `unavailable`. A join or forget is recorded in the appliance's audit chain as the
 * screen's, and keeps an unlocked screen unlocked (a touch, as a decision is).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DESK_PATHS,
  type DeskNetworkAnswer,
  DeskRequest,
  DeskWifiForgetRequest,
  DeskWifiJoinRequest,
} from '@whombat/control-contracts/local';
import type { z } from 'zod';
import { ApiError } from '../lib/errors';
import { HostNetworkError, type HostNetworkRefusal, type HostNetworkService } from '../managed/host-network';
import { DESK_MAX_BODY, type DeskRoutes, NOT_JSON, readJson, send, TOO_LARGE } from './socket';

/**
 * Whether the screen may change the Wi-Fi now (HD-07, HD-10): before the box is claimed, while it can't reach Whombat,
 * or while the screen is unlocked; otherwise the screen shows the network and says to unlock or use the app.
 */
export function deskMayChangeNetwork(facts: { claimed: boolean; online: boolean; unlocked: boolean }): {
  mayChange: boolean;
  why?: 'locked';
} {
  if (facts.unlocked || !facts.claimed || !facts.online) return { mayChange: true };
  return { mayChange: false, why: 'locked' };
}

/** What the routes ask of the runtime: the manager's network, the claim, the screen's lock. */
export interface DeskNetworkHost {
  network: Pick<HostNetworkService, 'state' | 'scan' | 'join' | 'forget'>;
  /** The runtime's own claim state (`TrustService.isClaimed`). */
  claimed(): Promise<boolean>;
  /** Whether the screen is unlocked now (`DeskLock`). */
  unlocked(): boolean;
  /** Keeps an unlocked screen unlocked. */
  touch(): void;
}

const REFUSAL_STATUS: Readonly<Record<HostNetworkRefusal, number>> = {
  no_wifi: 409,
  busy: 409,
  in_use: 409,
  not_saved: 404,
  invalid_passphrase: 400,
  // The cable's refusals: the screen doesn't switch the cable (network-move.md “Not now”), listed for the type.
  not_connected: 409,
  no_cable: 409,
  unchanged: 409,
  unavailable: 503,
};

const UNAVAILABLE = { error: { code: 'unavailable', message: 'The network can’t be read right now.' } };
const LOCKED = {
  error: { code: 'locked', message: 'Unlock the screen to change Wi-Fi, or change it in the app.' },
};

export class DeskNetworkRoutes implements DeskRoutes {
  readonly #paths: ReadonlySet<string> = new Set([
    DESK_PATHS.network,
    DESK_PATHS.wifiScan,
    DESK_PATHS.wifiJoin,
    DESK_PATHS.wifiForget,
  ]);

  constructor(private readonly host: DeskNetworkHost) {}

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!this.#paths.has(path)) return false;
    if (path === DESK_PATHS.network) {
      if (req.method !== 'GET')
        send(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
      else await this.#network(res);
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
      return true;
    }
    const body = await readJson(req, DESK_MAX_BODY);
    if (body === TOO_LARGE) {
      send(res, 413, { error: { code: 'too_large', message: 'The request is too large.' } });
      return true;
    }
    if (body === NOT_JSON) {
      send(res, 400, { error: { code: 'bad_request', message: 'The body must be JSON.' } });
      return true;
    }
    switch (path) {
      case DESK_PATHS.wifiScan:
        if (parse(res, DeskRequest, body)) await this.#scan(res);
        break;
      case DESK_PATHS.wifiJoin: {
        const input = parse(res, DeskWifiJoinRequest, body);
        if (input)
          await this.#change(res, () =>
            this.host.network.join(
              {
                ssid: input.ssid,
                ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
                ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
              },
              { via: 'screen' },
            ),
          );
        break;
      }
      case DESK_PATHS.wifiForget: {
        const input = parse(res, DeskWifiForgetRequest, body);
        if (input)
          await this.#change(res, () => this.host.network.forget({ ssid: input.ssid }, { via: 'screen' }));
        break;
      }
    }
    return true;
  }

  async #network(res: ServerResponse): Promise<void> {
    const network = await this.host.network.state();
    if (!network) {
      send(res, 503, UNAVAILABLE);
      return;
    }
    const unlocked = this.host.unlocked();
    const claimed = unlocked || !network.online ? true : await this.host.claimed();
    const answer: DeskNetworkAnswer = {
      v: 1,
      network,
      ...deskMayChangeNetwork({ claimed, online: network.online, unlocked }),
    };
    send(res, 200, answer);
  }

  async #scan(res: ServerResponse): Promise<void> {
    const { scan, reason } = await this.host.network.scan();
    if (scan) send(res, 200, { v: 1, scan });
    else if (reason === 'no_wifi')
      send(res, 409, { error: { code: 'no_wifi', message: 'This Whombat has no Wi-Fi.' } });
    else send(res, 503, UNAVAILABLE);
  }

  /** A join or forget: decided again here with a fresh state (HD-07), then the manager's. */
  async #change(res: ServerResponse, run: () => Promise<unknown>): Promise<void> {
    if (!this.host.unlocked()) {
      const claimed = await this.host.claimed();
      if (claimed) {
        const network = await this.host.network.state();
        if (!network) {
          send(res, 503, UNAVAILABLE);
          return;
        }
        if (!deskMayChangeNetwork({ claimed, online: network.online, unlocked: false }).mayChange) {
          send(res, 409, LOCKED);
          return;
        }
      }
    }
    try {
      const change = await run();
      this.host.touch();
      send(res, 200, { v: 1, change });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_request')
        send(res, 400, { error: { code: 'bad_request', message: err.message } });
      else if (err instanceof HostNetworkError)
        send(res, REFUSAL_STATUS[err.code], { error: { code: err.code, message: err.message } });
      else throw err;
    }
  }
}

/**
 * The body as `schema` says, or a 400 answered: `invalid_passphrase` when only the passphrase is wrong (the console says
 * so beside the field), else `bad_request`.
 */
function parse<S extends z.ZodType>(res: ServerResponse, schema: S, body: unknown): z.output<S> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const passphrase = parsed.error.issues.every((i) => i.path[0] === 'passphrase');
  send(
    res,
    400,
    passphrase
      ? { error: { code: 'invalid_passphrase', message: 'A Wi-Fi password has 8 to 63 characters.' } }
      : { error: { code: 'bad_request', message: 'The request isn’t valid.' } },
  );
  return null;
}
