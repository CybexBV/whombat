/**
 * A Mac's screen through the hosts service (docs/decisions/macos-servers.md): one screen step is one
 * `POST /servers/{id}/screen` on the hub, which hands it to the Mac's agent (Screen Sharing for pictures, clicks and
 * keys, Whombat Helper for buttons and fields by name). The hub checks the role (operator for `status`, admin for the
 * rest: a look and the UI lists show the person's whole desktop) and the host-shell switch on both sides, and audits
 * every step but `status`.
 *
 * Shared by the person's route (`hosts.screen`, `hosts.screenLook`) and the assistant's tools (`mac_screen`, `mac_ui`).
 * The Mac's password (`account.set`) passes through on its way to the Mac and is never kept, logged or signed here.
 */
import {
  HOST_SCREEN_READ_OPS,
  type HostScreenBody,
  type HostScreenOp,
  type HostScreenResult,
  hostScreenTimeoutMs,
} from '@whombat/core';
import { HOSTS_API, type HostsActor, type HostsRole, seg } from './client';
import { toHostScreenResult } from './map';
import type { HostsService } from './service';

/** The role a screen step needs on the hub: operator for `status`, admin for the rest (a look too). */
export function screenRole(op: HostScreenOp): HostsRole {
  return HOST_SCREEN_READ_OPS.includes(op) ? 'operator' : 'admin';
}

export const isScreenRead = (op: HostScreenOp) => HOST_SCREEN_READ_OPS.includes(op);

/** A screen step's body in the hub's words (snake_case), only what is given. */
export function screenBody(b: HostScreenBody): Record<string, unknown> {
  const out: Record<string, unknown> = { op: b.op };
  const put = (key: string, v: unknown) => {
    if (v !== undefined) out[key] = v;
  };
  put('x', b.x);
  put('y', b.y);
  put('to_x', b.toX);
  put('to_y', b.toY);
  put('button', b.button);
  put('clicks', b.clicks);
  put('dx', b.dx);
  put('dy', b.dy);
  put('text', b.text);
  put('keys', b.keys);
  put('max_w', b.maxW);
  put('format', b.format);
  put('app', b.app);
  put('window', b.window);
  put('name', b.name);
  put('role', b.role);
  put('index', b.index);
  put('path', b.path);
  put('limit', b.limit);
  put('target', b.target);
  put('action', b.action);
  put('queries', b.queries);
  if (b.pins) out.pins = b.pins.map((p) => ({ lat: p.lat, lon: p.lon }));
  put('lat', b.lat);
  put('lon', b.lon);
  put('span_m', b.spanM);
  put('w', b.w);
  put('h', b.h);
  put('scale', b.scale);
  put('dark', b.dark);
  if (b.crop) out.crop = { x: b.crop.x, y: b.crop.y, w: b.crop.w, h: b.crop.h };
  if (b.account) out.account = { user: b.account.user, password: b.account.password };
  return out;
}

/** One screen step on a Mac, as `actor` with the role the step needs; the Mac's refusals come back `ok: false`. */
export async function screenStep(
  hosts: Pick<HostsService, 'call'>,
  serverId: string,
  body: HostScreenBody,
  actor: HostsActor,
): Promise<HostScreenResult> {
  const raw = await hosts.call<unknown>({
    method: 'POST',
    path: `${HOSTS_API}/servers/${seg(serverId)}/screen`,
    body: screenBody(body),
    actor: { ...actor, role: screenRole(body.op) },
    timeoutMs: hostScreenTimeoutMs(body.op),
  });
  return toHostScreenResult(raw, serverId, body.op);
}

/**
 * Words of an element's own action that undo something a person can't easily get back: removing a friend, erasing a
 * device, signing out, stopping sharing, marking something lost. Compared without case or accents, in English, Dutch,
 * German, French and Spanish; each word stands at the start of a word, so “Wissel” isn't “wis”.
 */
const DESTRUCTIVE_ACTION_WORDS: readonly RegExp[] = [
  // English
  /\b(remov|delet|eras|forget|block|unpair|unfriend)/,
  /\b(sign|log)(ing|ging)? ?out\b/,
  /\bstop sharing\b/,
  /\b(mark|marked|marking) as lost\b/,
  /\blost mode\b/,
  // Dutch
  /\b(verwijder|vergeet|vergeten|blokkeer|blokkeren|ontkoppel|afmeld|uitlog|log uit|meld af)/,
  /\b(wis|wissen)\b/,
  /\b(stop met|stoppen met) del(en|ing)\b/,
  /\bniet meer delen\b/,
  /\b(markeer|markeren) als (verloren|kwijt)\b/,
  /\bverloren[- ]?modus\b/,
  // German
  /\b(entfern|losch|vergiss|vergessen|blockier|abmeld|entkoppel)/,
  /\b(teilen beenden|nicht mehr teilen|freigabe beenden)\b/,
  /\bals verloren markier/,
  // French
  /\b(supprim|retir|effac|oubli|bloqu|dissoci|deconnect)/,
  /\b(arreter|arreter de|ne plus) (le )?partag/,
  /\b(marquer|signaler) comme perdu/,
  /\bmode perdu\b/,
  // Spanish
  /\b(elimin|borr|olvid|desvincul|desemparej)/,
  /\bquitar\b/,
  /\bcerrar sesion\b/,
  /\bdejar de compartir\b/,
  /\bmarcar como perdid/,
  /\bmodo perdido\b/,
];

/** A name as the destructive words compare it: lower case, no accents, one space between words. */
const plainWords = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

/** Whether an element's own action (“Remove Friend”, “Erase This Device”) undoes something: Whombat never runs those. */
export function isDestructiveAction(action: string): boolean {
  const words = plainWords(action);
  return DESTRUCTIVE_ACTION_WORDS.some((re) => re.test(words));
}

/**
 * The refusal of an element's own action that undoes something, in one sentence, or null when Whombat may run it.
 * The person does those on the Mac's screen themselves, where they see what goes.
 */
export function destructiveActionText(action: string, server: string): string | null {
  if (!isDestructiveAction(action)) return null;
  return `Whombat doesn’t choose ${quoted(action)} on ${server}: do that on the Mac’s screen yourself.`;
}

/** A quoted name, cut to a readable length. */
const quoted = (s: string) => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;

/**
 * The signed line of a screen step that changes something (“Pressed “Allow” on Studio”), or null for one that only
 * reads. Never the typed text, which may be a password: only that something was typed.
 */
export function screenChangeText(b: HostScreenBody, server: string): string | null {
  switch (b.op) {
    case 'status':
    case 'look':
    case 'ui.apps':
    case 'ui.list':
    case 'account.check':
    // The Mac's maps only read, and their places are never written down anywhere.
    case 'map.geocode':
    case 'map.snapshot':
      return null;
    case 'click': {
      const how =
        b.button === 'right' ? 'Right-clicked' : (b.clicks ?? 1) >= 2 ? 'Double-clicked' : 'Clicked';
      return `${how} on ${server}’s screen`;
    }
    case 'drag':
      return `Dragged on ${server}’s screen`;
    case 'scroll':
      return `Scrolled on ${server}’s screen`;
    case 'type':
      return `Typed on ${server}’s screen`;
    case 'keys':
      return `Pressed ${(b.keys ?? '').slice(0, 40)} on ${server}`;
    case 'unlock':
      return `Unlocked ${server}’s screen`;
    case 'password':
      return `Entered the Mac’s password on ${server}`;
    case 'account.set':
      return `Set the screen password for ${server}`;
    case 'account.clear':
      return `Forgot the screen password for ${server}`;
    case 'ui.press':
      return `Pressed ${quoted(b.name ?? '')} on ${server}`;
    case 'ui.set':
      return b.name ? `Filled in ${quoted(b.name)} on ${server}` : `Typed on ${server}’s screen`;
    case 'ui.menu':
      return `Chose ${(b.path ?? []).map((p) => p.slice(0, 40)).join(' → ')} on ${server}`;
    case 'ui.focus':
      return `Brought ${quoted(b.app ?? '')} forward on ${server}`;
    case 'ui.open':
      return b.target === 'accessibility'
        ? `Opened the Accessibility settings on ${server}`
        : `Opened ${quoted(b.target ?? '')} on ${server}`;
    case 'ui.action':
      return `Chose ${quoted(b.action ?? '')} for ${quoted(b.name ?? '')} on ${server}`;
    case 'ui.quit':
      return `Quit ${quoted(b.app ?? '')} on ${server}`;
  }
}

/**
 * Steps by position (a click, a drag, a scroll) have no words a person can follow in Done recently: they stay in the
 * Mac's own Activity. Named steps, keys, typing and unlocking show in Done recently too.
 */
export function screenStepIsEveryday(op: HostScreenOp): boolean {
  return op === 'click' || op === 'drag' || op === 'scroll';
}
