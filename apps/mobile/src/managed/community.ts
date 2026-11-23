/**
 * A community Whombat on the phone (Whombat hermes-engine.md HE-58…HE-61; hermes-engine-app.md AP-5470…AP-5476): a box
 * with no control, relay, remote help, licence or phone push, which the phone joins with a link or QR code the box made
 * on another of your devices, and reaches only on its direct ways — its local network and its Tailscale name. Pure TypeScript (tested): the record the phone keeps for it, the addresses a link gives, and the
 * phone's own words for joining.
 */
import type { KnownAppliance, LocalLinkParts } from '@whombat/client/managed';
import {
  COMMUNITY_TEXT,
  isOwnAddressHost,
  LINK_TEXT,
  readLocalLink,
  COPY as SHARED_COPY,
} from '@whombat/client/managed';
import { DIRECT_PATH, DIRECT_PORT } from '@whombat/protocol/direct';
import type { DirectAddresses, DirectRoute } from '@whombat/protocol/session';

/**
 * The organization a community box is kept under on this phone (no control, so no organization): its storage scope is
 * `managed:community/<PeerId>` and its record lives in a registry of its own (`COMMUNITY_REGISTRY`).
 */
export const COMMUNITY_ORG = 'community';
/** The registry key of the community boxes this phone knows (beside each cloud account's). */
export const COMMUNITY_REGISTRY = 'community';

/** `ws://192.168.1.20:4480/v1/direct` → its host and port (no `URL`: React Native's has no getters). */
function hostPort(socket: string): { host: string; port: number } | null {
  const m = /^wss?:\/\/(\[[^\]]+\]|[^/:]+):(\d+)\//i.exec(socket);
  if (!m?.[1] || !m[2]) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) };
}

/**
 * The box's direct ways as a link names them, in the shape `welcome.direct` has (`DirectAddresses`): the first session
 * tries them in the link's order, and the box's own `welcome.direct` replaces them as soon as it opens.
 */
export function linkAddresses(routes: readonly DirectRoute[]): DirectAddresses {
  const first = routes[0] ? hostPort(routes[0].socket) : null;
  const lan: string[] = [];
  let tailscale: string | null = null;
  for (const r of routes) {
    const hp = hostPort(r.socket);
    if (!hp) continue;
    if (r.way === 'lan') lan.push(hp.host);
    else tailscale ??= hp.host;
  }
  return { port: first?.port ?? 4480, lan, tailscale, routes: [...routes] };
}

/**
 * What the phone keeps for a community box it joined with `link` (AP-5471): the PeerId the link named (pinned, from
 * someone already let in), that PeerId as its device id (there is no directory), and the link's ways to it.
 */
export function communityRecord(
  link: Pick<LocalLinkParts, 'appliance' | 'routes' | 'own'>,
  enrolled: boolean,
  accountId?: string,
): KnownAppliance {
  return {
    device: link.appliance,
    orgId: COMMUNITY_ORG,
    name: null,
    peerId: link.appliance,
    // Who vouched for the pin (AP-63): a device link from another of your devices.
    pinSource: 'add-link',
    enrolled,
    kitPending: false,
    ...(accountId && { accountId }),
    direct: linkAddresses(link.routes),
    // The box's own address (4.3): dialed first from then on (`ConnectTarget.own`).
    ...(link.own && { ownAddress: link.own }),
  };
}

/** A box's address as typed: its host and the port its pages answer on. */
export interface BoxAddress {
  host: string;
  port: number;
}

/**
 * A box's address as typed (LNK-08): its own address (`name.whombat.app`) or its Tailscale name, with or without
 * `https://`, a port and a trailing slash; or its address on this network as its screen shows it (`192.168.1.20`).
 * Its pages are HTTPS only, so `http://` isn't one. The box serves its Tailscale name and its
 * local network on its direct port (4480, the address its page shows), so an address typed without a port gets that one;
 * its own address answers at the door, on 443. The host (lower case) and port, or null.
 */
export function readBoxAddress(typed: string): BoxAddress | null {
  const text = typed
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');
  const m = /^([^/:]+)(?::(\d{1,5}))?$/.exec(text);
  const host = m?.[1];
  if (!host || host.length > 253) return null;
  // Four numbers are an IPv4 address or nothing: never a name.
  if (/^[\d.]+$/.test(host) && !onLocalNetwork({ host, port: 0 })) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  const port = m[2] ? Number(m[2]) : isOwnAddressHost(host) ? 443 : DIRECT_PORT;
  return port >= 1 && port <= 65535 ? { host, port } : null;
}

/**
 * Whether the address is the box's on this network: an IPv4 address, which the box's screen names when it has
 * no secure address. The phone reaches it there in plain HTTP; what crosses it is the box's Noise session.
 */
export function onLocalNetwork({ host }: BoxAddress): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** `https://host[:port]`, without the port when it is 443; `http://host:port` on this network. */
export function boxAddressOrigin(address: BoxAddress): string {
  const { host, port } = address;
  if (onLocalNetwork(address)) return `http://${host}:${port}`;
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/**
 * What the phone keeps for a box it reached at a typed address (LNK-08): the PeerId the box named at that HTTPS address
 * (`GET /v1/direct`), pinned on first use as the box's own page pins it, that PeerId as its device id, and the address
 * as its way in, port included: its own address (dialed first, through the door) or its Tailscale name.
 */
export function addressRecord(address: BoxAddress, peerId: string): KnownAppliance {
  const { host, port } = address;
  const own = isOwnAddressHost(host);
  const lan = onLocalNetwork(address);
  const origin = boxAddressOrigin(address);
  return {
    device: peerId,
    orgId: COMMUNITY_ORG,
    name: null,
    peerId,
    // The box named itself at an address the person typed: as the box's own page pins it. On this network that was
    // plain HTTP, so only a claim with the letters on its screen (which proves the box at the other end, `claim`) or a
    // sign-in another device or its screen approves lets this phone in there.
    pinSource: 'box',
    enrolled: false,
    kitPending: false,
    direct: {
      port,
      lan: lan ? [host] : [],
      tailscale: own || lan ? null : host,
      routes: [
        {
          way: lan ? 'lan' : 'tailscale',
          socket: `${origin.replace(/^http/, 'ws')}${DIRECT_PATH}`,
          web: `${origin}/`,
        },
      ],
    },
    ...(own && { ownAddress: `${origin}/` }),
  };
}

/** What a scanned or pasted text is: a link the box made, or why not (in words). */
export function scannedLocalLink(text: string): { link: LocalLinkParts } | { problem: string } {
  const link = readLocalLink(text);
  return link ? { link } : { problem: PHONE_COMMUNITY_TEXT.join.bad };
}

/** The notifications row on a community box (AP-5475): no push to phones; the app looks when it opens. */
export function communityNotificationsView() {
  return {
    dot: 'mut' as const,
    title: COMMUNITY_TEXT.push.phoneTitle,
    meta: COMMUNITY_TEXT.push.phoneMeta,
    action: null,
  };
}

/** The phone's own words for joining a community box (the shared `LINK_TEXT` and `COMMUNITY_TEXT` besides). */
export const PHONE_COMMUNITY_TEXT = {
  /** A new install's first screen (LNK-44): no cloud sign-in is needed to use a Whombat. */
  start: {
    // No kicker: the Whombat logo right above says it already.
    title: 'Join a Whombat',
    sub: 'Scan the QR code on your Whombat’s page, or type its address.',
    tip: 'On your Whombat’s page, the QR code is under Settings → This Whombat → Devices.',
    scan: 'Scan the QR code',
    address: 'Its address',
    addressHint: 'Like name.whombat.app, its Tailscale name, or the address on its screen.',
    placeholder: 'name.whombat.app',
    go: 'Continue',
    bad: 'That isn’t an address. Type it like name.whombat.app or 192.168.1.20.',
    signIn: 'Sign in with a Whombat account',
    /** Opens the demo world (look-around.md): for anyone without a Whombat, App Review among them. */
    lookAround: SHARED_COPY.lookAround.open,
  },
  /** A cloud account with no Whombat yet: join one; nothing is set up or bought in the app. */
  noWhombat: {
    kicker: 'WHOMBAT',
    title: 'No Whombat here yet',
    sub: 'Join your Whombat with the QR code on its page, or its address.',
    join: 'Join a Whombat',
    again: 'Check again',
    signOut: 'Sign out',
  },
  /** Joining at a typed address. */
  address: {
    kicker: 'JOIN A WHOMBAT',
    reaching: 'Reaching your Whombat…',
    unreachable: 'This phone can’t reach that address. Check it, and that your Whombat is on.',
    notSetUp: 'Nobody has set this Whombat up yet. Open its address in a browser to set it up first.',
  },
  /**
   * Claiming a box at its address on this network: the letters on its screen, then who you are
   * (`COMMUNITY_TEXT`'s words for both); then the app opens it.
   */
  claim: {
    kicker: 'SET UP YOUR WHOMBAT',
  },
  signIn: {
    joinLink: 'Add this phone with a link or QR code',
    known: 'ON THIS PHONE',
    open: (name: string) => `Open ${name}`,
    unnamed: 'Your Whombat',
    openMeta: 'On your own network or tailnet',
  },
  join: {
    kicker: 'ADD THIS PHONE',
    title: 'Add this phone with a link',
    sub: 'Scan the QR code your other device shows, or paste the link from it.',
    tip: 'Make one on a device you already use this Whombat on: Settings → This Whombat → Devices.',
    scan: 'Scan a QR code',
    scanTitle: 'Scan the Whombat’s QR code',
    scanClose: 'Close',
    scanWrong: 'That isn’t a Whombat link.',
    paste: 'Link',
    pasteHint: 'Paste the whole link, starting with http.',
    go: 'Continue',
    pasteInstead: 'Paste the link instead',
    bad: 'That isn’t a Whombat link. Make a new one on your other device.',
    denied: 'Whombat can’t use the camera. Paste the link instead.',
    back: 'Back',
  },
  device: {
    kicker: 'ADD THIS PHONE',
    title: 'Add this phone',
    sub: LINK_TEXT.device.sub,
    tip: 'You’ll see this phone under Devices on your other device, where you can remove it.',
  },
  reaching: 'Reaching your Whombat…',
  /** The title when a box didn't answer: what happened, not the step's name again. */
  unreachableTitle: 'Can’t reach this Whombat',
  unreachable:
    'This phone can’t reach that Whombat. Be on the same network as it, or on its tailnet, and try again.',
  tryAgain: 'Try again',
  leave: 'Sign out',
} as const;
