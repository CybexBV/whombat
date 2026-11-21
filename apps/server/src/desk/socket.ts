/**
 * The desk socket (docs/decisions/desk-display.md DK-12; build brief §2.3; desk-display-server.md DK-S18): HTTP/1.1 with
 * JSON bodies on a unix socket (`WHOMBAT_DESK_SOCKET`, `/run/whombat/console/desk.sock`), for the console server only.
 * The console stays without network (CG-03): it shows what the runtime chose to give it and passes on a few typed
 * requests, which the runtime checks again here.
 *
 *   GET  /v1/desk/state         → DeskState; asked within the last 10 s, the camera may look for the clock (DK-72)
 *   POST /v1/desk/unlock        {v, pin} → DeskUnlockAnswer
 *   POST /v1/desk/unlock/phone  {v} → {v, expiresAt}
 *   POST /v1/desk/lock          {v} → {v}; an unlock that stays too, its boot forgotten first (DK-74, DK-75)
 *   POST /v1/desk/touch         {v} → {v, until} · 409 locked
 *   POST /v1/desk/decide        {v, number, decision, pin?, scope?} → DeskDecideAnswer · 409 locked · 403 on_phone ·
 *                               403 pin_needed · 403 not_offered · 404 · 409 decided; `approve` is the person's yes,
 *                               once or with one of the ask's wider choices (`scope`, with the PIN, TF-14) — a risky
 *                               ask's with the PIN (DK-S61); `deny` their no (DK-S60); `decline` is the screen's Not
 *                               now, which is Home's: the ask snoozed for the person until tomorrow at 09:00, not a no
 *                               (DK-S19)
 *   POST /v1/desk/look/quiet    {v, key, notice, how} → {v} · 409 locked · 403 not_allowed · 404 not_found: *Ignore*
 *                               or *Not now* on a look, for the whole Whombat (quiet-notices.md QN-20, QN-S17)
 *   POST /v1/desk/talk          {v, text? | audioWav?, continue, spoken?} → {v, id} · 409 locked ·
 *                               503 voice_unavailable · 409 busy
 *   POST /v1/desk/hear          {v, audioWav} → {v, text} · 409 locked · 409 busy · 503 voice_unavailable ·
 *                               400 bad_audio · 413 too_large (Talk’s mic is voice typing, docs/decisions/dictation.md)
 *   POST /v1/desk/talk/get      {v, id} → DeskTalk
 *   POST /v1/desk/talk/audio    {v, id} → audio/wav · 404
 *   POST /v1/desk/talk/session  {v} → DeskTalkSession · 409 locked (the open conversation, DK-T15)
 *   POST /v1/desk/talk/close    {v} → {v} · 409 locked (DK-T14)
 *   POST /v1/desk/found/dismiss {v} → {v} · 409 not_paired; also while locked (desk-found.md DF-04)
 *   POST /v1/desk/servers       {v} → DeskServersAnswer · 409 not_paired · 409 locked (*Only the time*) · 503 unavailable
 *                               (every server as a card, worst first, DK-86)
 *   POST /v1/desk/server        {v, id, range} → DeskServerPage · the same · 404 not_found (a server's screen, DK-83)
 *   POST /v1/desk/image         {v, thing, ref} → the picture's bytes (image/jpeg, png or webp) · 404 not_found for
 *                               every refusal: a picture a widget of the box's screen or a monitor's names, only where
 *                               the lock lets it show (DK-138, DK-142)
 *   POST /v1/desk/size          {v, outputs} → {v}: the page's outputs and their sizes, the main one the box's own
 *                               screen, every other a monitor's (DK-129, DK-147)
 *
 * Errors are `{error: {code, message}}`. Access: Node can't read a unix socket peer's credentials, so the socket is made
 * 0660 in the console's setgid directory (`/run/whombat/console`, 2750, group `whombat-console`): only the runtime and
 * the console server can connect, as with the admin socket (MR-15).
 */
import { chmodSync, chownSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DESK_HEAR_REQUEST_MAX_BYTES,
  DESK_PATHS,
  DESK_REQUEST_MAX_BYTES,
  DESK_TALK_REQUEST_MAX_BYTES,
  DeskDecideRequest,
  DeskHearRequest,
  DeskImageRequest,
  DeskLookFixRequest,
  DeskLookQuietRequest,
  DeskRequest,
  DeskServerRequest,
  DeskSizeRequest,
  DeskState,
  DeskTalkRef,
  DeskTalkRequest,
  DeskTalkSession,
  DeskUnlockRequest,
  deskDecideRequestValid,
  deskStateValid,
  deskTalkRequestValid,
  deskTalkSessionValid,
} from '@whombat/control-contracts/local';
import type { z } from 'zod';
import { groupId } from '../managed/groups';
import type { Services } from '../services';
import { serverPageValid } from './server-page';
import { DeskRefused, type DeskService } from './service';

/** Talk carries up to 30 s of audio in base64 (`DESK_TALK_REQUEST_MAX_BYTES`, 1.5 MiB). */
export const DESK_TALK_MAX_BODY = DESK_TALK_REQUEST_MAX_BYTES;
/** Talk's mic carries up to five minutes in base64 (`DESK_HEAR_REQUEST_MAX_BYTES`, 12.2 MiB). */
export const DESK_HEAR_MAX_BODY = DESK_HEAR_REQUEST_MAX_BYTES;
/** Every other request is a few fields (`DESK_REQUEST_MAX_BYTES`). */
export const DESK_MAX_BODY = DESK_REQUEST_MAX_BYTES;

/** What the socket asks of the desk (the service; tests give a fake). */
export type DeskPort = Pick<
  DeskService,
  | 'state'
  | 'unlock'
  | 'unlockPhone'
  | 'lockNow'
  | 'touch'
  | 'decide'
  | 'lookQuiet'
  | 'lookFix'
  | 'talkStart'
  | 'talkGet'
  | 'talkAudio'
  | 'talkSession'
  | 'talkClose'
  | 'hear'
  | 'foundDismiss'
  | 'servers'
  | 'server'
  | 'image'
  | 'size'
>;

/** More routes on the desk socket, asked first (the network's, `network.ts`): true when it answered. */
export interface DeskRoutes {
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

export class DeskSocket {
  #server: Server | null = null;

  constructor(
    private readonly services: Services,
    private readonly desk: DeskPort,
    private readonly routes: readonly DeskRoutes[] = [],
  ) {}

  async listen(path: string): Promise<void> {
    if (existsSync(path)) unlinkSync(path);
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.services.log.error({ err: String(err) }, 'desk socket request failed');
        if (!res.headersSent)
          send(res, 500, { error: { code: 'internal', message: 'Something went wrong.' } });
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    // The runtime's UMask is 0077: the mode is set here, not inherited.
    chmodSync(path, 0o660);
    this.#applyGroup(path);
    this.#server = server;
  }

  /** The console's group (`WHOMBAT_CONSOLE_GROUP`): the setgid directory gives it; otherwise set when this user may. */
  #applyGroup(path: string): void {
    const name = this.services.config.WHOMBAT_CONSOLE_GROUP;
    const gid = groupId(name);
    if (gid === null) {
      this.services.log.warn({ group: name }, 'desk socket: no such group; only this user can connect');
      return;
    }
    if (statSync(path).gid === gid) return;
    const mine = [process.getgid?.(), ...(process.getgroups?.() ?? [])];
    if (!mine.includes(gid)) {
      this.services.log.warn(
        { group: name },
        'desk socket: this user is not in its group; the console can’t connect',
      );
      return;
    }
    chownSync(path, -1, gid);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  /** One request (exported for tests through `handle`). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    for (const routes of this.routes) if (await routes.handle(req, res, path ?? '/')) return;
    if (req.method === 'GET' && path === DESK_PATHS.state) {
      const state = await this.desk.state();
      // Outside production a state the console would refuse is a bug here (`deskStateValid`).
      if (this.services.config.NODE_ENV !== 'production' && !deskStateValid(DeskState.parse(state)))
        throw new Error('desk state: not valid');
      send(res, 200, state);
      return;
    }
    const known = (Object.values(DESK_PATHS) as string[]).includes(path ?? '');
    if (req.method !== 'POST' || !known || path === DESK_PATHS.state) {
      send(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
      return;
    }
    const read = await readJson(
      req,
      path === DESK_PATHS.talk
        ? DESK_TALK_MAX_BODY
        : path === DESK_PATHS.hear
          ? DESK_HEAR_MAX_BODY
          : DESK_MAX_BODY,
    );
    if (read === TOO_LARGE) {
      send(res, 413, { error: { code: 'too_large', message: 'The request is too large.' } });
      return;
    }
    if (read === NOT_JSON) {
      send(res, 400, { error: { code: 'bad_request', message: 'The body must be JSON.' } });
      return;
    }
    const body = read;
    const parse = <S extends z.ZodType>(schema: S): z.output<S> | null => {
      const parsed = schema.safeParse(body);
      if (parsed.success) return parsed.data;
      send(res, 400, { error: { code: 'bad_request', message: 'The request isn’t valid.' } });
      return null;
    };
    try {
      switch (path) {
        case DESK_PATHS.unlock: {
          const input = parse(DeskUnlockRequest);
          if (input) send(res, 200, await this.desk.unlock(input.pin));
          return;
        }
        case DESK_PATHS.unlockPhone:
          if (parse(DeskRequest)) send(res, 200, await this.desk.unlockPhone());
          return;
        case DESK_PATHS.lock:
          if (parse(DeskRequest)) send(res, 200, await this.desk.lockNow());
          return;
        case DESK_PATHS.touch:
          if (parse(DeskRequest)) send(res, 200, this.desk.touch());
          return;
        case DESK_PATHS.decide: {
          const input = parse(DeskDecideRequest);
          if (!input) return;
          // A scope only with a yes (CT-891).
          if (!deskDecideRequestValid(input)) {
            send(res, 400, { error: { code: 'bad_request', message: 'Only a yes has a scope.' } });
            return;
          }
          send(res, 200, await this.desk.decide(input.number, input.decision, input.pin, input.scope));
          return;
        }
        case DESK_PATHS.lookQuiet: {
          const input = parse(DeskLookQuietRequest);
          if (input) send(res, 200, await this.desk.lookQuiet(input.key, input.notice, input.how));
          return;
        }
        case DESK_PATHS.lookFix: {
          const input = parse(DeskLookFixRequest);
          if (input) send(res, 200, await this.desk.lookFix(input.key));
          return;
        }
        case DESK_PATHS.talk: {
          const input = parse(DeskTalkRequest);
          if (!input) return;
          if (!deskTalkRequestValid(input)) {
            send(res, 400, { error: { code: 'bad_request', message: 'Send either text or audio.' } });
            return;
          }
          send(
            res,
            200,
            await this.desk.talkStart({
              ...(input.text !== undefined ? { text: input.text } : {}),
              ...(input.audioWav !== undefined ? { audioWav: Buffer.from(input.audioWav, 'base64') } : {}),
              continue: input.continue,
              ...(input.server !== undefined ? { server: input.server } : {}),
              ...(input.spoken === true ? { spoken: true } : {}),
            }),
          );
          return;
        }
        case DESK_PATHS.hear: {
          const input = parse(DeskHearRequest);
          if (!input) return;
          // Nobody waits for the words once the console hung up: the speech service stops waiting too.
          const gone = new AbortController();
          res.once('close', () => {
            if (!res.writableFinished) gone.abort();
          });
          send(res, 200, await this.desk.hear(Buffer.from(input.audioWav, 'base64'), gone.signal));
          return;
        }
        case DESK_PATHS.talkGet: {
          const input = parse(DeskTalkRef);
          if (input) send(res, 200, this.desk.talkGet(input.id));
          return;
        }
        case DESK_PATHS.talkAudio: {
          const input = parse(DeskTalkRef);
          if (!input) return;
          const wav = this.desk.talkAudio(input.id);
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.byteLength });
          res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
          return;
        }
        case DESK_PATHS.talkSession: {
          if (!parse(DeskRequest)) return;
          const session = await this.desk.talkSession();
          // Outside production a conversation the console would refuse is a bug here (`deskTalkSessionValid`).
          if (
            this.services.config.NODE_ENV !== 'production' &&
            !deskTalkSessionValid(DeskTalkSession.parse(session))
          )
            throw new Error('desk conversation: not valid');
          send(res, 200, session);
          return;
        }
        case DESK_PATHS.talkClose:
          if (parse(DeskRequest)) send(res, 200, this.desk.talkClose());
          return;
        case DESK_PATHS.foundDismiss:
          if (parse(DeskRequest)) send(res, 200, await this.desk.foundDismiss());
          return;
        case DESK_PATHS.servers:
          if (parse(DeskRequest)) send(res, 200, await this.desk.servers());
          return;
        case DESK_PATHS.server: {
          const input = parse(DeskServerRequest);
          if (!input) return;
          const page = await this.desk.server(input.id, input.range);
          // Outside production a page the console would refuse is a bug here (`deskServerPageValid`, the id asked).
          if (this.services.config.NODE_ENV !== 'production' && !serverPageValid(page, input.id))
            throw new Error('desk server page: not valid');
          send(res, 200, page);
          return;
        }
        case DESK_PATHS.image: {
          const input = parse(DeskImageRequest);
          if (!input) return;
          const picture = await this.desk.image(input.thing, input.ref);
          res.writeHead(200, {
            'content-type': picture.type,
            'content-length': picture.bytes.byteLength,
            'cache-control': 'no-store',
          });
          res.end(Buffer.from(picture.bytes.buffer, picture.bytes.byteOffset, picture.bytes.byteLength));
          return;
        }
        case DESK_PATHS.size: {
          const input = parse(DeskSizeRequest);
          if (input) send(res, 200, await this.desk.size(input.outputs));
          return;
        }
        default:
          // A route of `routes` (the network's) on a socket built without them.
          send(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
      }
    } catch (err) {
      if (err instanceof DeskRefused) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export const TOO_LARGE = Symbol('too large');
export const NOT_JSON = Symbol('not JSON');

/**
 * The body as JSON. One over `max` is read to its end without keeping it (so the answer reaches the sender), up to four
 * times `max`; past that the connection is cut.
 */
export async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max * 4) {
      req.destroy();
      return TOO_LARGE;
    }
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) return TOO_LARGE;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}
