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
import { utf8ByteLength } from '@whombat/core/text/utf8';
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

export type MacServerTab = 'summary' | 'screen' | 'storage' | 'sensors' | 'system';

/** A Mac's tabs: the Screen after the Summary, then every server's; no machines or backups of its own. */
export const MAC_SERVER_TABS: readonly MacServerTab[] = ['summary', 'screen', 'storage', 'sensors', 'system'];

export const MAC_SERVER_TAB_WORDS: Record<MacServerTab, string> = {
  summary: 'Summary',
  screen: 'Screen',
  storage: 'Storage',
  sensors: 'Sensors',
  system: 'System',
};

export function parseMacServerTab(v: unknown): MacServerTab {
  return typeof v === 'string' && (MAC_SERVER_TABS as readonly string[]).includes(v)
    ? (v as MacServerTab)
    : 'summary';
}

/** The words of a Mac's page that aren't built from its state. */
export const MAC_WORDS = {
  screenTitle: 'Screen',
  passwordTitle: 'The Mac’s password',
  helperTitle: 'Whombat Helper',
  sharingHow: 'On the Mac, open System Settings → General → Sharing and switch on Screen Sharing.',
  openScreen: 'Open the screen',
  lookAgain: 'Look again',
  look: 'Look at the screen',
  unlock: 'Unlock the screen',
  setPassword: 'Set the Mac’s password',
  check: 'Check',
  forget: 'Forget',
  openSetting: 'Open the setting on the Mac',
  passwordHint:
    'Whombat keeps it on the Mac only, to open and unlock its screen. It never shows it to anyone.',
  user: 'User on the Mac',
  password: 'Password',
  save: 'Save',
  noHelper: 'Without it Whombat can still see and use the screen, but can’t press buttons by name.',
  helperStarts: 'It starts when someone signs in at the Mac.',
  needsAccess:
    'It needs Accessibility to press buttons by name. Open the setting on the Mac, then switch on Whombat Helper in the screen.',
  forgetTitle: (server: string) => `Forget the password for ${server}’s screen?`,
  forgetBody: (server: string) => `Whombat can’t open or unlock ${server}’s screen until it’s set again.`,
  forgetConfirm: 'Forget it',
  phoneNoLive: 'The live screen opens on the web. Here you see a picture of it.',
  lookAlt: (server: string) => `${server}’s screen`,
} as const;

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

const onOff = (v: boolean | null): string => (v === null ? 'Not known' : v ? 'On' : 'Off');

export interface MacFact {
  label: string;
  value: string;
}

/**
 * A Mac's own facts for Technical details (“This Mac”): the model, the chip, System Integrity Protection, FileVault and
 * whether it signs in by itself after a restart. Its macOS is the System line above them; who is at the screen is on
 * the Screen tab.
 */
export function macFacts(m: HostMacosDetail): MacFact[] {
  const out: MacFact[] = [];
  const model = macModelLine(m);
  if (model) out.push({ label: 'Model', value: model });
  if (m.chip) out.push({ label: 'Chip', value: m.chip });
  out.push({ label: 'System Integrity Protection', value: onOff(m.sip) });
  out.push({ label: 'FileVault', value: onOff(m.filevault) });
  out.push({ label: 'Signs in by itself', value: m.autoLogin ? `Yes, as ${m.autoLogin}` : 'No' });
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
}

/**
 * The Screen part of a Mac's page from its detail: what it says and what may be done. The screen goes with the server's
 * host-shell switch on both sides, as the hosts service asks (the consoles' switch is the guests'), and needs the Mac
 * checking in; every step is an owner's, a look too.
 */
export function macScreenView(d: HostServerDetail, input: MacScreenInput): MacScreenView | null {
  const m = d.macos;
  if (!m) return null;
  const { name, owner, now } = input;
  const s = m.screen;
  const h = m.helper;
  const rc = d.server.remoteControl;
  const offline = d.server.status === 'offline' || d.server.status === 'pending';

  const lines: MacLine[] = [
    {
      key: 'sharing',
      title: 'Screen Sharing',
      text: s.sharing ? 'On' : 'Off',
      tone: s.sharing ? 'ok' : 'warn',
    },
  ];
  lines.push({
    key: 'lock',
    title: 'The screen',
    text: s.locked === null ? 'Can’t tell if it’s locked' : s.locked ? 'Locked' : 'Unlocked',
    tone: s.locked === null ? 'mut' : s.locked ? 'warn' : 'ok',
  });
  lines.push({
    key: 'user',
    title: 'At the screen',
    text: m.consoleUser ?? 'Nobody: the Mac shows its login window',
    tone: m.consoleUser ? 'ok' : 'mut',
  });

  const checked = s.signInAt ? ` · checked ${formatAgoIso(s.signInAt, now)}` : '';
  const account: MacLine = !s.account
    ? { key: 'account', title: MAC_WORDS.passwordTitle, text: 'Not set yet', tone: 'warn' }
    : s.signIn === 'failed'
      ? {
          key: 'account',
          title: MAC_WORDS.passwordTitle,
          text: `The Mac didn’t take it for ${s.account}. Set it again.`,
          tone: 'bad',
        }
      : s.signIn === 'ok'
        ? {
            key: 'account',
            title: MAC_WORDS.passwordTitle,
            text: `Signs in as ${s.account}${checked}`,
            tone: 'ok',
          }
        : {
            key: 'account',
            title: MAC_WORDS.passwordTitle,
            text: `Set for ${s.account}, not checked yet`,
            tone: 'mut',
          };

  const helper: MacLine[] = [];
  let helperNote: string | null = null;
  if (!h.installed) {
    helper.push({ key: 'helper', title: 'On the Mac', text: 'Not installed', tone: 'mut' });
    helperNote = MAC_WORDS.noHelper;
  } else if (!h.running) {
    helper.push({ key: 'helper', title: 'On the Mac', text: 'Installed, not running', tone: 'warn' });
    helperNote = MAC_WORDS.helperStarts;
  } else {
    const who = h.user ? ` for ${h.user}` : '';
    const version = h.version ? ` · version ${h.version}` : '';
    helper.push({ key: 'helper', title: 'On the Mac', text: `Running${who}${version}`, tone: 'ok' });
    helper.push({
      key: 'access',
      title: 'Accessibility',
      text: onOff(h.ax),
      tone: h.ax === null ? 'mut' : h.ax ? 'ok' : 'warn',
    });
    if (h.ax === false) helperNote = MAC_WORDS.needsAccess;
  }
  const needsAccess = h.installed && h.running && h.ax === false;

  // What stands in the way, first to last: the Mac not checking in, the switch, Screen Sharing, the password.
  const shellOff =
    rc.hostShell === false
      ? rc.hostShellReason?.trim() || `The screen goes with the shell, which is switched off for ${name}.`
      : null;
  const reach: MacMay = offline
    ? no(`${name} isn’t checking in, so its screen can’t be reached now.`)
    : shellOff
      ? no(shellOff)
      : yes;
  const ownerOnly = 'Only an owner of this Whombat can do this.';
  const screen: MacMay = !owner
    ? no(ownerOnly)
    : !reach.can
      ? reach
      : !s.sharing
        ? no('Screen Sharing is off on the Mac.')
        : !s.account
          ? no('Set the Mac’s password first.')
          : s.signIn === 'failed'
            ? no('The Mac didn’t take its password. Set it again.')
            : yes;
  const password: MacMay = !owner
    ? no(ownerOnly)
    : !reach.can
      ? reach
      : !s.sharing
        ? no('Screen Sharing is off on the Mac.')
        : yes;
  const unlock: MacMay = screen;
  const helperStep: MacMay = !owner
    ? no(ownerOnly)
    : !reach.can
      ? reach
      : !h.installed || !h.running
        ? no('Whombat Helper isn’t running on the Mac.')
        : yes;

  return {
    lines,
    maybeLocked: s.locked !== false,
    sharing: s.sharing,
    sharingHow: s.sharing ? null : MAC_WORDS.sharingHow,
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
    fileVaultNote: m.filevault
      ? 'FileVault is on, so after a restart the Mac waits for its password at its own screen.'
      : null,
  };
}

/* The password form ------------------------------------------------------------------------------- */

/**
 * What is wrong with the Mac's user and password before they are sent, or null: Apple's sign-in takes at most 63 bytes
 * of each (a letter with an accent counts as two).
 */
export function macAccountProblem(user: string, password: string): string | null {
  if (!user.trim()) return 'Type the user’s name on the Mac.';
  if (!password) return 'Type the password.';
  const max = HOST_SCREEN_LIMITS.accountBytes;
  if (utf8ByteLength(user.trim()) > max) return `The Mac takes a user name of at most ${max} letters.`;
  if (utf8ByteLength(password) > max) return `The Mac takes a password of at most ${max} letters.`;
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
): { ok: boolean; text: string } {
  if (!result.ok) {
    if (body.op === 'account.set' && result.code === 'sign_in_failed')
      return {
        ok: false,
        text: `${server} didn’t take that password for ${body.account?.user ?? 'that user'}.`,
      };
    return { ok: false, text: hostScreenProblemText(result.code ?? 'failed', server, result.message) };
  }
  const said = screenMessageText(result.message);
  const plus = (text: string) => (said ? `${text} ${said}` : text);
  switch (body.op) {
    case 'account.set':
      return {
        ok: true,
        text: plus(`Whombat signs in to ${server}’s screen as ${body.account?.user ?? 'that user'} now.`),
      };
    case 'account.check':
      return result.status?.signIn === 'failed'
        ? { ok: false, text: `${server} didn’t take the password. Set it again.` }
        : { ok: true, text: plus(`The password for ${server}’s screen works.`) };
    case 'account.clear':
      return { ok: true, text: plus(`Whombat forgot the password for ${server}’s screen.`) };
    case 'unlock': {
      const locked = result.status?.locked;
      if (locked === true)
        return { ok: false, text: plus(`${server}’s screen is still locked. Look at it to see why.`) };
      if (locked === false) return { ok: true, text: plus(`${server}’s screen is unlocked.`) };
      return {
        ok: true,
        text: plus(`Whombat typed the password on ${server}’s screen. Look at it to see if it’s unlocked.`),
      };
    }
    case 'ui.open':
      return body.target === 'accessibility'
        ? {
            ok: true,
            text: plus(`Accessibility is open on ${server}’s screen. Switch on Whombat Helper there.`),
          }
        : { ok: true, text: plus(`It’s open on ${server}’s screen.`) };
    case 'status':
    case 'look':
      return { ok: true, text: '' };
    default:
      return { ok: true, text: said ?? 'Done.' };
  }
}

/** A Mac's install words as the server wrote them (Mac words: macOS, the Mac), which the app shows as they come. */
export function isMacInstallText(text: string | null | undefined): boolean {
  return !!text && /\bmacOS\b|\bthe Mac\b/.test(text);
}
