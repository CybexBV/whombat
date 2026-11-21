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
  if (b.account) out.account = { user: b.account.user, password: b.account.password };
  return out;
}

/** One screen step on a Mac, as `actor` with the role the step needs; the Mac's refusals come back `ok: false`. */
export async function screenStep(
  hosts: HostsService,
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
  }
}

/**
 * Steps by position (a click, a drag, a scroll) have no words a person can follow in Done recently: they stay in the
 * Mac's own Activity. Named steps, keys, typing and unlocking show in Done recently too.
 */
export function screenStepIsEveryday(op: HostScreenOp): boolean {
  return op === 'click' || op === 'drag' || op === 'scroll';
}
