/**
 * The welcome built from what the box found (docs/decisions/first-day.md): pure. The network scan runs by itself right
 * after the claim, so the assistant's first message names what it found in plain words (“I found Home Assistant, a
 * UniFi gateway and a Debian server on your network. Want me to look after them?”) with one button per find: the
 * connect form filled in, or Add a server — the same places the assistant's own connect card opens. Mail comes
 * second, other email (IMAP) before Google, which still needs the person's own Google app. When nothing was found
 * yet, a short welcome says what the assistant can do, and the finds come later as one message (`foundLaterSteps`).
 * The welcome is one thread: its first step is the thread, mail and the later finds reply in it, so a new person's
 * Chat starts with one thread from the assistant rather than three.
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
import { formatLocaleList } from '@whombat/core/i18n';
import { FOUND_PAGE_PATH, foundName } from '../connections/found-view';
import { DEVICE_CATALOG_ID } from '../devices/store';
import { addServerHref } from '../hosts/tools';
import { hasServerMessage, isEnglish, type ServerMessageKey, tpServer, tServer } from '../i18n/catalog';
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
function andList(items: readonly string[], locale?: string | null): string {
  if (!isEnglish(locale)) return formatLocaleList(items, locale);
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * A find as people say it in `locale`: one (with its article), several, and the one (“the UniFi gateway”, “de
 * UniFi-gateway”). Each language says its own articles; Dutch never gets an English one swapped in.
 */
export function spokenFindIn(
  f: Pick<WelcomeFind, 'catalogId' | 'version'>,
  locale?: string | null,
): readonly [string, string, string] {
  const [one, many] = spokenFind(f);
  if (isEnglish(locale)) return [one, many, the(one)];
  const own = `guides.spoken.${f.catalogId}`;
  if (hasServerMessage(`${own}.one`)) {
    const say = (form: string) => tServer(locale, `${own}.${form}` as ServerMessageKey);
    return [say('one'), say('many'), say('the')];
  }
  const name = foundName(f);
  if (f.catalogId === FOUND_SERVER_ID || f.catalogId === DEVICE_CATALOG_ID) {
    const kind = f.catalogId === FOUND_SERVER_ID ? 'server' : 'device';
    // “Debian server” is one word in Dutch: “Debian-server”.
    const word =
      name === 'Server' ? tServer(locale, 'guides.spoken.serverWord') : name.replace(/ server$/i, '-server');
    const say = (form: 'one' | 'many' | 'the') =>
      tServer(locale, `guides.spoken.${kind}.${form}` as ServerMessageKey, { name: word });
    return [say('one'), say('many'), say('the')];
  }
  // A product's own name (“Home Assistant”) takes no article.
  return [name, name, name];
}

/**
 * What the sentence names: every kind when there are at most three (“two Proxmox servers” for one found twice), else
 * “7 things, like A, B and C” (the first three kinds, in the scan's order).
 */
export function foundPhrase(finds: readonly WelcomeFind[], locale?: string | null): string {
  const kinds = new Map<string, { said: readonly [string, string, string]; n: number }>();
  for (const f of finds) {
    const said = spokenFindIn(f, locale);
    const kind = kinds.get(said[0]) ?? { said, n: 0 };
    kind.n++;
    kinds.set(said[0], kind);
  }
  const small = (n: number) => {
    if (isEnglish(locale)) return SMALL[n] ?? String(n);
    const key = `guides.small.${n}`;
    return hasServerMessage(key) ? tServer(locale, key) : String(n);
  };
  const said = [...kinds.values()].map(({ said: [one, many], n }) => (n > 1 ? `${small(n)} ${many}` : one));
  if (kinds.size <= NAMED_MAX) return andList(said, locale);
  if (!isEnglish(locale))
    return tServer(locale, 'guides.things', {
      n: finds.length,
      list: andList(said.slice(0, NAMED_MAX), locale),
    });
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
export function findAction(
  f: WelcomeFind,
  index: number,
  twice: boolean,
  locale?: string | null,
): GuideAction {
  const entry = catalogEntry(f.catalogId);
  const server = asServer(f, entry);
  const thing = spokenFindIn(f, locale)[2];
  const words = isEnglish(locale)
    ? `${server ? 'Add' : 'Connect'} ${thing}`
    : tServer(locale, server ? 'guides.find.add' : 'guides.find.connect', { thing });
  const label = (
    twice
      ? isEnglish(locale)
        ? `${words} at ${f.host}`
        : tServer(locale, 'guides.find.at', { words, host: f.host })
      : words
  ).slice(0, 40);
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
export function findActions(finds: readonly WelcomeFind[], locale?: string | null): GuideAction[] {
  const shown = finds.length > BUTTONS_MAX ? finds.slice(0, BUTTONS_MAX - 1) : finds;
  const words = shown.map((f) => spokenFind(f)[0]);
  const actions = shown.map((f, i) =>
    findAction(f, i, words.filter((w) => w === words[i]).length > 1, locale),
  );
  if (finds.length > shown.length)
    actions.push({
      id: 'see_all',
      label: isEnglish(locale)
        ? copy.seeAllLabel(finds.length)
        : tServer(locale, 'guides.seeAll', { n: finds.length }),
      style: 'quiet',
      href: FOUND_PAGE_PATH,
    });
  return actions;
}

/** The card under a message that names finds: one link per find. Never waits: it is `done` at once. */
function foundStep(text: string, finds: readonly WelcomeFind[]): Step {
  return (f, id) => {
    const locale = f.locale;
    const english = isEnglish(locale);
    return {
      id,
      text,
      card: makeCard({
        guide: 'welcome',
        node: 'found',
        title: english ? copy.FOUND_TITLE : tServer(locale, 'guides.foundTitle'),
        body: english
          ? copy.foundBody(finds.length === 1)
          : tServer(locale, finds.length === 1 ? 'guides.foundBodyOne' : 'guides.foundBodyMany'),
        blocks: [{ type: 'actions', actions: findActions(finds, locale) }],
      }),
    };
  };
}

/**
 * Mail, second: other email first (its connect form), Gmail through the Google setup, or later. Answers find their
 * action by its id, so cards posted with older labels still work.
 */
export const mailStep: Step = (f, id) => {
  const locale = f.locale;
  const say = (english: string, key: ServerMessageKey) =>
    isEnglish(locale) ? english : tServer(locale, key);
  return {
    id,
    text: '',
    card: makeCard({
      guide: 'welcome',
      node: 'mail',
      title: say(copy.MAIL_TITLE, 'guides.mailTitle'),
      body: say(copy.MAIL_BODY, 'guides.mailBody'),
      blocks: [
        {
          type: 'actions',
          actions: [
            {
              id: 'imap',
              label: say(copy.MAIL_OTHER, 'guides.mailOther'),
              style: 'primary',
              href: IMAP_HREF,
            },
            { id: 'google', label: say(copy.MAIL_GOOGLE, 'guides.mailGoogle'), style: 'secondary' },
            { id: 'later', label: say(copy.MAYBE_LATER, 'guides.maybeLater'), style: 'quiet' },
          ],
        },
      ],
    }),
  };
};

/** The welcome: the finds (or what it can do), then mail, which `postSteps` puts in the first one's thread. */
export function welcomeSteps(found: FoundNow): Step[] {
  const { finds } = found;
  if (finds.length > 0)
    return [
      (f, id) =>
        foundStep(
          isEnglish(f.locale)
            ? copy.welcomeFoundText(f.personName, f.agentName, foundPhrase(finds), finds.length === 1)
            : tpServer(f.locale, 'guides.welcomeFound', finds.length, {
                person: f.personName,
                agent: f.agentName,
                found: foundPhrase(finds, f.locale),
              }),
          finds,
        )(f, id),
      mailStep,
    ];
  const hello: Step = (f, id) => ({
    id,
    text: isEnglish(f.locale)
      ? found.looking
        ? copy.welcomeLookingText(f.personName, f.agentName)
        : copy.welcomeQuietText(f.personName, f.agentName)
      : tServer(f.locale, found.looking ? 'guides.welcomeLooking' : 'guides.welcomeQuiet', {
          person: f.personName,
          agent: f.agentName,
          canDo: tServer(f.locale, 'guides.canDo'),
        }),
    card: null,
  });
  return [hello, mailStep];
}

/** The scan's finds after the welcome went out without them: one message with the same buttons, in its thread. */
export function foundLaterSteps(finds: readonly WelcomeFind[]): Step[] {
  if (finds.length === 0) return [];
  return [
    (f, id) =>
      foundStep(
        isEnglish(f.locale)
          ? copy.foundLaterText(foundPhrase(finds), finds.length === 1)
          : tpServer(f.locale, 'guides.foundLater', finds.length, { found: foundPhrase(finds, f.locale) }),
        finds,
      )(f, id),
  ];
}
