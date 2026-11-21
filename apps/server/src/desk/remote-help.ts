/**
 * The desk socket's remote help route (docs/decisions/remote-help.md RH-04, RH-12; remote-help-server.md RH-S08): the
 * box's screen shows a line while remote help is on (`DeskState.remoteHelp`, from `RemoteHelpService.deskView`) and its
 * Stop works without unlocking — stopping only ever takes access away. Paired or not, locked or not.
 *
 *   POST /v1/desk/remote-help/stop  {v} → DeskState · 503 unavailable (the support service didn't answer)
 *
 * Without a support service the line never shows, and Stop answers the state as it is.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DESK_PATHS, DeskRequest, type DeskState } from '@whombat/control-contracts/local';
import type { RemoteHelpService } from '../managed/remote-help';
import { DESK_MAX_BODY, type DeskRoutes, NOT_JSON, readJson, send, TOO_LARGE } from './socket';

export interface DeskRemoteHelpHost {
  remoteHelp: Pick<RemoteHelpService, 'stopAtDesk'> | null;
  /** The screen's state after the stop (`DeskService.state`). */
  state(): Promise<DeskState>;
}

export class DeskRemoteHelpRoutes implements DeskRoutes {
  constructor(
    private readonly host: DeskRemoteHelpHost,
    private readonly log: { warn(obj: object, msg: string): void },
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== DESK_PATHS.remoteHelpStop || req.method !== 'POST') return false;
    const body = await readJson(req, DESK_MAX_BODY);
    if (body === TOO_LARGE) {
      send(res, 413, { error: { code: 'too_large', message: 'The request is too large.' } });
      return true;
    }
    if (body === NOT_JSON || !DeskRequest.safeParse(body).success) {
      send(res, 400, { error: { code: 'bad_request', message: 'The request isn’t valid.' } });
      return true;
    }
    if (this.host.remoteHelp) {
      try {
        await this.host.remoteHelp.stopAtDesk();
      } catch (err) {
        this.log.warn({ err: String(err).slice(0, 200) }, 'desk: remote help didn’t stop');
        send(res, 503, {
          error: { code: 'unavailable', message: 'Remote help didn’t answer. Try again in a moment.' },
        });
        return true;
      }
    }
    send(res, 200, await this.host.state());
    return true;
  }
}
