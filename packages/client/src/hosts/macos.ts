/**
 * A Mac's page on the web and the phone (Whombat macos-servers.md MAC-01…MAC-20; the app's part MAC-30…): its tabs,
 * its own facts for Technical details (“This Mac”), the Screen part in words — Screen Sharing, the lock, who is at the
 * screen, the Mac's password Whombat signs in with, Whombat Helper and its Accessibility — what may be done there now and
 * why not, and the words after a screen step. Pure, shared by both apps.
 */
import {
  HOST_SCREEN_LIMITS,
  type HostMacosDetail,
  type HostScreenBody,
  type HostScreenResult,
  type HostServerDetail,
  hostScreenProblemText,
  screenMessageText,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { utf8ByteLength } from '@whombat/core/text/utf8';
import { clientTree } from '../i18n/catalog';
import { HOSTS_MAC_WORDS } from '../i18n/messages/connectionsHosts/mac';
import { formatAgoIso } from './format';
import type { HostTone } from './thresholds';

/** A Mac: the hub says so (`macos`), or its agent runs on macOS, or its page carries a Mac's facts. */
export function isMacServer(
  d:
    | { server: Pick<HostServerDetail['server'], 'platform' | 'osFamily'>; macos?: unknown }
    | null
    | undefined,
): boolean {
  if (!d) return false;
  return d.server.platform === 'macos' || d.server.osFamily === 'macos' || !!d.macos;
}

/** What the UI calls a Mac's kind. */
export const MAC_KIND_WORD = 'Mac';

export type MacServerTab = 'summary' | 'screen' | 'findmy' | 'storage' | 'sensors' | 'system';

/**
 * A Mac's tabs: the Screen after the Summary, then every server's; no machines or backups of its own. Find My is a
 * connection of its own (docs/implementation/macos/findmy-connection.md), which the Summary links to. The phone has the
 * first two (`MAC_PHONE_TABS`).
 */
export const MAC_SERVER_TABS: readonly MacServerTab[] = ['summary', 'screen', 'storage', 'sensors', 'system'];

/** The Mac's tabs on the phone: storage, sensors and the system stay on the web. */
export const MAC_PHONE_TABS = ['summary', 'screen'] as const satisfies readonly MacServerTab[];

/**
 * A Mac's tabs on a Whombat from before Find My was a connection (its catalog doesn't list `findmy`): Find My after the
 * Screen, as it was there, so nothing goes missing until the box is updated.
 */
export const MAC_SERVER_TABS_WITH_FIND_MY: readonly MacServerTab[] = [
  'summary',
  'screen',
  'findmy',
  'storage',
  'sensors',
  'system',
];

/** The same on the phone. */
export const MAC_PHONE_TABS_WITH_FIND_MY = [
  'summary',
  'screen',
  'findmy',
] as const satisfies readonly MacServerTab[];

/** A Mac's tabs on the web: with its own Find My only on an older Whombat (`findMyOnMac`). */
export function macServerTabs(findMyOnMac: boolean): readonly MacServerTab[] {
  return findMyOnMac ? MAC_SERVER_TABS_WITH_FIND_MY : MAC_SERVER_TABS;
}

/** A Mac's tabs' names, in a locale (English when none is given). */
export function macServerTabWords(locale?: string | null): Record<MacServerTab, string> {
  return { ...clientTree(locale, HOSTS_MAC_WORDS).tabs };
}

export const MAC_SERVER_TAB_WORDS: Record<MacServerTab, string> = macServerTabWords('en');

/** The Mac's tabs on the phone with their names: its own Find My too only on an older Whombat (`withFindMy`). */
export function macPhoneTabs(
  locale?: string | null,
  withFindMy = false,
): { id: MacServerTab; label: string }[] {
  const words = macServerTabWords(locale);
  return (withFindMy ? MAC_PHONE_TABS_WITH_FIND_MY : MAC_PHONE_TABS).map((id) => ({ id, label: words[id] }));
}

/** The tab an address asks for, if the Mac's page has it (`tabs`, its own Find My only on an older Whombat). */
export function parseMacServerTab(v: unknown, tabs: readonly MacServerTab[] = MAC_SERVER_TABS): MacServerTab {
  return typeof v === 'string' && (tabs as readonly string[]).includes(v) ? (v as MacServerTab) : 'summary';
}

/**
 * Whether the Mac's page keeps its own Find My tab: only on a Whombat whose catalog answered without the `findmy` entry
 * (from before Find My was a connection). While the catalog is read, or when it can't be, the Mac links to its Find My
 * connection instead (a newer Whombat's way).
 */
export function findMyOnMac(statuses: readonly { catalogId: string }[] | null | undefined): boolean {
  return !!statuses && statuses.length > 0 && !statuses.some((s) => s.catalogId === 'findmy');
}

/** The words of a Mac's page that aren't built from its state. */
export function macWords(locale?: string | null) {
  const w = clientTree(locale, HOSTS_MAC_WORDS).words;
  return {
    ...w,
    forgetTitle: (server: string) => interpolate(w.forgetTitle, { server }),
    forgetBody: (server: string) => interpolate(w.forgetBody, { server }),
    lookAlt: (server: string) => interpolate(w.lookAlt, { server }),
  };
}

export const MAC_WORDS = macWords('en');

/* This Mac ----------------------------------------------------------------------------------------- */

/** “macOS 27.2.1 (26B131)”. */
export function macSystemLine(m: Pick<HostMacosDetail, 'version' | 'build'>): string {
  const v = m.version.trim();
  return `macOS${v ? ` ${v}` : ''}${m.build ? ` (${m.build})` : ''}`;
}

/** “Mac Studio (Mac14,14)”, or whichever of the two it reported. */
export function macModelLine(m: Pick<HostMacosDetail, 'model' | 'modelName'>): string | null {
  if (m.modelName && m.model) return `${m.modelName} (${m.model})`;
  return m.modelName ?? m.model ?? null;
}

function onOff(v: boolean | null, locale?: string | null): string {
  const w = clientTree(locale, HOSTS_MAC_WORDS);
  return v === null ? w.notKnown : v ? w.on : w.off;
}

export interface MacFact {
  label: string;
  value: string;
}

/**
 * A Mac's own facts for Technical details (“This Mac”): the model, the chip, System Integrity Protection, FileVault and
 * whether it signs in by itself after a restart. Its macOS is the System line above them; who is at the screen is on
 * the Screen tab.
 */
export function macFacts(m: HostMacosDetail, locale?: string | null): MacFact[] {
  const w = clientTree(locale, HOSTS_MAC_WORDS).facts;
  const out: MacFact[] = [];
  const model = macModelLine(m);
  if (model) out.push({ label: w.model, value: model });
  if (m.chip) out.push({ label: w.chip, value: m.chip });
  out.push({ label: w.sip, value: onOff(m.sip, locale) });
  out.push({ label: w.fileVault, value: onOff(m.filevault, locale) });
  out.push({ label: w.autoLogin, value: m.autoLogin ? interpolate(w.yesAs, { user: m.autoLogin }) : w.no });
  return out;
}

/* The Screen part ---------------------------------------------------------------------------------- */

export interface MacLine {
  key: string;
  title: string;
  text: string;
  tone: HostTone;
}

/** Whether something may be done now, and why not. */
export type MacMay = { can: true; why: null } | { can: false; why: string };

const yes: MacMay = { can: true, why: null };
const no = (why: string): MacMay => ({ can: false, why });

export interface MacScreenView {
  /** Screen Sharing, the lock and who is at the screen. */
  lines: MacLine[];
  /** The screen is locked, or nobody can tell: Unlock is worth offering. */
  maybeLocked: boolean;
  sharing: boolean;
  /** How to switch Screen Sharing on; null while it is on. */
  sharingHow: string | null;
  /** The Mac's password Whombat signs in to the screen with. */
  account: MacLine;
  /** Whom the password form asks for first: the account set, else who is at the screen, else who signs in by itself. */
  accountUser: string;
  /** An account is set (Check and Forget have something to act on). */
  hasAccount: boolean;
  /** Whombat Helper, then its Accessibility while it runs. */
  helper: MacLine[];
  /** What the helper line adds: not installed, not running, Accessibility off; null when all is well. */
  helperNote: string | null;
  /** The helper runs without Accessibility: “Open the setting on the Mac”. */
  needsAccess: boolean;
  /** The screen itself: the web's live screen, the phone's picture (an owner's: it shows the whole desktop). */
  screen: MacMay;
  /** Unlock: an owner, with the screen reachable (offered while it isn't known to be unlocked). */
  unlock: MacMay;
  /** The password (Set, Check, Forget): an owner, with the screen's switch on and the Mac checking in. */
  password: MacMay;
  /** Steps through the helper (Open the setting on the Mac). */
  helperStep: MacMay;
  /** FileVault on: after a restart the Mac waits for its password. */
  fileVaultNote: string | null;
}

export interface MacScreenInput {
  /** The Mac's name as the page shows it. */
  name: string;
  /** May this person change servers (an owner, `hosts.status.canManage`). */
  owner: boolean;
  /** Now in ms (how long ago the password was checked). */
  now: number;
  /** The language the words are in (English when none is given). */
  locale?: string | null;
}

/**
 * The Screen part of a Mac's page from its detail: what it says and what may be done. The screen goes with the server's
 * host-shell switch on both sides, as the hosts service asks (the consoles' switch is the guests'), and needs the Mac
 * checking in; every step is an owner's, a look too.
 */
export function macScreenView(d: HostServerDetail, input: MacScreenInput): MacScreenView | null {
  const m = d.macos;
  if (!m) return null;
  const { name, owner, now, locale } = input;
  const words = macWords(locale);
  const w = clientTree(locale, HOSTS_MAC_WORDS).screen;
  const s = m.screen;
  const h = m.helper;
  const rc = d.server.remoteControl;
  const offline = d.server.status === 'offline' || d.server.status === 'pending';

  const lines: MacLine[] = [
    {
      key: 'sharing',
      title: w.sharing,
      text: onOff(s.sharing, locale),
      tone: s.sharing ? 'ok' : 'warn',
    },
  ];
  lines.push({
    key: 'lock',
    title: w.lock,
    text: s.locked === null ? w.cantTell : s.locked ? w.locked : w.unlocked,
    tone: s.locked === null ? 'mut' : s.locked ? 'warn' : 'ok',
  });
  lines.push({
    key: 'user',
    title: w.atScreen,
    text: m.consoleUser ?? w.nobody,
    tone: m.consoleUser ? 'ok' : 'mut',
  });

  const checked = s.signInAt ? interpolate(w.checked, { ago: formatAgoIso(s.signInAt, now, locale) }) : '';
  const account: MacLine = !s.account
    ? { key: 'account', title: words.passwordTitle, text: w.notSet, tone: 'warn' }
    : s.signIn === 'failed'
      ? {
          key: 'account',
          title: words.passwordTitle,
          text: interpolate(w.notTaken, { account: s.account }),
          tone: 'bad',
        }
      : s.signIn === 'ok'
        ? {
            key: 'account',
            title: words.passwordTitle,
            text: interpolate(w.signsInAs, { account: s.account, checked }),
            tone: 'ok',
          }
        : {
            key: 'account',
            title: words.passwordTitle,
            text: interpolate(w.notChecked, { account: s.account }),
            tone: 'mut',
          };

  const helper: MacLine[] = [];
  let helperNote: string | null = null;
  if (!h.installed) {
    helper.push({ key: 'helper', title: w.onTheMac, text: w.notInstalled, tone: 'mut' });
    helperNote = words.noHelper;
  } else if (!h.running) {
    helper.push({ key: 'helper', title: w.onTheMac, text: w.notRunning, tone: 'warn' });
    helperNote = words.helperStarts;
  } else {
    const running = h.user ? interpolate(w.runningFor, { user: h.user }) : w.running;
    const version = h.version ? interpolate(w.version, { version: h.version }) : '';
    helper.push({ key: 'helper', title: w.onTheMac, text: `${running}${version}`, tone: 'ok' });
    helper.push({
      key: 'access',
      title: w.accessibility,
      text: onOff(h.ax, locale),
      tone: h.ax === null ? 'mut' : h.ax ? 'ok' : 'warn',
    });
    if (h.ax === false) helperNote = words.needsAccess;
  }
  const needsAccess = h.installed && h.running && h.ax === false;

  // What stands in the way, first to last: the Mac not checking in, the switch, Screen Sharing, the password.
  const shellOff =
    rc.hostShell === false ? rc.hostShellReason?.trim() || interpolate(w.shellOff, { name }) : null;
  const reach: MacMay = offline ? no(interpolate(w.offline, { name })) : shellOff ? no(shellOff) : yes;
  const ownerOnly = w.ownerOnly;
  const screen: MacMay = !owner
    ? no(ownerOnly)
    : !reach.can
      ? reach
      : !s.sharing
        ? no(w.sharingOff)
        : !s.account
          ? no(w.passwordFirst)
          : s.signIn === 'failed'
            ? no(w.passwordRefused)
            : yes;
  const password: MacMay = !owner ? no(ownerOnly) : !reach.can ? reach : !s.sharing ? no(w.sharingOff) : yes;
  const unlock: MacMay = screen;
  const helperStep: MacMay = !owner
    ? no(ownerOnly)
    : !reach.can
      ? reach
      : !h.installed || !h.running
        ? no(w.helperNotRunning)
        : yes;

  return {
    lines,
    maybeLocked: s.locked !== false,
    sharing: s.sharing,
    sharingHow: s.sharing ? null : words.sharingHow,
    account,
    accountUser: s.account ?? m.consoleUser ?? m.autoLogin ?? '',
    hasAccount: !!s.account,
    helper,
    helperNote,
    needsAccess,
    screen,
    unlock,
    password,
    helperStep,
    fileVaultNote: m.filevault ? w.fileVault : null,
  };
}

/* The password form ------------------------------------------------------------------------------- */

/**
 * What is wrong with the Mac's user and password before they are sent, or null: Apple's sign-in takes at most 63 bytes
 * of each (a letter with an accent counts as two).
 */
export function macAccountProblem(user: string, password: string, locale?: string | null): string | null {
  const w = clientTree(locale, HOSTS_MAC_WORDS).account;
  if (!user.trim()) return w.user;
  if (!password) return w.password;
  const max = HOST_SCREEN_LIMITS.accountBytes;
  if (utf8ByteLength(user.trim()) > max) return interpolate(w.userTooLong, { max });
  if (utf8ByteLength(password) > max) return interpolate(w.passwordTooLong, { max });
  return null;
}

/* After a step ------------------------------------------------------------------------------------- */

/**
 * What a person reads after a screen step: `ok` with the done words and the Mac's own note when it added one (empty for
 * a step that says nothing, `status` and `look`), or the Mac's refusal in words (its own reason when it gave one). A
 * password the Mac didn't take names the user it was for. An unlock whose lock the Mac couldn't read says so: unknown
 * isn't unlocked.
 */
export function macStepText(
  body: Pick<HostScreenBody, 'op' | 'target'> & { account?: { user: string } },
  result: Pick<HostScreenResult, 'ok' | 'code' | 'message' | 'status'>,
  server: string,
  locale?: string | null,
): { ok: boolean; text: string } {
  const w = clientTree(locale, HOSTS_MAC_WORDS).step;
  const user = body.account?.user ?? w.thatUser;
  if (!result.ok) {
    if (body.op === 'account.set' && result.code === 'sign_in_failed')
      return { ok: false, text: interpolate(w.refused, { server, user }) };
    return {
      ok: false,
      text: hostScreenProblemText(result.code ?? 'failed', server, result.message, locale),
    };
  }
  const said = screenMessageText(result.message);
  const plus = (text: string) => (said ? `${text} ${said}` : text);
  switch (body.op) {
    case 'account.set':
      return {
        ok: true,
        text: plus(interpolate(w.set, { server, user })),
      };
    case 'account.check':
      return result.status?.signIn === 'failed'
        ? { ok: false, text: interpolate(w.checkFailed, { server }) }
        : { ok: true, text: plus(interpolate(w.works, { server })) };
    case 'account.clear':
      return { ok: true, text: plus(interpolate(w.cleared, { server })) };
    case 'unlock': {
      const locked = result.status?.locked;
      if (locked === true) return { ok: false, text: plus(interpolate(w.stillLocked, { server })) };
      if (locked === false) return { ok: true, text: plus(interpolate(w.unlocked, { server })) };
      return { ok: true, text: plus(interpolate(w.typed, { server })) };
    }
    case 'ui.open':
      return body.target === 'accessibility'
        ? { ok: true, text: plus(interpolate(w.accessibility, { server })) }
        : { ok: true, text: plus(interpolate(w.opened, { server })) };
    case 'status':
    case 'look':
      return { ok: true, text: '' };
    default:
      return { ok: true, text: said ?? w.done };
  }
}

/** A Mac's install words as the server wrote them (Mac words: macOS, the Mac), which the app shows as they come. */
export function isMacInstallText(text: string | null | undefined): boolean {
  return !!text && /\bmacOS\b|\bthe Mac\b/.test(text);
}
