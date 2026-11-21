/**
 * The desk socket's claim route (docs/decisions/whombat-link.md): *New letters* on the box's own claim screen. Only the
 * console reaches this socket, so the request means someone is at the box. It opens a short window with fresh claim
 * letters that stay whatever others on the network try, so nobody there can keep the person at the box from claiming
 * it (`TrustService.openClaimWindow`). Before the claim there is no lock and no pairing to ask for.
 *
 *   POST /v1/desk/claim/letters  {v} → {v} · 409 not_available (claimed, or a box that shows no letters of its own)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DESK_PATHS, DeskRequest } from '@whombat/control-contracts/local';
import { DESK_MAX_BODY, type DeskRoutes, NOT_JSON, readJson, send, TOO_LARGE } from './socket';

export interface DeskClaimHost {
  /** Opens the window; until when the letters stay, or null when the box shows none of its own. */
  newLetters(): Promise<Date | null>;
}

export class DeskClaimRoutes implements DeskRoutes {
  constructor(private readonly host: DeskClaimHost) {}

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== DESK_PATHS.claimLetters || req.method !== 'POST') return false;
    const body = await readJson(req, DESK_MAX_BODY);
    if (body === TOO_LARGE) {
      send(res, 413, { error: { code: 'too_large', message: 'The request is too large.' } });
      return true;
    }
    if (body === NOT_JSON || !DeskRequest.safeParse(body).success) {
      send(res, 400, { error: { code: 'bad_request', message: 'The request isn’t valid.' } });
      return true;
    }
    if (!(await this.host.newLetters())) {
      send(res, 409, {
        error: { code: 'not_available', message: 'This Whombat shows no claim letters to change.' },
      });
      return true;
    }
    send(res, 200, { v: 1 });
    return true;
  }
}
