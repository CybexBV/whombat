/**
 * The welcome built from what the box found (docs/decisions/first-day.md): pure. The network scan runs by itself right
 * after the claim, so the assistant's first message names what it found in plain words (“I found Home Assistant, a
 * UniFi gateway and a Debian server on your network. Want me to look after them?”) with one button per find: the
 * connect form filled in, or Add a server — the same places the assistant's own connect card opens. Mail comes
 * second, other email (IMAP) before Google, which still needs the person's own Google app. When nothing was found
 * yet, a short welcome says what the assistant can do, and the finds come later as one message (`foundLaterSteps`).
 *
 * The finds' buttons are links: a guide card locks at its first answer, and every find must stay one tap away.
 */
import {
  type CatalogEntry,
  catalogEntry,
  connectAskHref,
  FOUND_SERVER_ID,
  type GuideAction,
  suggestedAccess,
} from '@whombat/core';
import { FOUND_PAGE_PATH, foundName } from '../connections/found-view';
import { DEVICE_CATALOG_ID } from '../devices/store';
import { addServerHref } from '../hosts/tools';
import * as copy from './copy';
import { makeCard, type Step } from './flows';

/** One thing the scan found that the person hasn't connected or hidden, in the scan's order (DF-03). */
export interface WelcomeFind {
  catalogId: string;
  host: string;
  port: number;
  url: string;
  version: string | null;
}

/** What the welcome knows of the network: the new finds, and whether a scan is still to tell more. */
export interface FoundNow {
  finds: readonly WelcomeFind[];
  /** The burrow's first automatic scan hasn't finished: the finds come later as one message. */
  looking: boolean;
}

/** The connect form (and the assistant's connect card) of IMAP mail: `/settings?tab=connections&connection=imap`. */
export const IMAP_HREF = '/settings?tab=connections&connection=imap';

/** Most finds with a button of their own; with more, one fewer and “See all”. */
const BUTTONS_MAX = 4;
/** Most kinds named in the sentence; with more, “7 things … like A, B and C”. */
const NAMED_MAX = 3;

const SMALL = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * How people say what an entry is when the product's name isn't it (“a UniFi gateway”, not “UniFi Network”): one, and
 * several.
 */
const SPOKEN: Readonly<Record<string, readonly [string, string]>> = {
  unifi_network: ['a UniFi gateway', 'UniFi gateways'],
  synology: ['a Synology NAS', 'Synology NAS boxes'],
  qnap: ['a QNAP NAS', 'QNAP NAS boxes'],
  truenas: ['a TrueNAS server', 'TrueNAS servers'],
  unraid: ['an Unraid server', 'Unraid servers'],
  proxmox: ['a Proxmox server', 'Proxmox servers'],
  proxmox_backup: ['a Proxmox Backup Server', 'Proxmox Backup Servers'],
  opnsense: ['an OPNsense firewall', 'OPNsense firewalls'],
};

/** A found thing as people say it, one and several: “a Debian server”, “Home Assistant”. */
export function spokenFind(f: Pick<WelcomeFind, 'catalogId' | 'version'>): readonly [string, string] {
  const known = SPOKEN[f.catalogId];
  if (known) return known;
  const name = foundName(f);
  if (f.catalogId === FOUND_SERVER_ID) {
    const lower = name === 'Server' ? 'server' : name;
    return [`a ${lower}`, `${lower}s`];
  }
  if (f.catalogId === DEVICE_CATALOG_ID) return [`a ${name}`, `${name}s`];
  return [name, name];
}

/** “A, B and C”. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * What the sentence names: every kind when there are at most three (“two Proxmox servers” for one found twice), else
 * “7 things, like A, B and C” (the first three kinds, in the scan's order).
 */
export function foundPhrase(finds: readonly WelcomeFind[]): string {
  const kinds = new Map<string, { said: readonly [string, string]; n: number }>();
  for (const f of finds) {
    const said = spokenFind(f);
    const kind = kinds.get(said[0]) ?? { said, n: 0 };
    kind.n++;
    kinds.set(said[0], kind);
  }
  const said = [...kinds.values()].map(({ said: [one, many], n }) =>
    n > 1 ? `${SMALL[n] ?? n} ${many}` : one,
  );
  if (kinds.size <= NAMED_MAX) return andList(said);
  return `${finds.length} things, like ${andList(said.slice(0, NAMED_MAX))}`;
}

/** “a UniFi gateway” → “the UniFi gateway”; a name stays a name. */
function the(one: string): string {
  return one.replace(/^an? /, 'the ');
}

/** Whether Whombat looks after a find best as a server (a computer, Proxmox VE, its Backup Server, Unraid). */
function asServer(f: Pick<WelcomeFind, 'catalogId'>, entry: CatalogEntry | null): boolean {
  return f.catalogId === FOUND_SERVER_ID || entry?.asServer === true;
}

/**
 * A find's button: “Connect the UniFi gateway” to the connect form filled in (the scan's address, Look only or Manage
 * by risk), or “Add the Debian server” to Add a server with its address. `twice`: another button has the same words,
 * so the address tells them apart.
 */
export function findAction(f: WelcomeFind, index: number, twice: boolean): GuideAction {
  const entry = catalogEntry(f.catalogId);
  const server = asServer(f, entry);
  const words = `${server ? 'Add' : 'Connect'} ${the(spokenFind(f)[0])}`;
  const label = (twice ? `${words} at ${f.host}` : words).slice(0, 40);
  const href = server
    ? addServerHref({ address: f.host, username: null, control: null, name: null })
    : connectAskHref({
        catalogId: f.catalogId,
        url: f.url,
        access: entry ? suggestedAccess(entry) : 'read',
      });
  return { id: `find_${index + 1}`, label, style: index === 0 ? 'primary' : 'secondary', href };
}

/** The finds' buttons: each one up to four, else three and “See all {n}”. */
export function findActions(finds: readonly WelcomeFind[]): GuideAction[] {
  const shown = finds.length > BUTTONS_MAX ? finds.slice(0, BUTTONS_MAX - 1) : finds;
  const words = shown.map((f) => spokenFind(f)[0]);
  const actions = shown.map((f, i) => findAction(f, i, words.filter((w) => w === words[i]).length > 1));
  if (finds.length > shown.length)
    actions.push({
      id: 'see_all',
      label: copy.seeAllLabel(finds.length),
      style: 'quiet',
      href: FOUND_PAGE_PATH,
    });
  return actions;
}

/** The card under a message that names finds: one link per find. Never waits: it is `done` at once. */
function foundStep(text: string, finds: readonly WelcomeFind[]): Step {
  return (_f, id) => ({
    id,
    text,
    card: makeCard({
      guide: 'welcome',
      node: 'found',
      title: copy.FOUND_TITLE,
      body: copy.foundBody(finds.length === 1),
      blocks: [{ type: 'actions', actions: findActions(finds) }],
    }),
  });
}

/** Mail, second: other email (IMAP) first, Gmail through the Google setup, or later. */
export const mailStep: Step = (_f, id) => ({
  id,
  text: '',
  card: makeCard({
    guide: 'welcome',
    node: 'mail',
    title: copy.MAIL_TITLE,
    body: copy.MAIL_BODY,
    blocks: [
      {
        type: 'actions',
        actions: [
          { id: 'imap', label: copy.MAIL_OTHER, style: 'primary', href: IMAP_HREF },
          { id: 'google', label: copy.MAIL_GOOGLE, style: 'secondary' },
          { id: 'later', label: copy.MAYBE_LATER, style: 'quiet' },
        ],
      },
    ],
  }),
});

/** The welcome: the finds (or what it can do), then mail. */
export function welcomeSteps(found: FoundNow): Step[] {
  const { finds } = found;
  if (finds.length > 0)
    return [
      (f, id) =>
        foundStep(
          copy.welcomeFoundText(f.personName, f.agentName, foundPhrase(finds), finds.length === 1),
          finds,
        )(f, id),
      mailStep,
    ];
  const hello: Step = (f, id) => ({
    id,
    text: found.looking
      ? copy.welcomeLookingText(f.personName, f.agentName)
      : copy.welcomeQuietText(f.personName, f.agentName),
    card: null,
  });
  return [hello, mailStep];
}

/** The scan's finds after the welcome went out without them: one message with the same buttons. */
export function foundLaterSteps(finds: readonly WelcomeFind[]): Step[] {
  if (finds.length === 0) return [];
  return [foundStep(copy.foundLaterText(foundPhrase(finds), finds.length === 1), finds)];
}
