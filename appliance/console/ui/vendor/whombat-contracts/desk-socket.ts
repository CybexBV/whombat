/**
 * The desk socket (0.100, CT-528…CT-531; Whombat docs/decisions/desk-display.md DK-12): the runtime ⇄ the console
 * server, HTTP/1.1 JSON over a unix socket. The runtime listens on `WHOMBAT_DESK_SOCKET` (`DESK_SOCKET_DEFAULT`; unset:
 * no desk), creates it 0660 in the setgid console directory (group `whombat-console`), so only the runtime and the
 * console server can connect (the admin socket's model, MR-15). The console stays without network (CG-03): it shows
 * what the runtime chose to give it and passes on a few typed requests. The runtime is the one authority for what may
 * show (DK-03) and what may be done (DK-04, DK-05).
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/desk/state` | — | `DeskState` |
 * | `POST /v1/desk/unlock` | `DeskUnlockRequest {v, pin}` (4–6 digits) | `DeskUnlockAnswer {v, result, triesLeft?, retryAt?}`; 409 `no_pin` |
 * | `POST /v1/desk/unlock/phone` | `DeskRequest {v}` | `DeskPhoneUnlockAnswer {v, expiresAt}` |
 * | `POST /v1/desk/lock` | `DeskRequest {v}` | `DeskAck {v}` |
 * | `POST /v1/desk/touch` | `DeskRequest {v}` | `DeskTouchAnswer {v, until}`; 409 `locked` |
 * | `POST /v1/desk/decide` | `DeskDecideRequest {v, number, decision, pin?, scope?}` | `DeskDecideAnswer {v, result, triesLeft?, retryAt?, talk?}`; 409 `locked`, 403 `on_phone`, 403 `pin_needed`, 403 `not_offered` (0.116), 409 `no_pin`, 404 `not_found`, 409 `decided` |
 * | `POST /v1/desk/talk` | `DeskTalkRequest {v, text? \| audioWav?, continue, spoken?}` | `DeskTalkStarted {v, id}`; 409 `locked`, 503 `voice_unavailable`, 409 `busy`, 400 `bad_audio` |
 * | `POST /v1/desk/hear` | `DeskHearRequest {v, audioWav}` (3.3) | `DeskHeard {v, text}`; 409 `not_paired`, `locked`, `busy`, 503 `voice_unavailable`, `unavailable`, 400 `bad_audio`, 413 `too_large` |
 * | `POST /v1/desk/talk/get` | `DeskTalkRef {v, id}` | `DeskTalk`; 404 `not_found` |
 * | `POST /v1/desk/talk/audio` | `DeskTalkRef {v, id}` | `audio/wav` bytes; 404 `not_found` |
 * | `POST /v1/desk/talk/session` | `DeskRequest {v}` | `DeskTalkSession {v, open, messages, earlier, until?, working?}` (0.108; `working` 0.116); 409 `locked` |
 * | `POST /v1/desk/talk/close` | `DeskRequest {v}` | `DeskAck {v}` (0.108); 409 `locked` |
 * | `POST /v1/desk/found/dismiss` | `DeskRequest {v}` | `DeskAck {v}` (0.110), also while locked |
 * | `POST /v1/desk/servers` | `DeskRequest {v}` | `DeskServersAnswer {v, servers, more}` (0.115); 409 `not_paired`, `locked`, 503 `unavailable` |
 * | `POST /v1/desk/server` | `DeskServerRequest {v, id, range}` | `DeskServerPage` (0.115); 409 `not_paired`, `locked`, 404 `not_found`, 503 `unavailable` |
 * | `POST /v1/desk/remote-help/stop` | `DeskRequest {v}` | `DeskState` (0.120), also while locked or unpaired; 503 `unavailable` |
 * | `POST /v1/desk/look/quiet` | `DeskLookQuietRequest {v, key, notice, how}` | `DeskAck {v}` (0.122); 409 `not_paired`, `locked`, 403 `not_allowed`, 404 `not_found` |
 * | `POST /v1/desk/look/fix` | `DeskLookFixRequest {v, key}` | `DeskAck {v}` (3.5); 409 `not_paired`, `locked`, 403 `not_allowed`, 404 `not_found` |
 * | `GET /v1/desk/network` | — | `DeskNetworkAnswer {v, network, mayChange, why?}` (0.102) |
 * | `POST /v1/desk/network/wifi/scan` | `DeskRequest {v}` | `DeskWifiScanAnswer {v, scan}`; 409 `no_wifi` |
 * | `POST /v1/desk/network/wifi/join` | `DeskWifiJoinRequest {v, ssid, passphrase?, hidden?}` | `DeskWifiChangeAnswer {v, change}`; 409 `locked`, `busy`, `no_wifi`, 400 `invalid_passphrase` |
 * | `POST /v1/desk/network/wifi/forget` | `DeskWifiForgetRequest {v, ssid}` | `DeskWifiChangeAnswer {v, change}`; 409 `locked`, `busy`, `in_use`, 404 `not_saved` |
 * | `GET /v1/desk/bluetooth` | — | `DeskBluetoothAnswer {v, bluetooth, mayChange, why?}` (0.109) |
 * | `POST /v1/desk/bluetooth/scan` | `DeskRequest {v}` | `DeskBluetoothScanAnswer {v, scan}`; 409 `locked`, `no_bluetooth`, `busy` |
 * | `POST /v1/desk/bluetooth/pair` | `DeskBluetoothDeviceRequest {v, address}` | `DeskBluetoothPairingAnswer {v, pairing}`; 409 `locked`, `no_bluetooth`, `busy`, 404 `not_found` |
 * | `POST /v1/desk/bluetooth/confirm` | `DeskBluetoothConfirmRequest {v, pairingId, accept}` | `DeskBluetoothPairingAnswer`; 409 `locked`, 404 `not_found` |
 * | `POST /v1/desk/bluetooth/cancel` | `DeskBluetoothCancelRequest {v, pairingId}` | `DeskBluetoothPairingAnswer`; 409 `locked`, 404 `not_found` |
 * | `POST /v1/desk/bluetooth/connect` | `DeskBluetoothDeviceRequest` | `DeskBluetoothDeviceAnswer {v, device}`; 409 `locked`, `no_bluetooth`, `not_paired`, 404 `not_found` |
 * | `POST /v1/desk/bluetooth/disconnect` | `DeskBluetoothDeviceRequest` | `DeskBluetoothDeviceAnswer`; as `connect` |
 * | `POST /v1/desk/bluetooth/forget` | `DeskBluetoothDeviceRequest` | `DeskAck {v}`; 409 `locked`, `no_bluetooth`, `not_paired`, 404 `not_found` |
 *
 * Errors are `LocalError` with the codes of `DESK_SOCKET_ERRORS`. Requests are strict and at most
 * `DESK_REQUEST_MAX_BYTES` (`DESK_TALK_REQUEST_MAX_BYTES` for a talk, `DESK_HEAR_REQUEST_MAX_BYTES` for a recording to
 * hear); answers are tolerant. Display strings may be any
 * script on one line (`DESK_TEXT_RES`, CT-529): the console server still strips control and format characters from
 * every string and the page draws them as text only.
 *
 * 0.101 (CT-543…CT-545; DK-18, DK-22): `DeskPaired.hasPin` (false: the pad shows only *Confirm on your phone*),
 * `DeskGlance.box` (This Whombat while the glance has no servers and no tiles) and the code `no_pin`.
 *
 * 0.103 (CT-595, CT-596; DK-26, DK-28, DK-30): `DeskPaired.pinDigits` (the pad's dots), `DeskLock.camera` and
 * `DeskLock.present` (the lock chip), and an unlock of 4 to 6 digits (DK-34).
 *
 * 0.104 (CT-601, CT-602; DK-37…DK-42): one glance that fits what there is. `DeskGlance.self` (This Whombat beside
 * servers or tiles), `DeskGlance.extraServers` and `DeskGlance.extraTiles` (servers and tiles five to eight); the
 * screen shows what fits (DK-42).
 *
 * 0.107 (CT-646…CT-648; DK-70…DK-76): `DeskState.presence` (the camera looking for someone, DK-72: the glance while it
 * sees a face, only the clock when nobody is there) and `DeskLock.stays` (unlocked until Lock, DK-74; DK-76).
 *
 * 0.108 (CT-660…CT-666; DK-60…DK-65): asks that come to you and Talk as a conversation. `DeskAsk.deny`,
 * `DeskAsk.approveWithPin` and `DeskAsk.inTalk`; the decision `deny` and a `pin` to approve a risky ask, answered by
 * `DeskDecideAnswer` (the code `pin_needed`); the open conversation (`talk/session`, `talk/close`, `DeskTalkSession`),
 * which `continue` now continues for 30 minutes (DK-65).
 *
 * 0.109 (CT-684; Whombat bluetooth.md BT-02): the box's Bluetooth — `bluetooth` and the seven changes after it, with the
 * code `no_bluetooth`.
 *
 * 0.110 (CT-700, CT-701; Whombat desk-found.md DF-01…DF-12): found on your network. `DeskGlance.found` (`DeskFound`,
 * the things the scan found that aren't connected yet, or the first scan looking) and `found/dismiss` (*Not now*, also
 * while locked, DF-04; DF-06).
 *
 * 0.115 (CT-860…CT-867; DK-80…DK-89): server cards three to a row, and a server's own screen. `DeskServer.id` (the
 * card opens) and `DeskServer.disk` (its third line), `servers` (every server as the glance's cards, DK-86) and `server`
 * (a server's own screen, `DeskServerPage`, DK-83), and `DeskTalkRequest.server` (*Ask about this server*, DK-85). Both
 * paths work while locked, but not in *Only the time* (`locked`, DK-84; DK-88).
 *
 * 0.116 (CT-890…CT-896; Whombat task-feedback.md TF-14…TF-18): an ask offers the web's wider choices
 * (`DeskAsk.choices`, answered by `decide` with a `scope` and the PIN; the code `not_offered`) and names who asks
 * (`DeskAsk.from`); a talk that runs past 90 s is `working` and waits for the turn up to 30 minutes before `slow`; the
 * conversation shows the assistant working (`DeskTalkSession.working`) and its server tasks as rows
 * (`DeskSessionMessage.task`). The runtime and the console ship in one host release.
 *
 * 0.118 (CT-970…CT-972; Whombat desk-display.md DK-90…DK-98): Needs you lists what needs a look too —
 * `DeskNeedsYou.looks` (`DeskLook`: a server, connection or device that is down or needs a look, with its reason and a
 * server's id), never in *Only the time* locked.
 *
 * 0.120 (CT-943; Whombat remote-help.md RH-04, RH-12): remote help on the glance — `DeskState.remoteHelp` (`DeskRemoteHelp`:
 * the level, until when, who is connected) while it is on, and `remote-help/stop` (*Stop*, without unlocking).
 *
 * 0.122 (CT-1065; Whombat quiet-notices.md QN-20): a look says which line it comes from (`DeskLook.notice`), its kind
 * (`nature`: a problem, or only you; a heads-up is never a look), Ignore's words (`ignoreWords`) and the line's own
 * question (`question`), and `look/quiet` ignores it or puts it off until tomorrow (*Ignore*, *Not now*), unlocked only.
 *
 * 3.2 (CT-1629, CT-1630; Whombat desk-display.md DK-101…DK-125): the calm glance — `DeskGlance.calm` (`DeskCalm` of
 * `@whombat/core/domain`: the sentence by the clock, the one thing in the middle or up to three things going on, the
 * servers' strip, the top bar's choices, *Done today*, *Welcome back*, Whombat updating itself and *Try it on the
 * screen*), trimmed like the rest of the glance; and `DeskState.name`, the Whombat's name for the top bar. A console
 * that knows `calm` draws it; an older one draws the glance it knows from the members beside it.
 *
 * 3.3 (Whombat docs/decisions/dictation.md): Talk's mic is voice typing. `hear` turns a recording of up to five minutes
 * into text with voice typing's model and language and answers it (`DeskHeard`, empty when nothing was heard); the
 * screen puts the words in Talk's box and the person sends them as a typed question with `spoken` (the turn still hears
 * that it came by voice, DK-T05). A question, typed or heard, is at most `DESK_TALK_TEXT_MAX` code points (500 before);
 * `DeskTalk.question` still shows at most `DESK_QUESTION_MAX`. A talk's `audioWav` stays for an older screen.
 */
import { COMMAND_SCOPES } from '@whombat/core/commands';
import {
  AgentFace,
  CatalogIdText,
  DESK_BOX_PARTS,
  DESK_BOX_POINTS,
  DESK_GUEST_STATES,
  DESK_LOOK_KINDS,
  DESK_LOOK_STATES,
  DESK_LOOKS_MAX,
  DESK_PIN_RE,
  DESK_SERVER_ID_RE,
  DESK_SERVER_RANGES,
  DeskBoxPartKey,
  DeskCalm,
  type DeskGrid,
  DeskGuestState,
  DeskLockedView,
  DeskLookKind,
  DeskLookState,
  DeskNight,
  DeskPhoneReason,
  DeskPinDigits,
  DeskScreenSize,
  DeskServerId,
  DeskServerRange,
  DeskWhombatName,
  DeskWidgetRef,
  LookResearch,
  NOTICE_NATURES,
  NoticeCheck,
  NoticeNature,
  RemoteHelpLevel,
  TASK_CARD_STATES,
  displayTextRe as textRe,
  VOICE_TYPING_MAX_BYTES,
} from '@whombat/core/domain';
import { ClaimLetters } from '@whombat/protocol/claim';
import {
  BluetoothAddress,
  BluetoothDevice,
  BluetoothPairing,
  BluetoothPairingId,
  BluetoothScan,
  BluetoothState,
  HostNetwork,
  HostPowerSource,
  NetworkChange,
  Rfc3339,
  Ssid,
  TimeZoneName,
  WifiPassphrase,
  WifiScan,
} from '@whombat/protocol/session';
import { z } from 'zod';

export {
  DESK_GUEST_STATES,
  DESK_LOOK_KINDS,
  DESK_LOOK_STATES,
  DESK_LOOKS_MAX,
  DESK_SERVER_ID_RE,
  DESK_SERVER_RANGES,
  DeskBoxPartKey,
  DeskGuestState,
  DeskLockedView,
  DeskLookKind,
  DeskLookState,
  DeskNight,
  DeskPhoneReason,
  DeskServerId,
  DeskServerRange,
  NOTICE_NATURES,
  NoticeCheck,
  NoticeNature,
};

const V = z.literal(1);

/** Where the runtime listens for the console server. */
export const DESK_SOCKET_ENV = 'WHOMBAT_DESK_SOCKET';
export const DESK_SOCKET_DEFAULT = '/run/whombat/console/desk.sock';

export const DESK_PATHS = {
  /** GET: what the screen shows now. */
  state: '/v1/desk/state',
  unlock: '/v1/desk/unlock',
  /** *Confirm on your phone*. */
  unlockPhone: '/v1/desk/unlock/phone',
  lock: '/v1/desk/lock',
  /** Keeps an unlocked screen unlocked (the page sends it at most every 20 s while touched). */
  touch: '/v1/desk/touch',
  decide: '/v1/desk/decide',
  talk: '/v1/desk/talk',
  talkGet: '/v1/desk/talk/get',
  /** The answer's audio, `audio/wav`. */
  talkAudio: '/v1/desk/talk/audio',
  /** The open conversation as the screen shows it (0.108, CT-664; DK-63). */
  talkSession: '/v1/desk/talk/session',
  /** Closes the open conversation (0.108, CT-664; DK-64). */
  talkClose: '/v1/desk/talk/close',
  /** GET (0.102, CT-574): how the box is connected, and whether the screen may change its Wi-Fi now (HD-07). */
  network: '/v1/desk/network',
  wifiScan: '/v1/desk/network/wifi/scan',
  wifiJoin: '/v1/desk/network/wifi/join',
  wifiForget: '/v1/desk/network/wifi/forget',
  /** GET (0.109, CT-684): the box's Bluetooth, and whether the screen may change it now (BT-02). */
  bluetooth: '/v1/desk/bluetooth',
  bluetoothScan: '/v1/desk/bluetooth/scan',
  bluetoothPair: '/v1/desk/bluetooth/pair',
  bluetoothConfirm: '/v1/desk/bluetooth/confirm',
  bluetoothCancel: '/v1/desk/bluetooth/cancel',
  bluetoothConnect: '/v1/desk/bluetooth/connect',
  bluetoothDisconnect: '/v1/desk/bluetooth/disconnect',
  bluetoothForget: '/v1/desk/bluetooth/forget',
  /** *Not now* on the found panel or strip (0.110, CT-701; DF-04): puts it away for the burrow, also while locked. */
  foundDismiss: '/v1/desk/found/dismiss',
  /** Every server as the glance's cards (0.115, CT-863; DK-86): `DeskRequest` → `DeskServersAnswer`. */
  servers: '/v1/desk/servers',
  /** A server's own screen (0.115, CT-864; DK-83): `DeskServerRequest` → `DeskServerPage`. */
  server: '/v1/desk/server',
  /**
   * *Stop* on the remote help line (0.120, CT-943; RH-04): `DeskRequest` → `DeskState`. Never asks for an unlock or a
   * pairing: stopping only ever takes access away.
   */
  remoteHelpStop: '/v1/desk/remote-help/stop',
  /** *Ignore* or *Not now* on a look (0.122, CT-1065; QN-20): `DeskLookQuietRequest` → `DeskAck`, unlocked only. */
  lookQuiet: '/v1/desk/look/quiet',
  /** The step the assistant offers on a look (3.5; look-research.md): `DeskLookFixRequest` → `DeskAck`, unlocked only. */
  lookFix: '/v1/desk/look/fix',
  /** Talk's voice typing (3.3): `DeskHearRequest` → `DeskHeard`, unlocked only, one recording at a time. */
  hear: '/v1/desk/hear',
  /**
   * A picture a widget's view names (3.6): `DeskImageRequest` → the bytes (`image/jpeg`, `image/png` or `image/webp`),
   * only for a thing on one of the box's screens; locked, only where the widget may show it (Whombat DK-138, DK-142).
   */
  image: '/v1/desk/image',
  /**
   * The screen's outputs and their sizes in logical pixels (3.6): `DeskSizeRequest` → `DeskAck`. The page says it at
   * start and whenever they change; a second output is a monitor on the box, a screen of its own (DK-147).
   */
  size: '/v1/desk/size',
} as const;

/** The largest request body on the desk socket but a talk's, and a talk's (with up to 30 s of audio). */
export const DESK_REQUEST_MAX_BYTES = 2_048;
export const DESK_TALK_REQUEST_MAX_BYTES = 1_572_864;
/** A recording to hear (3.3): voice typing's five minutes in base64, and the largest `hear` body. */
export const DESK_HEAR_BASE64_MAX = 4 * Math.ceil(VOICE_TYPING_MAX_BYTES / 3);
export const DESK_HEAR_REQUEST_MAX_BYTES = DESK_HEAR_BASE64_MAX + 1_024;
/**
 * The largest `DeskState` the runtime sends (the console server reads no more). 96 KiB since 0.122 (CT-1065): five looks
 * with their lines and questions in four-byte characters made the widest glance 70.8 KB (64 KiB before); 2 KiB for
 * every other request since then too, for the widest `look/quiet`.
 */
export const DESK_STATE_MAX_BYTES = 524_288;
/** The largest `DeskTalkSession` the runtime sends (0.108; the console server reads no more). */
export const DESK_SESSION_MAX_BYTES = 262_144;
/** A conversation shows at most this many messages, the newest (0.108, DK-63)… */
export const DESK_SESSION_MESSAGES = 40;
/** …each at most this many paragraphs (of at most `DESK_ANSWER_MAX` code points). */
export const DESK_SESSION_PARAGRAPHS = 8;

/** Spoken questions: a WAV of 16 kHz mono signed 16-bit little-endian PCM, at most 30 s (DK-06). */
export const DESK_AUDIO_SAMPLE_RATE = 16_000;
export const DESK_AUDIO_MAX_SECONDS = 30;
/** The 44-byte header and 30 s of samples. */
export const DESK_AUDIO_MAX_BYTES = 44 + DESK_AUDIO_MAX_SECONDS * DESK_AUDIO_SAMPLE_RATE * 2;
/** `DESK_AUDIO_MAX_BYTES` in base64 (with padding). */
export const DESK_AUDIO_BASE64_MAX = 4 * Math.ceil(DESK_AUDIO_MAX_BYTES / 3);
/** A question as the screen shows it (`DeskTalk.question`), and longest answer (code points). */
export const DESK_QUESTION_MAX = 500;
export const DESK_ANSWER_MAX = 600;
/**
 * Longest question sent, typed or heard (3.3): RE2's largest count, about a minute of speech. What `hear` heard
 * past it is cut at the last whole word.
 */
export const DESK_TALK_TEXT_MAX = 1_000;

/**
 * The `LocalError` codes of the desk socket: `bad_request` (schema), `too_large` (body), `not_paired`, `locked` (the
 * screen must be unlocked), `on_phone` (`deskMayDecide` keeps this ask on the phone), `not_found` (no such ask or
 * talk), `decided` (answered elsewhere first), `backoff` (wrong PINs: wait), `busy` (one talk at a time, or one Wi-Fi
 * change, one recording to hear), `voice_unavailable` (no speech here, or Talk is off), `bad_audio` (not a 16 kHz mono
 * 16-bit WAV of at most 30 s, five minutes to hear), `no_pin` (0.101: an unlock with a PIN on a screen that has
 * none, DK-18; no try is counted), `pin_needed` (0.108: an approve of an ask with `approveWithPin` sent without its PIN,
 * DK-62); for the network
 * (0.102, CT-574) `locked` (the screen may not change Wi-Fi now) and the manager's `WIFI_ERROR_CODES` (`no_wifi`,
 * `busy`, `in_use`, `not_saved`, `invalid_passphrase`), and `unavailable` (the manager didn't answer); for Bluetooth
 * (0.109, CT-684) `locked` (the screen may not change it now), `no_bluetooth` and the Bluetooth service's other codes
 * (`busy`, `not_found`, `not_paired` — on a Bluetooth path the device isn't paired, not the screen — `unavailable`).
 * For servers (0.115, CT-863, CT-864): `locked` (*Only the time* while locked, DK-84), `not_found` (no such server in
 * the fleet) and `unavailable` (the hosts service didn't answer). For a wider choice on `decide` (0.116, CT-891):
 * `not_offered` (403: the ask doesn't offer the paired person that scope now — they may not change the agent's keys or
 * the server's asks, the ask has no such choice, or it went; nothing was decided), `pin_needed` without the PIN and
 * `no_pin` on a screen without one. For a look's quiet (0.122, CT-1065): `locked` (the screen must be unlocked),
 * `not_allowed` (403: the paired person may not manage the thing) and `not_found` (no such look, or its line went).
 */
export const DESK_SOCKET_ERRORS = [
  'bad_request',
  'too_large',
  'not_paired',
  'locked',
  'on_phone',
  'not_found',
  'decided',
  'backoff',
  'busy',
  'voice_unavailable',
  'bad_audio',
  'no_pin',
  // Approve with the PIN (0.108, CT-662).
  'pin_needed',
  // The network (0.102, CT-574).
  'no_wifi',
  'in_use',
  'not_saved',
  'invalid_passphrase',
  'unavailable',
  // Bluetooth (0.109, CT-684).
  'no_bluetooth',
  // A wider choice on an ask (0.116, CT-891).
  'not_offered',
  // Quieting a look (0.122, CT-1065).
  'not_allowed',
] as const;

/* Display text (CT-529) ------------------------------------------------------------------------------------------ */

/** The lengths the desk's display strings take, `[min, max]` code points. */
const DESK_TEXT_LENGTHS: readonly (readonly [number, number])[] = [
  [1, 2],
  [0, 8],
  [1, 8],
  [0, 16],
  [1, 16],
  [1, 24],
  [0, 40],
  [1, 40],
  [1, 48],
  [0, 60],
  [1, 60],
  [1, 80],
  [1, 120],
  [1, 160],
  [1, 200],
  [1, 300],
  [1, 400],
  [0, 500],
  [1, 500],
  [1, 600],
  // A part of a voice typing transcript (3.1): RE2's largest count.
  [0, 1000],
  // A question sent from the screen, typed or heard (3.3).
  [1, 1000],
];

/**
 * The desk's display text patterns (CT-529): any script, one line — no control, format or surrogate code points and no
 * separator but U+0020 (the categories of `ConsoleDisplayText` and the push previews) — with the length in code points
 * in the pattern (`u` flag). Unicode patterns the cross-language subset admits by name
 * (docs/contracts/cross-language.md). Core's `deskText(text, max)` makes any text fit.
 */
export const DESK_TEXT_RES: readonly RegExp[] = DESK_TEXT_LENGTHS.map(([min, max]) => textRe(min, max));

/** A display string of `min`…`max` code points (one of `DESK_TEXT_LENGTHS`). */
export function deskTextSchema(max: number, min = 1) {
  const source = textRe(min, max).source;
  const re = DESK_TEXT_RES.find((r) => r.source === source);
  if (!re) throw new Error(`no desk text pattern for ${min}…${max}`);
  return z.string().regex(re);
}
const text = deskTextSchema;

/** A brand mark the screen draws (`@whombat/brand`, Simple Icons slugs: `proxmox`, `unraid`, `linux`, …). */
export const DeskMark = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Count = z.number().int().min(0).max(1_000_000);
/** An ask's number in its burrow (`Approval.number`), or the screen's own number for a question. */
const AskNumber = z.number().int().min(1).max(1_000_000_000);

/* DeskState ------------------------------------------------------------------------------------------------------ */

/** The paired person (DK-02): first name, initials and avatar tone (1…5, `HUMAN_TONES` order; core `deskToneOf`). */
export const DeskPerson = z.object({
  name: text(40),
  initial: text(2),
  tone: z.number().int().min(1).max(5),
});

/** The agent: its name (from the runtime, never written in) and the face to draw (`@whombat/avatars`, OA-08). */
export const DeskAssistant = z.object({
  name: text(40),
  face: AgentFace,
});

/** Who the screen is paired with and their choices (DK-03, DK-06, DK-09). */
export const DeskPaired = z.object({
  person: DeskPerson,
  assistant: DeskAssistant,
  /** The person's IANA zone: the clock, Done today and quiet hours. */
  timeZone: TimeZoneName,
  lockedView: DeskLockedView,
  night: DeskNight,
  /** Inside quiet hours now (DK-09). */
  quiet: z.boolean(),
  /** Talk is on and possible (a microphone, the voice service). */
  voice: z.boolean(),
  /** False: no PIN was chosen, the pad shows only *Confirm on your phone* (0.101, DK-18). */
  hasPin: z.boolean(),
  /**
   * The PIN's length (0.103, DK-26): the pad shows this many dots and unlocks at the last. Absent while there is no
   * PIN.
   */
  pinDigits: DeskPinDigits.optional(),
});

/** The letters shown big while an owner pairs in Settings (DK-02). */
export const DeskPairing = z.object({ code: ClaimLetters, expiresAt: Rfc3339 });

/**
 * `locked`; `unlocked` until `until` (2 minutes after the last touch, or 30 s after the last face, DK-28; with `stays`, 2
 * minutes after the state's `now`, every state, DK-74); `phone` while the phone may answer, until `expiresAt`;
 * `backoff` after five wrong PINs, until `retryAt` (`deskStateValid`).
 */
export const DESK_LOCK_STATES = ['locked', 'unlocked', 'phone', 'backoff'] as const;
export const DeskLockState = z.enum(DESK_LOCK_STATES);
export const DeskLock = z.object({
  state: DeskLockState,
  until: Rfc3339.optional(),
  retryAt: Rfc3339.optional(),
  expiresAt: Rfc3339.optional(),
  /** The camera is on now (0.103, DK-30): the chip shows the camera mark (`DESK_WORDS.cameraOn`). Only with `unlocked`. */
  camera: z.boolean().optional(),
  /**
   * The camera sees someone (0.103, DK-28): the chip reads `DESK_WORDS.unlockedHere`, and `until` is at most
   * `DESK_PRESENCE_GONE_S` ahead. Only with `unlocked` and `camera`.
   */
  present: z.boolean().optional(),
  /**
   * Unlocked until someone presses Lock (0.107, CT-646; DK-74): the chip reads `DESK_WORDS.unlockedStays` (no minutes).
   * `until` still moves on with every state, so a console that stops hearing from Whombat draws it locked 2 minutes
   * later (CG-51). Only with `unlocked`.
   */
  stays: z.boolean().optional(),
});

/**
 * The camera looking for someone in front of the screen (0.107, CT-647; DK-72, DK-73), while the paired person's
 * `cameraWake` is on, outside quiet hours, on mains power, while the console shows the desk. Absent: it doesn't look,
 * and the screen goes idle by touch alone (DK-71).
 */
export const DeskPresence = z.object({
  /** The camera is on now: the glance's top bar and the clock show the camera mark (`DESK_WORDS.cameraLooking`). */
  camera: z.boolean(),
  /**
   * The camera can tell now (its latest answer was `watching` on a fresh frame): the screen is idle `DESK_AWAY_S`
   * after the last face and touch. False (starting, too dark, failed): `DESK_IDLE_S` after the last touch.
   */
  watching: z.boolean(),
  /** A face within `DESK_AWAY_S`: the glance shows (a locked screen's locked glance; a face never unlocks, DK-29). */
  here: z.boolean(),
});
export type DeskPresence = z.infer<typeof DeskPresence>;

export const DESK_TONES = ['ok', 'warn', 'bad'] as const;
export const DeskTone = z.enum(DESK_TONES);

/** A figure: processor or memory in %, temperature in °C (whole numbers). */
export const DeskMeter = z.object({
  value: z.number().int().min(-100).max(1_000),
  tone: DeskTone,
});

export const DESK_SERVER_STATES = ['ok', 'warn', 'bad', 'off'] as const;
export const DeskServerState = z.enum(DESK_SERVER_STATES);

/** A server on the glance, and the thing a talk is about (mockups 1, 3). `note`: “up 41 d”, “updating”. */
export const DeskServer = z.object({
  name: text(40),
  mark: DeskMark,
  state: DeskServerState,
  note: text(40, 0),
  cpu: DeskMeter.optional(),
  memory: DeskMeter.optional(),
  temp: DeskMeter.optional(),
  /**
   * The hosts service's id (0.115, CT-860; DK-83): touching the card opens the server's own screen. Absent: the card
   * doesn't open (DK-88).
   */
  id: DeskServerId.optional(),
  /**
   * Its storage in use, in % (0.115, CT-860; DK-80), the card's third line, in `DESK_BOX_TONES.storage`'s tones. Absent
   * (not measured): the line shows `DESK_WORDS.card.none`.
   */
  disk: DeskMeter.optional(),
});
export type DeskServer = z.infer<typeof DeskServer>;

export const DESK_TILE_ICONS = [
  'temperature',
  'heat',
  'sun',
  'power',
  'lock',
  'light',
  'water',
  'network',
  'generic',
] as const;
export const DeskTileIcon = z.enum(DESK_TILE_ICONS);

/** A home tile (mockup 1): “21.4 °C” · “Living room”. */
export const DeskTile = z.object({
  icon: DeskTileIcon,
  mark: DeskMark.optional(),
  value: text(24),
  label: text(48),
  tone: DeskTone.optional(),
});

export const DESK_ASK_KINDS = ['approval', 'question'] as const;
export const DeskAskKind = z.enum(DESK_ASK_KINDS);

/**
 * The wider answers an ask may offer beside approving once (0.116, CT-890; TF-14): `task` (allowed for this task) and
 * `agent` (always, from now on: “Don’t ask again on {server}”, “Always allow {agent} to {verb}”), core's `CommandScope`s
 * but `once`.
 */
export const DESK_CHOICE_SCOPES = ['task', 'agent'] as const;
export const DeskChoiceScope = z.enum(DESK_CHOICE_SCOPES);
/** At most this many wider choices on an ask: one per scope. */
export const DESK_ASK_CHOICES = DESK_CHOICE_SCOPES.length;

/**
 * One wider answer to an ask (0.116, CT-890): its scope and its label as the web card says it (`approvalView` →
 * `scopeChoices`, “Don’t ask again on Home Assistant”). Every one needs the PIN typed again (TF-14).
 */
export const DeskAskChoice = z.object({ scope: DeskChoiceScope, label: text(120) });
export type DeskAskChoice = z.infer<typeof DeskAskChoice>;

/**
 * Something that needs the person (mockups 1, 2). `detail`, `facts` and `approveLabel` only while unlocked; `onDesk`
 * false with `phoneReason` when `deskMayDecide` keeps it on the phone (`deskStateValid`). A question opens Talk.
 * 0.108 (CT-660): `deny` — the screen may say no to it (an approval, DK-61); `approveWithPin` — only with `onDesk`
 * false: Approve after the PIN is typed again, sent with the decision (DK-62); `inTalk` — it was asked in the screen's
 * open conversation (DK-64). Absent: false. 0.116 (CT-890, CT-892): `choices` and
 * `from`. `title` is the web card's title (`approvalView().title`, TF-15).
 */
export const DeskAsk = z.object({
  number: AskNumber,
  kind: DeskAskKind,
  title: text(120),
  at: Rfc3339,
  /** The server or thing it is about. */
  where: text(40).optional(),
  /** The assistant's question and what happens. */
  detail: text(400).optional(),
  /** The command or the target (“docker restart plex”, “blackbox · Unraid”). */
  facts: z.array(text(80)).max(3).optional(),
  /** The ask's own words for Approve (“Restart Plex”). */
  approveLabel: text(40).optional(),
  onDesk: z.boolean(),
  phoneReason: DeskPhoneReason.optional(),
  deny: z.boolean().optional(),
  approveWithPin: z.boolean().optional(),
  inTalk: z.boolean().optional(),
  /**
   * The web card's wider choices for the paired person (0.116, CT-890; TF-14), after Approve (once): `approvalView`'s
   * `scopeChoices` but `once`, in its order, each scope once. Only while unlocked, only on an ask the screen may approve
   * (`onDesk`, or `approveWithPin`) and not on a screen without a PIN: every choice needs the PIN (`decide` with `scope`
   * and `pin`). Absent: none.
   */
  choices: z.array(DeskAskChoice).min(1).max(DESK_ASK_CHOICES).optional(),
  /**
   * Who asks (0.116, CT-892; TF-15): the approval's requester as the screen names them (an agent's or a person's name);
   * the header reads `DESK_WORDS.asks` with it. Absent: the assistant.
   */
  from: text(40).optional(),
});

export const DESK_STEP_STATES = ['done', 'now', 'next'] as const;
export const DeskStepState = z.enum(DESK_STEP_STATES);
export const DeskStep = z.object({ label: text(40), state: DeskStepState });

/** What the assistant is working on (mockup 1). */
export const DeskWorking = z.object({
  title: text(120),
  steps: z.array(DeskStep).max(6),
});

export const DeskDone = z.object({ text: text(120), at: Rfc3339 });

/** `deskStatusLine`: the sentence and its muted second part. */
export const DeskStatus = z.object({ text: text(200), more: text(200).optional() });

/* This Whombat (0.101, CT-544; DK-22) ------------------------------------------------------------------------------ */

const Pct = z.number().int().min(0).max(100);

/** A figure drawn big with a small unit (“11.2” “GB”). */
export const DeskFigure = z.object({ value: text(8), unit: text(8) });

/** What the Whombat (its own data and history) or the agent (its containers and work) use of the data disk. */
export const DeskBoxPart = z.object({ key: DeskBoxPartKey, value: text(16), percent: Pct });

/**
 * This Whombat (DK-22, mockup `new-box.html`; DK-39), built by core's `deskBox` from the manager's measurements: the
 * glance's `box` while it has no servers and no tiles, its `self` (0.104) beside them. The words around the figures are
 * the page's (`DESK_WORDS.box`).
 */
export const DeskBox = z.object({
  /** “up 2 h 14 min”; empty when the manager doesn't say. */
  up: text(40, 0),
  cpu: z.object({ percent: Pct, cores: z.number().int().min(1).max(4096), tone: DeskTone }),
  memory: z.object({ percent: Pct, used: DeskFigure, total: text(16), tone: DeskTone }),
  /** The last hour, oldest first, one point per `stepS`, ending now; both the same length; null where unmeasured. */
  history: z.object({
    stepS: z.number().int().min(1).max(3600),
    cpu: z.array(Pct.nullable()).max(DESK_BOX_POINTS),
    memory: z.array(Pct.nullable()).max(DESK_BOX_POINTS),
  }),
  /** The data disk: `percent` used, `free` and `total`; parts in the order whombat, agent, only those measured. */
  storage: z.object({
    percent: Pct,
    free: DeskFigure,
    total: text(16),
    tone: DeskTone,
    parts: z.array(DeskBoxPart).max(DESK_BOX_PARTS.length),
  }),
  /** The processor's, °C; absent without a sensor. */
  temp: DeskMeter.optional(),
  /** Per second over the last step; null when not known. */
  network: z.object({ down: text(16), up: text(16) }).nullable(),
});
export type DeskBox = z.infer<typeof DeskBox>;

/* Found on your network (0.110, CT-700; Whombat desk-found.md DF-01…DF-12) ----------------------------------------- */

/** The glance names at most this many things found (DF-03, two rows of four); the rest are counted. */
export const DESK_FOUND_ITEMS = 8;

/**
 * A service the scan found that isn't connected yet (DF-01, DF-08): its catalog entry (the mark, DF-12: an unknown id
 * draws the name's first letter), the entry's name (“Home Assistant”), its tagline (“Lights, heating and sensors”) and
 * the address as shown (“10.100.0.5”, “10.100.0.20:32400”: the scheme and the scheme's own port left out).
 */
export const DeskFoundItem = z.object({
  catalogId: CatalogIdText,
  name: text(60),
  tagline: text(40),
  address: text(120),
});
export type DeskFoundItem = z.infer<typeof DeskFoundItem>;

/** How far the first automatic scan is (DF-07): addresses looked at, of all it looks at. */
export const DeskFoundProgress = z.object({ done: Count, total: Count });

/**
 * Found on your network (DF-01…DF-07): present exactly when the panel or the strip shows (DF-06) — not in *Only the
 * time* locked, not after *Not now*, not when nothing new is left. `scanning`: a scan runs now. `progress`: only while
 * the burrow's first automatic scan runs (DF-07; null before it knows how many addresses). `items`: the first
 * `DESK_FOUND_ITEMS` in catalog order, then by address (DF-03); `count`: every new one, `items` included. `finishedAt`:
 * when the result shown was finished; null while the first scan runs (`deskStateValid`).
 */
export const DeskFound = z.object({
  scanning: z.boolean(),
  progress: DeskFoundProgress.nullable(),
  items: z.array(DeskFoundItem).max(DESK_FOUND_ITEMS),
  count: Count,
  finishedAt: Rfc3339.nullable(),
});
export type DeskFound = z.infer<typeof DeskFound>;

/**
 * A server, connection or device that is down or needs a look (0.118, CT-970; Whombat desk-display.md DK-93): `key` the
 * thing's id on Home (`server:pve-02`, `connection:con_…`), the same between states; `name` as the server card or the
 * sidebar names it; `reason` why, when Whombat knows (“2 integrations not loading”, “Filling up”); `server` a server's
 * id when its card opens (DK-83), so the look's card can open it too and *Ask {assistant} to fix it* can name it
 * (`DeskTalkRequest.server`, DK-96).
 */
export const DeskLook = z.object({
  key: text(120),
  kind: DeskLookKind,
  name: text(40),
  state: DeskLookState,
  reason: text(120).optional(),
  server: DeskServerId.optional(),
  /**
   * The line the look comes from (0.122, CT-1065; QN-20): its check and item, as `look/quiet` takes them back. Absent:
   * the look can't be quieted from the screen.
   */
  notice: z.object({ check: NoticeCheck, subject: text(160).optional() }).optional(),
  /**
   * `problem` (*Ask {assistant} to look into it* · *Ignore* · *Not now*) or `you` (only a person can do it: *Ignore* ·
   * *Not now*, no assistant button). Absent: a problem, as in 0.118. A heads-up is never a look.
   */
  nature: NoticeNature.optional(),
  /** When you'll hear again after *Ignore*, the line's own words (“Until it’s back online.”). */
  ignoreWords: text(60).optional(),
  /** The line's own question for *Ask {assistant} to look into it* (“Why is Hallway AP offline in UniFi?”). */
  question: text(300).optional(),
  /**
   * What the assistant found out (3.5; Whombat look-research.md): while `looking` the card says so; once `found` its
   * title and summary are the card's words and its `fix` the first button (`look/fix`), *Ask {assistant}* asks about it
   * in Talk; `fixing` and `fixed` say where the step is. Absent or `failed`: the card as before.
   */
  research: LookResearch.optional(),
});
export type DeskLook = z.infer<typeof DeskLook>;

/**
 * `items` hold at most five; empty unless the lock view shows titles (DK-03) or the screen is unlocked. `count` counts
 * the asks only. `looks` (0.118, CT-970; DK-93): what needs a look, `down` first, then `bad`, then `look`, at most
 * `DESK_LOOKS_MAX`; absent when there is none and in *Only the time* locked.
 */
export const DeskNeedsYou = z.object({
  count: Count,
  items: z.array(DeskAsk).max(5),
  looks: z.array(DeskLook).min(1).max(DESK_LOOKS_MAX).optional(),
});

/** The most outputs a page reports, the main one included (3.6). */
export const DESK_OUTPUTS_MAX = 4;
/**
 * A screen's grid on the desk socket (3.6): core's `DeskGrid`, which the runtime checks before it sends it. The console's
 * server passes it to the page as it is (it's opaque to the cross-language contracts); the page reads it as a
 * `DeskGrid`.
 */
export const DeskGridWire = z.record(z.string(), z.unknown());
export type DeskGridWire = DeskGrid;

/** An output's name as the compositor gives it, lower case (`edp-1`, `hdmi-a-1`, `dp-2`). */
export const DeskOutputKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A monitor on the box with what it shows (3.6): its output, the monitor's name (its EDID's), its screen's grid. */
export const DeskOutputGrid = z.object({
  key: DeskOutputKey,
  name: text(60).nullable(),
  grid: DeskGridWire,
});
export type DeskOutputGrid = { key: string; name: string | null; grid: DeskGrid };

/**
 * The glance (mockup 1), trimmed by the runtime to what may show (DK-03): the first four servers (worst first, DK-S08)
 * and tiles, This Whombat on a new box, and the rest in optional members (DK-42).
 */
export const DeskGlance = z.object({
  status: DeskStatus,
  needsYou: DeskNeedsYou,
  working: DeskWorking.nullable(),
  done: z.array(DeskDone).max(3),
  servers: z.array(DeskServer).max(4),
  /** Every server not in `servers`, those in `extraServers` too (“+n more” where they don't fit). */
  moreServers: Count,
  tiles: z.array(DeskTile).max(4),
  /** This Whombat (0.101): present exactly when shown — no servers, no tiles, not *Only the time* locked (DK-22). */
  box: DeskBox.optional(),
  /**
   * This Whombat beside servers or tiles (0.104, DK-39): never with `box`, only on a glance with a server or a tile,
   * not *Only the time* locked; absent when the manager doesn't answer. The screen shows it as a panel or a card.
   */
  self: DeskBox.optional(),
  /** Servers five to eight (0.104, DK-41), worst first after `servers`: only beside four, counted in `moreServers`. */
  extraServers: z.array(DeskServer).max(4).optional(),
  /** Tiles five to eight (0.104, DK-41): only beside four `tiles`. Tiles beyond eight are left out without a count. */
  extraTiles: z.array(DeskTile).max(4).optional(),
  /**
   * Found on your network (0.110, CT-700; DF-06): the panel on a glance without servers and tiles (where `box` would be
   * drawn), the strip beside them; the console decides which. Absent: neither shows.
   */
  found: DeskFound.optional(),
  /**
   * The calm glance (3.2, CT-1629; DK-101): what a console that knows it draws instead of the members above, which stay
   * for an older one. Absent from an older runtime.
   */
  calm: DeskCalm.optional(),
  /**
   * The screen of widgets (3.6; Whombat DK-126…DK-149): what a console that knows it draws under its top bar instead of
   * the calm glance, whose members it still reads for Whombat's own widgets. Absent from an older runtime.
   */
  grid: DeskGridWire.optional(),
  /**
   * Monitors on the box (3.6, DK-147): each output the page reported besides its main one, with its screen's grid.
   */
  outputs: z.array(DeskOutputGrid).max(DESK_OUTPUTS_MAX).optional(),
});

/** The battery (DK-10): `HostPower` of the manager's host metrics. */
export const DeskPower = z.object({
  source: HostPowerSource,
  percent: z.number().int().min(0).max(100),
  charging: z.boolean(),
  minutesLeft: z.number().int().min(0).max(100_000).nullable(),
  chargeLimit: z.number().int().min(0).max(100).nullable(),
  since: Rfc3339.nullable(),
});

/**
 * `transcribing`, `thinking`, then `answered` or `failed`. Since 0.116 (CT-893; TF-16) a talk without an answer after
 * `DESK_TALK_WORKING_S` (90 s) is `working` (`DESK_WORDS.working`, not final): it waits for the turn to end, at most
 * `DESK_TALK_WAIT_MAX_S` (30 minutes) after the question, then `answered`, or `failed` with `slow`. The screen keeps
 * following it, and counts it as use (TF-18).
 */
export const DESK_TALK_STATES = ['transcribing', 'thinking', 'answered', 'failed', 'working'] as const;
export const DeskTalkState = z.enum(DESK_TALK_STATES);
/** `not_heard`: no words in the audio; `slow`: no answer in time (since 0.116, 30 minutes; it still lands in Chat). */
export const DESK_TALK_REASONS = ['not_heard', 'slow', 'voice_unavailable', 'failed'] as const;
export const DeskTalkReason = z.enum(DESK_TALK_REASONS);

/**
 * A talk (mockup 3): the question once heard, the answer once there (made plain for speech), the server or thing it is
 * about, whether its audio can be fetched (`talk/audio`). `answer` exactly when `answered`, `reason` exactly when
 * `failed` (`deskTalkValid`).
 */
export const DeskTalk = z.object({
  id: Id,
  state: DeskTalkState,
  question: text(DESK_QUESTION_MAX).optional(),
  answer: text(DESK_ANSWER_MAX).optional(),
  thing: DeskServer.nullable(),
  audio: z.boolean(),
  reason: DeskTalkReason.optional(),
});
export type DeskTalk = z.infer<typeof DeskTalk>;

/**
 * Remote help while it is on (0.120, CT-943; RH-12): its level, until when (null: forever) and who of Whombat support is
 * connected (the newest, display text of at most 40; null: nobody). Shown on every screen of the glance, locked or not,
 * paired or not, with *Stop* (`remoteHelpStop`); the words are core's `REMOTE_HELP_WORDS.desk` (`remoteHelpDeskLine`).
 */
export const DeskRemoteHelp = z.object({
  level: RemoteHelpLevel,
  until: Rfc3339.nullable(),
  connected: text(40).nullable(),
});
export type DeskRemoteHelp = z.infer<typeof DeskRemoteHelp>;

/**
 * `GET /v1/desk/state` (DK-12): what the screen shows now. `paired` null: nobody paired it (the console shows the
 * claimed screen, CG-*); then `glance` and `talk` are null and the lock `locked`. `pairing` while Settings pairs.
 * `talk` is the latest, so a reloaded page picks it up. `deskStateValid` checks what one schema can't.
 */
export const DeskState = z.object({
  v: V,
  now: Rfc3339,
  paired: DeskPaired.nullable(),
  pairing: DeskPairing.nullable(),
  lock: DeskLock,
  glance: DeskGlance.nullable(),
  power: DeskPower.nullable(),
  talk: DeskTalk.nullable(),
  /** 0.107 (CT-647; DK-72): the camera looking for someone; absent when it doesn't. */
  presence: DeskPresence.optional(),
  /** 0.120 (CT-943; RH-12): remote help while it is on; absent when it is off. */
  remoteHelp: DeskRemoteHelp.optional(),
  /** 3.2 (CT-1630; DK-119): the Whombat's name for the top bar, once the app gave it; absent before (the org's name). */
  name: DeskWhombatName.optional(),
});
export type DeskState = z.infer<typeof DeskState>;

/** `answer` exactly when `answered`, `reason` exactly when `failed` (so neither while `working`, 0.116). */
export function deskTalkValid(t: { state: string; answer?: string; reason?: string }): boolean {
  return (
    (t.state === 'answered') === (t.answer !== undefined) &&
    (t.state === 'failed') === (t.reason !== undefined)
  );
}

/**
 * What the schema can't say (CT-530): the lock's time exactly in its state (`until` in `unlocked`, `expiresAt` in
 * `phone`, `retryAt` in `backoff`); nobody paired → locked, no glance, no talk; an ask's words (`detail`, `facts`,
 * `approveLabel`) only while unlocked; `phoneReason` exactly when not `onDesk`; no more items than `count`; a valid
 * talk. 0.101 (CT-545): a `box` only on a glance without servers and tiles, and not while locked in *Only the time*;
 * its history's two series the same length. 0.103 (CT-596): `camera` or `present` true only while `unlocked`, and
 * `present` true only with `camera` true (false says nothing, wherever it is). 0.104 (CT-601, CT-602): a `self` never
 * with `box`, only on a glance with a server or a tile, not while locked in *Only the time*, its two series the same
 * length; `extraServers` only beside four `servers`, and no more of them than `moreServers`; `extraTiles` only beside
 * four `tiles` (an empty list says nothing, wherever it is). 0.107 (CT-648): `stays` true only while `unlocked`; a
 * `presence` only while paired. 0.108 (CT-660): `approveWithPin` true only with `onDesk` false. 0.110 (CT-700): `found`
 * not while locked in *Only the time*; no more `items` than `count`; `finishedAt` null only while `scanning`; `progress`
 * only while `scanning` with `finishedAt` null, `done` at most `total`; `count` 0 only while the first scan looks
 * (`finishedAt` null). 0.116 (CT-890): an ask's `choices` only while unlocked, only on an ask the screen may approve
 * (`onDesk` or `approveWithPin`), not on a screen without a PIN (`hasPin` false), each scope once. The console server
 * shows no desk for a state that fails it.
 */
export function deskStateValid(s: DeskState): boolean {
  const l = s.lock;
  if ((l.state === 'unlocked') !== (l.until !== undefined)) return false;
  if ((l.state === 'phone') !== (l.expiresAt !== undefined)) return false;
  if ((l.state === 'backoff') !== (l.retryAt !== undefined)) return false;
  if (l.state !== 'unlocked' && (l.camera === true || l.present === true)) return false;
  if (l.present === true && l.camera !== true) return false;
  if (l.stays === true && l.state !== 'unlocked') return false;
  if (s.paired === null && (s.glance !== null || s.talk !== null || l.state !== 'locked')) return false;
  if (s.paired === null && s.presence !== undefined) return false;
  if (s.talk !== null && !deskTalkValid(s.talk)) return false;
  const g = s.glance;
  if (g === null) return true;
  const timeOnly = l.state !== 'unlocked' && s.paired?.lockedView === 'time';
  const serversOrTiles = g.servers.length > 0 || g.tiles.length > 0;
  const seriesAlike = (b: DeskBox) => b.history.cpu.length === b.history.memory.length;
  if (g.box !== undefined && (serversOrTiles || timeOnly || !seriesAlike(g.box))) return false;
  if (g.self !== undefined && (g.box !== undefined || !serversOrTiles || timeOnly || !seriesAlike(g.self)))
    return false;
  const extraServers = g.extraServers?.length ?? 0;
  if (extraServers > 0 && (g.servers.length !== 4 || g.moreServers < extraServers)) return false;
  if ((g.extraTiles?.length ?? 0) > 0 && g.tiles.length !== 4) return false;
  if (g.found !== undefined && (timeOnly || !deskFoundValid(g.found))) return false;
  if (g.needsYou.looks !== undefined && timeOnly) return false;
  const items = g.needsYou.items;
  if (items.length > g.needsYou.count) return false;
  const noPin = s.paired?.hasPin === false;
  return items.every(
    (a) =>
      a.onDesk === (a.phoneReason === undefined) &&
      !(a.approveWithPin === true && a.onDesk) &&
      (l.state === 'unlocked' ||
        (a.detail === undefined && a.facts === undefined && a.approveLabel === undefined)) &&
      (a.choices === undefined ||
        (l.state === 'unlocked' &&
          (a.onDesk || a.approveWithPin === true) &&
          !noPin &&
          new Set(a.choices.map((c) => c.scope)).size === a.choices.length)),
  );
}

/**
 * What the schema can't say of `DeskFound` (0.110, CT-700): no more `items` than `count`; `finishedAt` null only while
 * `scanning` (the first scan, nothing finished yet); `progress` only then, `done` at most `total`; `count` 0 only while
 * the first scan looks (a finished result with nothing new doesn't show, DF-06).
 */
export function deskFoundValid(f: DeskFound): boolean {
  if (f.items.length > f.count) return false;
  if (f.finishedAt === null && !f.scanning) return false;
  if (f.progress !== null && (f.finishedAt !== null || f.progress.done > f.progress.total)) return false;
  return f.count > 0 || f.finishedAt === null;
}

/* Requests and answers ------------------------------------------------------------------------------------------- */

/** `lock`, `touch` and `unlock/phone` take nothing but the version. */
export const DeskRequest = z.strictObject({ v: V });
/** `lock` and `decide` answer only the version. */
export const DeskAck = z.object({ v: V });

/** *Ignore* (until it changes) or *Not now* (until 09:00 tomorrow) on a look (0.122, CT-1065; QN-20). */
export const DESK_LOOK_QUIET_HOWS = ['ignore', 'snooze'] as const;
export const DeskLookQuietHow = z.enum(DESK_LOOK_QUIET_HOWS);
export type DeskLookQuietHow = z.infer<typeof DeskLookQuietHow>;

/**
 * Quiet a look from the screen (0.122, CT-1065; QN-20): `key` the look's, `notice` its line as `DeskLook.notice` gave
 * it, `how` *Ignore* or *Not now*. As the paired person, only while unlocked (the PIN first, like Approve); the runtime
 * quiets the line for the whole Whombat as `things.quiet` does (QN-14) and answers 403 `not_allowed` when the person
 * may not manage the thing, 404 `not_found` when the look or its line went.
 */
export const DeskLookQuietRequest = z.strictObject({
  v: V,
  key: text(120),
  notice: z.strictObject({ check: NoticeCheck, subject: text(160).optional() }),
  how: DeskLookQuietHow,
});
export type DeskLookQuietRequest = z.infer<typeof DeskLookQuietRequest>;

/**
 * The step the assistant offers on a look (3.5; Whombat look-research.md): `key` the look's. The press is the person's
 * go-ahead for that one step: the runtime wakes the assistant to take it as the paired person, only while unlocked (the
 * PIN first, like Approve), and answers 403 `not_allowed` when the person may not manage the thing, 404 `not_found`
 * when the look went or offers no step (any more).
 */
export const DeskLookFixRequest = z.strictObject({ v: V, key: text(120) });
export type DeskLookFixRequest = z.infer<typeof DeskLookFixRequest>;

/** The PIN typed on the pad: 4 to 6 digits since 0.103 (DK-26), core's `DESK_PIN_RE`. */
export const DeskUnlockRequest = z.strictObject({ v: V, pin: z.string().regex(DESK_PIN_RE) });
export type DeskUnlockRequest = z.infer<typeof DeskUnlockRequest>;

export const DESK_UNLOCK_RESULTS = ['unlocked', 'wrong', 'backoff'] as const;
export const DeskUnlockResult = z.enum(DESK_UNLOCK_RESULTS);
/** `triesLeft` with `wrong` (before the wait), `retryAt` with `backoff`. */
export const DeskUnlockAnswer = z.object({
  v: V,
  result: DeskUnlockResult,
  triesLeft: z.number().int().min(0).max(5).optional(),
  retryAt: Rfc3339.optional(),
});
export type DeskUnlockAnswer = z.infer<typeof DeskUnlockAnswer>;

/** The phone was asked; Unlock or No until then (2 minutes). */
export const DeskPhoneUnlockAnswer = z.object({ v: V, expiresAt: Rfc3339 });
/** Unlocked until then. */
export const DeskTouchAnswer = z.object({ v: V, until: Rfc3339 });

/**
 * `approve` — the person's yes, once; `decline` — the screen's *Not now*, Home's snooze until tomorrow, not a no (DK-S19);
 * `deny` (0.108, DK-61) — the person's no, as in Chat: the assistant hears it.
 */
export const DESK_DECISIONS = ['approve', 'decline', 'deny'] as const;
export const DeskDecision = z.enum(DESK_DECISIONS);
/**
 * How far an approve reaches (0.116, CT-891; TF-14): `once` (as before), or one of the ask's wider choices, `task` or
 * `agent` (core's `CommandScope`, as `approvals.decide` takes it).
 */
export const DESK_DECIDE_SCOPES = COMMAND_SCOPES;
export const DeskDecideScope = z.enum(DESK_DECIDE_SCOPES);
export type DeskDecideScope = z.infer<typeof DeskDecideScope>;

/**
 * Approve, Deny or Not now on the screen (DK-05, DK-61): as the paired person, only while unlocked. `pin` (0.108,
 * DK-62): the PIN typed again to approve an ask with `approveWithPin`, or with a wider `scope`; checked as an unlock's,
 * and only then. `scope` (0.116, CT-891; TF-14): one of the ask's `choices`, only with `approve`
 * (`deskDecideRequestValid`; absent: once). The runtime answers 403 `not_offered` for a scope the ask doesn't offer the
 * person now, `pin_needed` without the PIN (`deskDecideNeedsPin`), `no_pin` on a screen without one.
 */
export const DeskDecideRequest = z.strictObject({
  v: V,
  number: AskNumber,
  decision: DeskDecision,
  pin: z.string().regex(DESK_PIN_RE).optional(),
  scope: DeskDecideScope.optional(),
});
export type DeskDecideRequest = z.infer<typeof DeskDecideRequest>;

/** What the schema can't say of `decide` (0.116, CT-891): a `scope` only with `approve`. */
export function deskDecideRequestValid(r: { decision: string; scope?: string }): boolean {
  return r.scope === undefined || r.decision === 'approve';
}

/**
 * Whether a decision needs the PIN typed again (0.108, DK-62; 0.116, CT-891, TF-14): an approve of an ask with
 * `approveWithPin`, or an approve with any scope wider than once. Deny and *Not now* never do. The rule is fixed, so an
 * ask carries no flag per choice.
 */
export function deskDecideNeedsPin(
  ask: { approveWithPin?: boolean },
  request: { decision: string; scope?: string },
): boolean {
  if (request.decision !== 'approve') return false;
  return ask.approveWithPin === true || (request.scope !== undefined && request.scope !== 'once');
}

/** `decided`; with a PIN (DK-62) as an unlock's: `wrong` (with `triesLeft`) or `backoff` (with `retryAt`). */
export const DESK_DECIDE_RESULTS = ['decided', 'wrong', 'backoff'] as const;
export const DeskDecideResult = z.enum(DESK_DECIDE_RESULTS);
/**
 * `decide`'s answer (0.108, CT-663). `talk`: the
 * talk that waits for the assistant's next words after a decision on an ask asked in the open conversation (DK-63); the
 * page follows it as a question's.
 */
export const DeskDecideAnswer = z.object({
  v: V,
  result: DeskDecideResult,
  triesLeft: z.number().int().min(0).max(5).optional(),
  retryAt: Rfc3339.optional(),
  talk: Id.optional(),
});
export type DeskDecideAnswer = z.infer<typeof DeskDecideAnswer>;

/** A WAV in standard base64 with padding. */
export const DeskWav = z
  .string()
  .min(60)
  .max(DESK_AUDIO_BASE64_MAX)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/**
 * Ask the assistant (DK-06): typed `text` or spoken `audioWav` (exactly one, `deskTalkRequestValid`); `continue`
 * replies in the open conversation's Chat thread while it is open (since 0.108 until it is closed or nothing was said in
 * it for `DESK_TALK_SESSION_IDLE_S`, DK-64; before, 2 minutes), else a new thread; false starts a new conversation.
 */
export const DeskTalkRequest = z.strictObject({
  v: V,
  text: text(DESK_TALK_TEXT_MAX).optional(),
  audioWav: DeskWav.optional(),
  continue: z.boolean(),
  /**
   * *Ask {assistant} about {server}* (0.115, CT-865; DK-85): the server whose screen the person asked from. The runtime
   * tells the assistant which server they were looking at (`DeskDispatchContext.server`), never in the chat; an id it
   * doesn't know is left out.
   */
  server: DeskServerId.optional(),
  /**
   * 3.3: the `text` came from Talk's mic (`hear`), edited or not: the assistant's turn hears it came by voice
   * (DK-T05). Absent: typed. With `audioWav` it is spoken anyway.
   */
  spoken: z.boolean().optional(),
});
export type DeskTalkRequest = z.infer<typeof DeskTalkRequest>;

/** Exactly one of `text` and `audioWav`. */
export function deskTalkRequestValid(r: { text?: string; audioWav?: string }): boolean {
  return (r.text !== undefined) !== (r.audioWav !== undefined);
}

export const DeskTalkStarted = z.object({ v: V, id: Id });

/** A recording to hear (3.3): voice typing's WAV (16 kHz mono 16-bit, at most five minutes) in base64. */
export const DeskHearWav = z
  .string()
  .min(60)
  .max(DESK_HEAR_BASE64_MAX)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** `POST /v1/desk/hear` (3.3): Talk's mic, voice typing at the screen. */
export const DeskHearRequest = z.strictObject({ v: V, audioWav: DeskHearWav });
export type DeskHearRequest = z.infer<typeof DeskHearRequest>;

/**
 * What was heard (3.3), for Talk's box: one line of at most `DESK_TALK_TEXT_MAX` code points, empty when nothing
 * was heard (silence, or only the speech service's notes about the sound). Nothing is posted.
 */
export const DeskHeard = z.object({ v: V, text: text(DESK_TALK_TEXT_MAX, 0) });
export type DeskHeard = z.infer<typeof DeskHeard>;
/** `talk/get` and `talk/audio`. */
export const DeskTalkRef = z.strictObject({ v: V, id: Id });

/* The conversation (0.108, CT-664; DK-63, DK-64) ------------------------------------------------------------------ */

/** What became of an ask asked in the conversation: still waiting, approved, or denied (declined). */
export const DESK_SESSION_ASK_STATES = ['waiting', 'approved', 'denied'] as const;
export const DeskSessionAskState = z.enum(DESK_SESSION_ASK_STATES);
export const DeskSessionAsk = z.object({ number: AskNumber, state: DeskSessionAskState });

/** A server task's state on the screen (0.116, CT-895): core's `TASK_CARD_STATES`, labels `DESK_WORDS.tasks`. */
export const DESK_TASK_STATES = TASK_CARD_STATES;
export const DeskTaskState = z.enum(DESK_TASK_STATES);

/**
 * A server task's card in the conversation (0.116, CT-895; TF-17), as a live row: its `title` (the running words), its
 * `state`, when it started and, once it ended, when (`endedAt`) and its `result` (the outcome words). The page draws it
 * with core's task card helpers (`taskCardLine`: the time it has run, then how it went and how long it took).
 * `endedAt` exactly when not `running`, `result` only then (`deskTalkSessionValid`).
 */
export const DeskSessionTask = z.object({
  title: text(120),
  state: DeskTaskState,
  startedAt: Rfc3339,
  endedAt: Rfc3339.optional(),
  result: text(DESK_ANSWER_MAX).optional(),
});
export type DeskSessionTask = z.infer<typeof DeskSessionTask>;

export const DESK_SESSION_FROM = ['you', 'assistant'] as const;
export const DeskSessionFrom = z.enum(DESK_SESSION_FROM);

/**
 * One message of the conversation, made plain (desk-display-talk.md DK-T15): its paragraphs (list items with “• ”);
 * `more` — something of it is only in Chat (code, a table, a picture, a file, or it was cut); `ask` — an approval's card;
 * `talk` — the desk talk it was the question or the answer of, with `audio` while that answer's sound can be fetched
 * (`talk/audio`) and `thing`, the server the answer names. `task` (0.116, CT-895) — a server task's card, a live row;
 * its paragraph is the card's line. Never both `ask` and `task`.
 */
export const DeskSessionMessage = z.object({
  id: Id,
  from: DeskSessionFrom,
  at: Rfc3339,
  paragraphs: z.array(text(DESK_ANSWER_MAX)).min(1).max(DESK_SESSION_PARAGRAPHS),
  more: z.boolean().optional(),
  ask: DeskSessionAsk.optional(),
  talk: Id.optional(),
  audio: z.boolean().optional(),
  thing: DeskServer.optional(),
  task: DeskSessionTask.optional(),
});
export type DeskSessionMessage = z.infer<typeof DeskSessionMessage>;

/**
 * The assistant working in the conversation's thread (0.116, CT-894; TF-17): one of its turns runs there, `since` it
 * started, and `doing` its current activity as Chat's activity says it (“Installing updates on pve-02”), absent when
 * there is none to say. The page shows a working row at the bottom (`doing`, else `DESK_WORDS.working`).
 */
export const DeskSessionWorking = z.object({ since: Rfc3339, doing: text(120).optional() });
export type DeskSessionWorking = z.infer<typeof DeskSessionWorking>;

/**
 * `POST /v1/desk/talk/session` (DK-63): the open conversation, oldest first, the newest `DESK_SESSION_MESSAGES`;
 * `earlier` counts the ones left out (they are in Chat). `open` false: none (closed, timed out, never started), `messages`
 * empty. `until`: when it times out unless something is said (`DESK_TALK_SESSION_IDLE_S` after the last message).
 * `working` (0.116, CT-894): the assistant is working in it now; only while open. The runtime keeps the answer within
 * `DESK_SESSION_MAX_BYTES`, leaving the oldest messages out (`earlier`).
 */
export const DeskTalkSession = z.object({
  v: V,
  open: z.boolean(),
  messages: z.array(DeskSessionMessage).max(DESK_SESSION_MESSAGES),
  earlier: Count,
  until: Rfc3339.optional(),
  working: DeskSessionWorking.optional(),
});
export type DeskTalkSession = z.infer<typeof DeskTalkSession>;

/**
 * Nothing shows of a closed conversation; `until` only while open. 0.116 (CT-894, CT-895): `working` only while open;
 * a message's `task` has `endedAt` exactly when not `running` and a `result` only then, and no message has both `ask`
 * and `task`.
 */
export function deskTalkSessionValid(s: {
  open: boolean;
  messages: readonly {
    ask?: unknown;
    task?: { state: string; endedAt?: string; result?: string };
    [member: string]: unknown;
  }[];
  earlier: number;
  until?: string;
  working?: unknown;
}): boolean {
  const messagesValid = s.messages.every(
    (m) =>
      m.task === undefined ||
      (m.ask === undefined &&
        (m.task.state === 'running') === (m.task.endedAt === undefined) &&
        !(m.task.state === 'running' && m.task.result !== undefined)),
  );
  if (!messagesValid) return false;
  return s.open
    ? s.until !== undefined
    : s.messages.length === 0 && s.earlier === 0 && s.until === undefined && s.working === undefined;
}

/* A server's own screen (0.115, CT-863…CT-866; DK-83…DK-87) --------------------------------------------------------- */

/** *Servers* shows at most this many (DK-86); the rest are counted. */
export const DESK_SERVERS = 24;

/**
 * `POST /v1/desk/servers` (`DeskRequest`, DK-86): every server of the fleet as the glance's cards, worst first in the
 * glance's order (DK-S08), the first `DESK_SERVERS`; `more` counts the rest. Locked too, not in *Only the time*.
 */
export const DeskServersAnswer = z.object({
  v: V,
  servers: z.array(DeskServer).max(DESK_SERVERS),
  more: Count,
});
export type DeskServersAnswer = z.infer<typeof DeskServersAnswer>;

/** A server's screen: which server, and how far back its chart looks (24 hours when it opens). */
export const DeskServerRequest = z.strictObject({ v: V, id: DeskServerId, range: DeskServerRange });

/** `image` (3.6): the thing and the signed ref a view names. */
export const DeskImageRequest = z.strictObject({
  v: V,
  thing: DeskWidgetRef,
  ref: z
    .string()
    .min(16)
    .max(600)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
export type DeskImageRequest = z.infer<typeof DeskImageRequest>;
/** The largest picture `image` answers. */
export const DESK_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * `size` (3.6): every output the page shows on, the main one (the box's own display, or the only one) first, each with
 * its size in logical pixels and the monitor's name when the compositor knows it.
 */
export const DeskSizeRequest = z.strictObject({
  v: V,
  outputs: z
    .array(
      z.strictObject({
        key: DeskOutputKey,
        main: z.boolean(),
        name: text(60).nullable(),
        size: DeskScreenSize,
      }),
    )
    .min(1)
    .max(DESK_OUTPUTS_MAX),
});
export type DeskSizeRequest = z.infer<typeof DeskSizeRequest>;
export type DeskServerRequest = z.infer<typeof DeskServerRequest>;

/** At most this many points per series in a server's chart (a quarter of an hour over 24 hours). */
export const DESK_SERVER_POINTS = 96;
/** At most this many volumes (fullest first), guests (running first, busiest first) and alert titles (worst first). */
export const DESK_SERVER_VOLUMES = 6;
export const DESK_SERVER_GUESTS = 6;
export const DESK_SERVER_ALERTS = 3;
/** The largest `DeskServerPage` the runtime sends (the console server reads no more). */
export const DESK_SERVER_MAX_BYTES = 32_768;

export const DESK_GUEST_KINDS = ['vm', 'container'] as const;
export const DeskGuestKind = z.enum(DESK_GUEST_KINDS);

/** An open alert's tone on a server's screen: a warning or critical. */
export const DESK_SERVER_ALERT_TONES = ['warn', 'bad'] as const;
export const DeskServerAlertTone = z.enum(DESK_SERVER_ALERT_TONES);

const Temp = z.number().int().min(-100).max(1_000);

/** The processor now: `cores` null when not known, `load` the first load average (“2.9”; empty when not known). */
export const DeskServerCpu = z.object({
  percent: Pct,
  cores: z.number().int().min(1).max(4096).nullable(),
  load: text(8, 0),
  tone: DeskTone,
});

/** Memory now: `used` big with its unit (“69” “GB”), `total` (“128 GB”). */
export const DeskServerMemory = z.object({ percent: Pct, used: DeskFigure, total: text(16), tone: DeskTone });

/**
 * Storage in use: `used` (“1.2 TB”, or “1.2” in the total's unit, mockup 2's “1.2 of 3.6 TB”) and `total` (“3.6 TB”), in
 * `DESK_BOX_TONES.storage`'s tones.
 */
export const DeskServerDisk = z.object({ percent: Pct, used: text(16), total: text(16), tone: DeskTone });

/** The hottest sensor and its limit, °C, in the card's temperature tones (warm 15° under the limit, hot at it). */
export const DeskServerTemp = z.object({ value: Temp, limit: Temp, tone: DeskTone });

/**
 * The chart (DK-83): one point per `stepS`, oldest first, ending now; both series the same length; null where nothing
 * was measured. `cpuPeak` the highest CPU point and when; `memoryAvg` memory's mean; both null without points.
 */
export const DeskServerHistory = z.object({
  range: DeskServerRange,
  stepS: z.number().int().min(1).max(86_400),
  cpu: z.array(Pct.nullable()).max(DESK_SERVER_POINTS),
  memory: z.array(Pct.nullable()).max(DESK_SERVER_POINTS),
  cpuPeak: z.object({ percent: Pct, at: Rfc3339 }).nullable(),
  memoryAvg: Pct.nullable(),
});

/** A volume (“local-zfs”), what it is (“nvme mirror”, “on nas”; may be empty) and how full. */
export const DeskServerVolume = z.object({
  name: text(40),
  note: text(40, 0),
  percent: Pct,
  used: text(16),
  total: text(16),
  tone: DeskTone,
});

/** A guest: its CPU (null when off or not known) and memory in use (“6.1 GB”; empty when off). */
export const DeskServerGuest = z.object({
  name: text(60),
  kind: DeskGuestKind,
  state: DeskGuestState,
  cpu: Pct.nullable(),
  memory: text(16, 0),
});

/** How many guests run and how many are off, and the first `DESK_SERVER_GUESTS` of them. */
export const DeskServerGuestList = z.object({
  running: Count,
  off: Count,
  items: z.array(DeskServerGuest).max(DESK_SERVER_GUESTS),
});

/** An open alert: its tone and title. */
export const DeskServerAlert = z.object({ tone: DeskServerAlertTone, title: text(120) });

/**
 * The server's open alerts: `count` all of them, locked too; `items` worst first, only while unlocked or with
 * *Everything* (DK-84, DK-03: words stay off a locked screen unless the person chose them), else empty.
 */
export const DeskServerAlertList = z.object({
  count: Count,
  items: z.array(DeskServerAlert).max(DESK_SERVER_ALERTS),
});

/**
 * `POST /v1/desk/server` (DK-83, mockup 2): a server's own screen, to look at. `server` the card (with the id asked
 * for); `os` (“Proxmox VE 9.0.10”) and `up` (“up 41 d”) empty when not known (`up` also when off); the four figures null
 * when not known (all four when off); `guests` null when the server has none; `network` per second over the last step
 * (as `DeskBox.network`). Refreshed every 10 s while it shows. `deskServerPageValid` checks what one schema can't.
 */
export const DeskServerPage = z.object({
  v: V,
  now: Rfc3339,
  server: DeskServer,
  os: text(60, 0),
  up: text(40, 0),
  cpu: DeskServerCpu.nullable(),
  memory: DeskServerMemory.nullable(),
  disk: DeskServerDisk.nullable(),
  temp: DeskServerTemp.nullable(),
  history: DeskServerHistory,
  volumes: z.array(DeskServerVolume).max(DESK_SERVER_VOLUMES),
  guests: DeskServerGuestList.nullable(),
  network: z.object({ down: text(16), up: text(16) }).nullable(),
  alerts: DeskServerAlertList,
});
export type DeskServerPage = z.infer<typeof DeskServerPage>;

/**
 * What the schema can't say of a server's screen (0.115, CT-866): the card has its id; the chart's two series the same
 * length; no more alert `items` than `count`; no more guest `items` than `running` and `off` together. The console
 * server also checks that `server.id` is the id it asked for, and shows no page for one that fails either.
 */
export function deskServerPageValid(p: DeskServerPage): boolean {
  if (p.server.id === undefined) return false;
  if (p.history.cpu.length !== p.history.memory.length) return false;
  if (p.alerts.items.length > p.alerts.count) return false;
  return p.guests === null || p.guests.items.length <= p.guests.running + p.guests.off;
}

/* The network (0.102, CT-574; Whombat hardware-support.md HD-07) -------------------------------------------------- */

/** Why the screen may not change Wi-Fi now: `locked` — the box is claimed, online and the screen is locked. */
export const DESK_NETWORK_WHY = ['locked'] as const;
export const DeskNetworkWhy = z.enum(DESK_NETWORK_WHY);

/**
 * `GET /v1/desk/network`: the manager's `HostNetwork`, and whether the screen may join or forget a network now
 * (`mayChange`, HD-07: the box isn't claimed, or `network.online` is false, or the screen is unlocked); `why` exactly
 * when it may not. Scans are allowed whenever this answers, on an unpaired screen too.
 */
export const DeskNetworkAnswer = z.object({
  v: V,
  network: HostNetwork,
  mayChange: z.boolean(),
  why: DeskNetworkWhy.optional(),
});
export type DeskNetworkAnswer = z.infer<typeof DeskNetworkAnswer>;

/** `POST /v1/desk/network/wifi/scan` (`DeskRequest`): the networks around the box. */
export const DeskWifiScanAnswer = z.object({ v: V, scan: WifiScan });
export type DeskWifiScanAnswer = z.infer<typeof DeskWifiScanAnswer>;

/**
 * Join or switch to a network from the screen (409 `locked` when it may not). The passphrase is a secret: the console
 * server passes it on and keeps nothing; never logged. The runtime adds the guard's confirm time.
 */
export const DeskWifiJoinRequest = z.strictObject({
  v: V,
  ssid: Ssid,
  passphrase: WifiPassphrase.optional(),
  hidden: z.boolean().optional(),
});
export type DeskWifiJoinRequest = z.infer<typeof DeskWifiJoinRequest>;

/** Forget a saved network from the screen (409 `locked` when it may not). */
export const DeskWifiForgetRequest = z.strictObject({ v: V, ssid: Ssid });
export type DeskWifiForgetRequest = z.infer<typeof DeskWifiForgetRequest>;

/** A join or a forget as it starts; the screen follows it through `network`. */
export const DeskWifiChangeAnswer = z.object({ v: V, change: NetworkChange });
export type DeskWifiChangeAnswer = z.infer<typeof DeskWifiChangeAnswer>;

/* Bluetooth (0.109, CT-684; Whombat bluetooth.md BT-02) ---------------------------------------------------------- */

/** Why the screen may not change Bluetooth now: `locked` — the box is claimed and the screen is locked. */
export const DESK_BLUETOOTH_WHY = ['locked'] as const;
export const DeskBluetoothWhy = z.enum(DESK_BLUETOOTH_WHY);

/**
 * `GET /v1/desk/bluetooth`: the Bluetooth service's `BluetoothState`, and whether the screen may look, pair, connect,
 * disconnect or remove now (`mayChange`, BT-02: the box isn't claimed, or the screen is unlocked); `why` exactly when it
 * may not. Without a Bluetooth service the runtime answers `adapter: null, missing: no_adapter` here and 409
 * `no_bluetooth` to every change.
 */
export const DeskBluetoothAnswer = z.object({
  v: V,
  bluetooth: BluetoothState,
  mayChange: z.boolean(),
  why: DeskBluetoothWhy.optional(),
});
export type DeskBluetoothAnswer = z.infer<typeof DeskBluetoothAnswer>;

/** `POST /v1/desk/bluetooth/scan` (`DeskRequest`): looking, as it is now (409 `locked` when it may not). */
export const DeskBluetoothScanAnswer = z.object({ v: V, scan: BluetoothScan });
export type DeskBluetoothScanAnswer = z.infer<typeof DeskBluetoothScanAnswer>;

/** Pair, connect, disconnect or remove the device with this address from the screen (409 `locked` when it may not). */
export const DeskBluetoothDeviceRequest = z.strictObject({ v: V, address: BluetoothAddress });
export type DeskBluetoothDeviceRequest = z.infer<typeof DeskBluetoothDeviceRequest>;

/** **Yes** (`accept` true) or **No** to the running pairing's question. */
export const DeskBluetoothConfirmRequest = z.strictObject({
  v: V,
  pairingId: BluetoothPairingId,
  accept: z.boolean(),
});
export type DeskBluetoothConfirmRequest = z.infer<typeof DeskBluetoothConfirmRequest>;

export const DeskBluetoothCancelRequest = z.strictObject({ v: V, pairingId: BluetoothPairingId });
export type DeskBluetoothCancelRequest = z.infer<typeof DeskBluetoothCancelRequest>;

/** The pairing as it is now; the screen follows it through `bluetooth`. A remove answers `DeskAck`. */
export const DeskBluetoothPairingAnswer = z.object({ v: V, pairing: BluetoothPairing });
export type DeskBluetoothPairingAnswer = z.infer<typeof DeskBluetoothPairingAnswer>;

/** The paired device after a connect or a disconnect. */
export const DeskBluetoothDeviceAnswer = z.object({ v: V, device: BluetoothDevice });
export type DeskBluetoothDeviceAnswer = z.infer<typeof DeskBluetoothDeviceAnswer>;
